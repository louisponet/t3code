import {
  DEFAULT_ENVIRONMENT_TOOL_PROBE_INTERVAL_SECONDS,
  DEFAULT_ENVIRONMENT_TOOL_PROBE_TIMEOUT_SECONDS,
  ENVIRONMENT_TOOL_TERMINAL_ID,
  EnvironmentToolKindMismatchError,
  EnvironmentToolNotFoundError,
  EnvironmentToolUnavailableError,
  environmentToolThreadId,
  type BrowserEnvironmentTool,
  type EnvironmentToolDefinition,
  type EnvironmentToolError,
  type EnvironmentToolId,
  type EnvironmentToolKind,
  type EnvironmentToolOpenInput,
  type EnvironmentToolOpenResult,
  type EnvironmentToolStatus,
  type EnvironmentToolStatusEvent,
  type EnvironmentToolStopInput,
  type ServerSettings as ServerSettingsValue,
  type TerminalEnvironmentTool,
  type TerminalError,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { browserNavigationTargetUrl } from "@t3tools/shared/browserNavigationTarget";
import { decodeEnvironmentTools } from "@t3tools/shared/environmentTools";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as PreviewManager from "../preview/Manager.ts";
import { previewBrowserRelease } from "../preview/PreviewBrowser.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { runEnvironmentToolProbe, type EnvironmentToolProbeOutcome } from "./probe.ts";

export class EnvironmentTools extends Context.Service<
  EnvironmentTools,
  {
    /** Ensures the tool is running and returns the session clients attach to. */
    readonly open: (
      input: EnvironmentToolOpenInput,
    ) => Effect.Effect<EnvironmentToolOpenResult, EnvironmentToolError>;
    readonly stop: (input: EnvironmentToolStopInput) => Effect.Effect<void, EnvironmentToolError>;
    /** Runs the tool's status probe now, or waits for the run already in flight. */
    readonly refreshStatus: (
      toolId: EnvironmentToolId,
    ) => Effect.Effect<void, EnvironmentToolNotFoundError>;
    readonly statuses: Effect.Effect<ReadonlyMap<EnvironmentToolId, EnvironmentToolStatus>>;
    /** A snapshot, then every change. Probes only run while one of these is open. */
    readonly streamStatus: Stream.Stream<EnvironmentToolStatusEvent>;
  }
>()("t3/environmentTools/EnvironmentTools") {}

type Definitions = ReadonlyMap<EnvironmentToolId, EnvironmentToolDefinition>;

interface ToolsState {
  readonly definitions: Definitions;
  /** The kind each tool's sessions were opened as. */
  readonly sessionKinds: ReadonlyMap<EnvironmentToolId, EnvironmentToolKind>;
}

interface ProbeSpec {
  readonly command: string;
  readonly cwd: string;
  readonly intervalMs: number;
  readonly timeoutSeconds: number;
}

interface ProbeSlot {
  readonly refreshes: Queue.Queue<Deferred.Deferred<void>>;
  readonly fiber: Fiber.Fiber<unknown, unknown>;
}

// Web and mobile report this baseline lease while they are in use, so it doubles as "someone is
// looking" and carries the host's battery, thermal and lock constraints.
const PROBE_DEMAND_SCOPE = { type: "provider-status" } as const;
const PROBE_CONCURRENCY = 4;
const PENDING: EnvironmentToolStatus = { state: "pending" };

const definitionsOf = (settings: ServerSettingsValue): Definitions =>
  new Map(decodeEnvironmentTools(settings.tools).tools.map((tool) => [tool.id, tool.definition]));

// A typo in one entry, or anywhere in settings.json, is an edit in progress rather than a
// removal: the tool keeps its sessions until its key is gone or it decodes as another kind.
function toolsStateOf(
  settings: ServerSettingsValue,
  fileTrusted: boolean,
  previous: ToolsState["sessionKinds"],
): ToolsState {
  const definitions = definitionsOf(settings);
  const sessionKinds = new Map(
    Array.from(definitions, ([toolId, definition]) => [toolId, definition.kind]),
  );
  for (const [toolId, kind] of previous) {
    if (!sessionKinds.has(toolId) && (!fileTrusted || Object.hasOwn(settings.tools, toolId))) {
      sessionKinds.set(toolId, kind);
    }
  }
  return { definitions, sessionKinds };
}

function terminalOpenFailure(error: TerminalError): string {
  switch (error._tag) {
    case "TerminalCwdNotFoundError":
      return `The working directory ${error.cwd} does not exist`;
    case "TerminalCwdNotDirectoryError":
      return `The working directory ${error.cwd} is not a directory`;
    case "TerminalCwdStatError":
      return `The working directory ${error.cwd} can't be read`;
    default:
      return "The terminal could not be opened";
  }
}

/** Returns `previous` itself when nothing a client renders changed, so nothing is published. */
function probedStatus(
  previous: EnvironmentToolStatus | undefined,
  outcome: EnvironmentToolProbeOutcome,
  since: string,
): EnvironmentToolStatus {
  if (outcome._tag === "badge") {
    return previous?.state === "ready" && Equal.equals(previous.badge, outcome.badge)
      ? previous
      : { state: "ready", badge: outcome.badge, since };
  }
  if (previous?.state === "unavailable" && previous.reason === outcome.reason) return previous;
  const lastBadge =
    previous?.state === "ready"
      ? previous.badge
      : previous?.state === "unavailable"
        ? previous.lastBadge
        : undefined;
  return {
    state: "unavailable",
    reason: outcome.reason,
    ...(lastBadge === undefined ? {} : { lastBadge }),
    since,
  };
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const previewManager = yield* PreviewManager.PreviewManager;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const canHostBrowser =
    previewBrowserRelease(yield* HostProcess.Platform, yield* HostProcess.Architecture) !== null;

  const locks = yield* KeyedLock.make<EnvironmentToolId>();
  const probePermits = yield* Semaphore.make(PROBE_CONCURRENCY);
  const statusesRef = yield* Ref.make<ReadonlyMap<EnvironmentToolId, EnvironmentToolStatus>>(
    new Map(),
  );
  const statusChanges = yield* Effect.acquireRelease(
    PubSub.unbounded<{
      readonly toolId: EnvironmentToolId;
      readonly status: EnvironmentToolStatus | null;
    }>(),
    PubSub.shutdown,
  );
  const watchers = yield* SubscriptionRef.make(0);
  const demand = yield* SubscriptionRef.make(false);
  const probeFibers = yield* FiberMap.make<EnvironmentToolId>();
  const probeSlots = yield* Ref.make<ReadonlyMap<EnvironmentToolId, ProbeSlot>>(new Map());
  // A tool's page shows the tab this service opened, never a popup the tool's site opened beside it.
  const browserTabs = yield* Ref.make<ReadonlyMap<EnvironmentToolId, string>>(new Map());

  // Relative paths resolve against the home directory, where a fresh T3 terminal starts.
  const resolveCwd = (cwd: string | undefined) =>
    path.resolve(home, expandHomePath(cwd ?? "~", home));

  const currentSettings = settingsService.getSettings.pipe(Effect.orDie);
  const currentDefinitions = Effect.map(currentSettings, definitionsOf);
  // A failed read counts as untrusted, which keeps sessions; the next snapshot corrects it.
  const fileTrusted = settingsService.settingsFileTrusted.pipe(Effect.orElseSucceed(() => false));

  const findDefinition = Effect.fn("EnvironmentTools.findDefinition")(function* (
    toolId: EnvironmentToolId,
    kind: EnvironmentToolKind,
  ) {
    const definition = (yield* currentDefinitions).get(toolId);
    if (definition === undefined) return yield* new EnvironmentToolNotFoundError({ toolId });
    if (definition.kind !== kind) {
      return yield* new EnvironmentToolKindMismatchError({
        toolId,
        expected: kind,
        actual: definition.kind,
      });
    }
    return definition;
  });

  const openTerminal = Effect.fn("EnvironmentTools.openTerminal")(function* (
    input: EnvironmentToolOpenInput,
    definition: TerminalEnvironmentTool,
  ) {
    const threadId = environmentToolThreadId(input.toolId);
    const session = yield* terminalManager
      .openTool({
        threadId,
        terminalId: ENVIRONMENT_TOOL_TERMINAL_ID,
        cwd: resolveCwd(definition.cwd),
        command: definition.command,
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows }),
        ...(input.restart === undefined ? {} : { restart: input.restart }),
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new EnvironmentToolUnavailableError({
              toolId: input.toolId,
              reason: terminalOpenFailure(error),
            }),
        ),
      );
    if (session.status === "error") {
      return yield* new EnvironmentToolUnavailableError({
        toolId: input.toolId,
        reason: "The command could not be started",
      });
    }
    return { kind: "terminal", threadId, terminalId: ENVIRONMENT_TOOL_TERMINAL_ID } as const;
  });

  const openBrowser = Effect.fn("EnvironmentTools.openBrowser")(function* (
    input: EnvironmentToolOpenInput,
    definition: BrowserEnvironmentTool,
  ) {
    if (!canHostBrowser) {
      return yield* new EnvironmentToolUnavailableError({
        toolId: input.toolId,
        reason: "This environment can't host a browser",
      });
    }
    const threadId = environmentToolThreadId(input.toolId);
    if (input.restart === true) {
      yield* previewManager.close({ threadId }).pipe(Effect.orDie);
    } else {
      const tabId = (yield* Ref.get(browserTabs)).get(input.toolId);
      const { sessions } = yield* previewManager.list({ threadId });
      if (tabId !== undefined && sessions.some((session) => session.tabId === tabId)) {
        return { kind: "browser", threadId, tabId } as const;
      }
    }
    // Always the server runtime: an environment port is only reachable from the host.
    const opened = yield* previewManager
      .open({ threadId, url: browserNavigationTargetUrl(definition.target), runtime: "server" })
      .pipe(
        Effect.mapError(
          () =>
            new EnvironmentToolUnavailableError({
              toolId: input.toolId,
              reason: "The tool's address can't be opened in a browser",
            }),
        ),
      );
    yield* Ref.update(browserTabs, (tabs) => new Map(tabs).set(input.toolId, opened.tabId));
    return { kind: "browser", threadId, tabId: opened.tabId } as const;
  });

  const open: EnvironmentTools["Service"]["open"] = (input) =>
    locks.withLock(
      input.toolId,
      Effect.gen(function* () {
        const definition = yield* findDefinition(input.toolId, input.kind);
        return definition.kind === "terminal"
          ? yield* openTerminal(input, definition)
          : yield* openBrowser(input, definition);
      }),
    );

  const closeSessions = (toolId: EnvironmentToolId, kind: EnvironmentToolKind) => {
    const threadId = environmentToolThreadId(toolId);
    return kind === "terminal"
      ? terminalManager
          .close({ threadId, terminalId: ENVIRONMENT_TOOL_TERMINAL_ID, deleteHistory: true })
          .pipe(Effect.orDie)
      : previewManager.close({ threadId }).pipe(Effect.orDie);
  };

  const stop: EnvironmentTools["Service"]["stop"] = (input) =>
    locks.withLock(
      input.toolId,
      findDefinition(input.toolId, input.kind).pipe(
        Effect.flatMap((definition) => closeSessions(input.toolId, definition.kind)),
      ),
    );

  // Re-reads settings under the lock: a later edit may have brought the kind back, and the
  // session an open started since then must survive this older change.
  const closeStaleSessions = (toolId: EnvironmentToolId, kind: EnvironmentToolKind) =>
    locks
      .withLock(
        toolId,
        Effect.gen(function* () {
          const settings = yield* currentSettings;
          const current = toolsStateOf(settings, yield* fileTrusted, new Map([[toolId, kind]]));
          if (current.sessionKinds.get(toolId) === kind) return;
          yield* closeSessions(toolId, kind);
        }),
      )
      .pipe(Effect.ignoreCause({ log: true }));

  const updateStatus = (
    toolId: EnvironmentToolId,
    update: (previous: EnvironmentToolStatus | undefined) => EnvironmentToolStatus | undefined,
  ) =>
    Effect.uninterruptible(
      Ref.modify(statusesRef, (statuses) => {
        const previous = statuses.get(toolId);
        const next = update(previous);
        if (next === previous) return [undefined, statuses] as const;
        const updated = new Map(statuses);
        if (next === undefined) updated.delete(toolId);
        else updated.set(toolId, next);
        return [{ toolId, status: next ?? null }, updated] as const;
      }).pipe(
        Effect.flatMap((change) =>
          change === undefined ? Effect.void : PubSub.publish(statusChanges, change),
        ),
      ),
    );

  const runProbe = Effect.fn("EnvironmentTools.runProbe")(function* (
    toolId: EnvironmentToolId,
    spec: ProbeSpec,
  ) {
    const outcome = yield* runEnvironmentToolProbe(spec).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      probePermits.withPermits(1),
    );
    const since = DateTime.formatIso(yield* DateTime.now);
    yield* updateStatus(toolId, (previous) => probedStatus(previous, outcome, since));
  });

  const demandChangedFrom = (observed: boolean) =>
    SubscriptionRef.changes(demand).pipe(
      Stream.filter((current) => current !== observed),
      Stream.runHead,
    );

  // Interrupting this fiber is what drops a stale result: an edited probe gets a new fiber.
  const probeLoop = (
    toolId: EnvironmentToolId,
    spec: ProbeSpec,
    refreshes: Queue.Queue<Deferred.Deferred<void>>,
  ) =>
    Effect.gen(function* () {
      let lastRunAt: number | undefined;
      while (true) {
        const demanded = yield* SubscriptionRef.get(demand);
        const now = yield* Clock.currentTimeMillis;
        const wait = lastRunAt === undefined ? 0 : lastRunAt + spec.intervalMs - now;
        let joined: ReadonlyArray<Deferred.Deferred<void>> = [];
        if (!demanded || wait > 0) {
          const woken = yield* Effect.raceAll([
            Queue.take(refreshes).pipe(Effect.map((refresh) => [refresh])),
            demandChangedFrom(demanded).pipe(Effect.as([])),
            ...(demanded ? [Effect.sleep(wait).pipe(Effect.as([]))] : []),
          ]);
          if (woken.length === 0) continue;
          joined = woken;
        }
        lastRunAt = yield* Clock.currentTimeMillis;
        yield* runProbe(toolId, spec);
        // Refreshes that arrived while the probe ran joined that run.
        const pending = [...joined, ...(yield* Queue.clear(refreshes))];
        yield* Effect.forEach(pending, (refresh) => Deferred.succeed(refresh, undefined), {
          discard: true,
        });
      }
    });

  const probeSpecOf = (definition: EnvironmentToolDefinition | undefined): ProbeSpec | undefined =>
    definition?.status === undefined
      ? undefined
      : {
          command: definition.status.command,
          cwd: resolveCwd(definition.kind === "terminal" ? definition.cwd : undefined),
          intervalMs:
            (definition.status.intervalSeconds ?? DEFAULT_ENVIRONMENT_TOOL_PROBE_INTERVAL_SECONDS) *
            1000,
          timeoutSeconds:
            definition.status.timeoutSeconds ?? DEFAULT_ENVIRONMENT_TOOL_PROBE_TIMEOUT_SECONDS,
        };

  const reconcile = Effect.fn("EnvironmentTools.reconcile")(function* (
    previous: ToolsState,
    next: ToolsState,
  ) {
    for (const [toolId, kind] of previous.sessionKinds) {
      if (next.sessionKinds.get(toolId) !== kind) yield* closeStaleSessions(toolId, kind);
    }
    for (const toolId of new Set([...previous.definitions.keys(), ...next.definitions.keys()])) {
      const before = probeSpecOf(previous.definitions.get(toolId));
      const after = probeSpecOf(next.definitions.get(toolId));
      if (Equal.equals(before, after)) continue;
      if (before !== undefined) {
        yield* FiberMap.remove(probeFibers, toolId);
        yield* Ref.update(probeSlots, (slots) => {
          const updated = new Map(slots);
          updated.delete(toolId);
          return updated;
        });
      }
      if (after === undefined) {
        yield* updateStatus(toolId, () => undefined);
        continue;
      }
      yield* updateStatus(toolId, (status) => status ?? PENDING);
      const refreshes = yield* Queue.unbounded<Deferred.Deferred<void>>();
      const fiber = yield* FiberMap.run(probeFibers, toolId, probeLoop(toolId, after, refreshes));
      yield* Ref.update(probeSlots, (slots) => new Map(slots).set(toolId, { refreshes, fiber }));
    }
  });

  const refreshDemand = Effect.gen(function* () {
    const next =
      (yield* SubscriptionRef.get(watchers)) > 0 &&
      (yield* backgroundPolicy.shouldRunScopeWork(PROBE_DEMAND_SCOPE));
    if (next !== (yield* SubscriptionRef.get(demand))) yield* SubscriptionRef.set(demand, next);
  });
  yield* Stream.merge(SubscriptionRef.changes(watchers), backgroundPolicy.streamChanges).pipe(
    Stream.runForEach(() => refreshDemand),
    Effect.forkScoped,
  );

  // Subscribed before the first read so no edit falls between them. The first status subscriber
  // then already sees every probed tool as pending.
  const settingsChanges = yield* settingsService.subscribeChanges;
  const empty: ToolsState = { definitions: new Map(), sessionKinds: new Map() };
  const initial = yield* Effect.all([
    settingsService.getSettings,
    settingsService.settingsFileTrusted,
  ]).pipe(
    Effect.map(([settings, trusted]) => toolsStateOf(settings, trusted, empty.sessionKinds)),
    Effect.orElseSucceed(() => empty),
  );
  yield* reconcile(empty, initial);
  yield* settingsChanges.pipe(
    Stream.runFoldEffect(
      () => initial,
      (previous, settings) =>
        Effect.gen(function* () {
          // The flag can be newer than this snapshot; every close re-checks both under the lock.
          const next = toolsStateOf(settings, yield* fileTrusted, previous.sessionKinds);
          yield* reconcile(previous, next);
          return next;
        }),
    ),
    Effect.forkScoped,
  );

  const refreshStatus: EnvironmentTools["Service"]["refreshStatus"] = (toolId) =>
    Effect.gen(function* () {
      if (!(yield* currentDefinitions).has(toolId)) {
        return yield* new EnvironmentToolNotFoundError({ toolId });
      }
      const slot = (yield* Ref.get(probeSlots)).get(toolId);
      if (slot === undefined) return;
      const refresh = yield* Deferred.make<void>();
      yield* Queue.offer(slot.refreshes, refresh);
      // An edit replaces the probe's fiber; its end releases waiters it never served.
      yield* Effect.raceFirst(Deferred.await(refresh), Fiber.await(slot.fiber));
    });

  const streamStatus: EnvironmentTools["Service"]["streamStatus"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(statusChanges);
      yield* Effect.acquireRelease(
        SubscriptionRef.update(watchers, (count) => count + 1),
        () => SubscriptionRef.update(watchers, (count) => count - 1),
      );
      const snapshot: EnvironmentToolStatusEvent = {
        type: "snapshot",
        statuses: Object.fromEntries(yield* Ref.get(statusesRef)),
      };
      return Stream.concat(
        Stream.succeed(snapshot),
        Stream.fromSubscription(subscription).pipe(
          Stream.map((change): EnvironmentToolStatusEvent => ({ type: "status", ...change })),
        ),
      );
    }),
  );

  return EnvironmentTools.of({
    open,
    stop,
    refreshStatus,
    statuses: Ref.get(statusesRef),
    streamStatus,
  });
});

export const layer = Layer.effect(EnvironmentTools, make);
