import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentToolId,
  environmentToolThreadId,
  isUnknownUnionMember,
  type EnvironmentToolOpenResult,
  type EnvironmentToolStatusEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { constVoid } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as EnvironmentTools from "./EnvironmentTools.ts";
import { validateToolAppToken } from "./ToolAppAccess.ts";

interface ProbeCall {
  readonly input: ProcessRunner.ProcessRunInput;
  readonly respond: Deferred.Deferred<ProcessRunner.ProcessRunOutput>;
}

const finished = (
  overrides: Partial<ProcessRunner.ProcessRunOutput>,
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});
const badgeOutput = (headline: string) =>
  finished({ stdout: JSON.stringify({ tone: "warn", headline }) });

// Exits when killed, so closing a session or the manager never waits out a kill grace period.
const fakePty = (pid: number): PtyAdapter.PtyProcess => {
  const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  return {
    pid,
    write: constVoid,
    resize: constVoid,
    kill: () => {
      for (const listener of exitListeners) listener({ exitCode: 0, signal: 15 });
    },
    onData: () => constVoid,
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
};

const makeHarness = (
  initialTools: Record<string, unknown>,
  options: { readonly platform?: NodeJS.Platform } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-environment-tools-" });
    const spawns: Array<PtyAdapter.PtySpawnInput> = [];
    const probeCalls = yield* Queue.unbounded<ProbeCall>();
    const processRunner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          const respond = yield* Deferred.make<ProcessRunner.ProcessRunOutput>();
          yield* Queue.offer(probeCalls, { input, respond });
          return yield* Deferred.await(respond);
        }),
    });
    const terminalManager = yield* TerminalManager.makeWithOptions({
      logsDir: path.join(home, ".logs"),
      shellResolver: () => "/bin/bash",
      processTable: Effect.succeed([]),
      ptyAdapter: {
        spawn: (input) =>
          Effect.sync(() => {
            spawns.push(input);
            return fakePty(9000 + spawns.length);
          }),
      },
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
    const previewManager = yield* PreviewManager.make;
    const settings = yield* Ref.make<ServerSettings>({
      ...DEFAULT_SERVER_SETTINGS,
      tools: initialTools,
    });
    const settingsFileTrusted = yield* Ref.make(true);
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const secretLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(42)),
    });
    const context = yield* Layer.build(
      EnvironmentTools.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(TerminalManager.TerminalManager, terminalManager),
            Layer.succeed(PreviewManager.PreviewManager, previewManager),
            Layer.succeed(ProcessRunner.ProcessRunner, processRunner),
            secretLayer,
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Ref.get(settings),
              settingsFileTrusted: Ref.get(settingsFileTrusted),
              subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
                Effect.map(Stream.fromSubscription),
              ),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(true),
              streamChanges: Stream.never,
            }),
            Layer.succeed(HostProcess.HomeDirectory, home),
            ...(options.platform === undefined
              ? []
              : [Layer.succeed(HostProcess.Platform, options.platform)]),
          ),
        ),
      ),
    );
    return {
      environmentTools: Context.get(context, EnvironmentTools.EnvironmentTools),
      home,
      spawns,
      probeCalls,
      terminalManager,
      previewManager,
      validateToken: (token: string) =>
        validateToolAppToken(token).pipe(Effect.provide(secretLayer)),
      setTools: (tools: Record<string, unknown>) =>
        Ref.set(settingsFileTrusted, true).pipe(
          Effect.andThen(Ref.updateAndGet(settings, (current) => ({ ...current, tools }))),
          Effect.flatMap((current) => PubSub.publish(settingsChanges, current)),
        ),
      // What ServerSettingsService serves while settings.json fails to decode.
      breakSettingsFile: Ref.set(settingsFileTrusted, false).pipe(
        Effect.andThen(Ref.setAndGet(settings, DEFAULT_SERVER_SETTINGS)),
        Effect.flatMap((current) => PubSub.publish(settingsChanges, current)),
      ),
    };
  });

const LAZYGIT_ID = EnvironmentToolId.make("lazygit");
const DASHBOARD_ID = EnvironmentToolId.make("dash");
const LAZYGIT = { kind: "terminal", name: "lazygit", command: "lazygit" };
const DASHBOARD = {
  kind: "browser",
  name: "Grafana",
  target: { kind: "environment-port", port: 3000, path: "grafana" },
};
const PUBLIC_DASHBOARD = {
  kind: "browser",
  name: "Grafana",
  target: { kind: "url", url: "https://grafana.example.com/d/home" },
};
const openLazygit = { toolId: LAZYGIT_ID, kind: "terminal" } as const;
const openDashboard = { toolId: DASHBOARD_ID, kind: "browser" } as const;
const tabIdOf = (result: EnvironmentToolOpenResult) =>
  "tabId" in result ? result.tabId : assert.fail("expected a browser tab");
const GH_ID = EnvironmentToolId.make("gh");
const GH = {
  kind: "terminal",
  name: "PRs",
  command: "gh dash",
  status: { command: "gh-badge", intervalSeconds: 60 },
};

const watchStatus = (environmentTools: EnvironmentTools.EnvironmentTools["Service"]) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<EnvironmentToolStatusEvent>();
    yield* environmentTools.streamStatus.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    return events;
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("EnvironmentTools", (it) => {
  describe("sessions", () => {
    it.effect(
      "opens web tools without a host session and binds access to their configuration",
      () =>
        Effect.gen(function* () {
          const web = { ...DASHBOARD, kind: "web" };
          const { environmentTools, spawns, previewManager, validateToken, setTools } =
            yield* makeHarness({ dash: web });
          const opened = yield* environmentTools.open({ toolId: DASHBOARD_ID, kind: "web" });
          if (isUnknownUnionMember(opened) || opened.kind !== "web")
            return assert.fail("expected a web tool");
          const token = opened.relativeUrl.split("/")[3]!;
          const claims = yield* validateToken(token);
          if (claims === null) return assert.fail("expected valid access");
          expect(yield* environmentTools.webTargetUrl(claims.toolId, claims.configHash)).toBe(
            "http://localhost:3000/grafana",
          );
          expect(spawns).toEqual([]);
          expect(
            (yield* previewManager.list({ threadId: environmentToolThreadId(DASHBOARD_ID) }))
              .sessions,
          ).toEqual([]);
          yield* environmentTools.stop({ toolId: DASHBOARD_ID, kind: "web" });
          yield* setTools({ dash: { ...web, name: "Renamed", status: { command: "true" } } });
          expect(yield* environmentTools.webTargetUrl(claims.toolId, claims.configHash)).toBe(
            "http://localhost:3000/grafana",
          );
          yield* setTools({ dash: { ...web, target: { kind: "environment-port", port: 4000 } } });
          expect(yield* environmentTools.webTargetUrl(claims.toolId, claims.configHash)).toBeNull();
          yield* setTools({});
          expect(yield* environmentTools.webTargetUrl(claims.toolId, claims.configHash)).toBeNull();
        }).pipe(Effect.scoped),
    );

    it.effect("preserves a web target's query and fragment, and rejects expired access", () =>
      Effect.gen(function* () {
        const { environmentTools, validateToken } = yield* makeHarness({
          dash: {
            kind: "web",
            name: "Dashboard",
            target: { kind: "url", url: "http://localhost:3000/index.html?theme=dark#chart" },
          },
        });
        const opened = yield* environmentTools.open({ toolId: DASHBOARD_ID, kind: "web" });
        if (isUnknownUnionMember(opened) || opened.kind !== "web")
          return assert.fail("expected a web tool");
        expect(opened.relativeUrl).toMatch(/\/\?theme=dark#chart$/);
        const token = opened.relativeUrl.split("/")[3]!;
        expect(yield* validateToken(`${token}.extra`)).toBeNull();
        expect(yield* validateToken(`${token.slice(0, -1)}x`)).toBeNull();
        yield* TestClock.adjust("12 hours");
        expect(yield* validateToken(token)).toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("concurrent opens share one PTY and one server tab on the host's localhost", () =>
      Effect.gen(function* () {
        const { environmentTools, spawns, previewManager } = yield* makeHarness({
          lazygit: LAZYGIT,
          dash: DASHBOARD,
        });
        const [terminal, sameTerminal, tab, sameTab] = yield* Effect.all(
          [
            environmentTools.open(openLazygit),
            environmentTools.open(openLazygit),
            environmentTools.open(openDashboard),
            environmentTools.open(openDashboard),
          ],
          { concurrency: "unbounded" },
        );
        expect(terminal).toEqual({
          kind: "terminal",
          threadId: "tool:lazygit",
          terminalId: "main",
        });
        expect(sameTerminal).toEqual(terminal);
        expect(spawns).toHaveLength(1);
        expect(sameTab).toEqual(tab);
        expect(yield* environmentTools.open(openDashboard)).toEqual(tab);
        const { sessions } = yield* previewManager.list({
          threadId: environmentToolThreadId(DASHBOARD_ID),
        });
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          runtime: "server",
          navStatus: { url: "http://localhost:3000/grafana" },
        });
      }).pipe(Effect.scoped),
    );

    it.effect("rejects a kind that no longer matches the stored definition", () =>
      Effect.gen(function* () {
        const { environmentTools, spawns } = yield* makeHarness({ lazygit: LAZYGIT });
        expect(
          yield* environmentTools.open({ toolId: LAZYGIT_ID, kind: "browser" }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "EnvironmentToolKindMismatchError",
          expected: "browser",
          actual: "terminal",
        });
        expect(yield* environmentTools.open(openDashboard).pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentToolNotFoundError",
          toolId: "dash",
        });
        expect(spawns).toHaveLength(0);
      }).pipe(Effect.scoped),
    );

    it.effect("starts terminal tools in the host home, or below it for ~/ paths", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { environmentTools, spawns, home } = yield* makeHarness({
          top: { kind: "terminal", name: "htop", command: "htop" },
          repo: { kind: "terminal", name: "lazygit", command: "lazygit", cwd: "~/repo" },
          gone: { kind: "terminal", name: "gone", command: "true", cwd: "~/gone" },
        });
        yield* fileSystem.makeDirectory(path.join(home, "repo"));
        yield* environmentTools.open({ toolId: EnvironmentToolId.make("top"), kind: "terminal" });
        yield* environmentTools.open({ toolId: EnvironmentToolId.make("repo"), kind: "terminal" });
        expect(spawns.map((spawn) => spawn.cwd)).toEqual([home, path.join(home, "repo")]);
        expect(
          yield* environmentTools
            .open({ toolId: EnvironmentToolId.make("gone"), kind: "terminal" })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "EnvironmentToolUnavailableError",
          reason: `The working directory ${path.join(home, "gone")} does not exist`,
        });
      }).pipe(Effect.scoped),
    );

    it.effect("stop closes the session, so the next open launches it again", () =>
      Effect.gen(function* () {
        const { environmentTools, spawns, previewManager } = yield* makeHarness({
          lazygit: LAZYGIT,
          dash: DASHBOARD,
        });
        yield* environmentTools.open(openLazygit);
        const tab = yield* environmentTools.open(openDashboard);
        yield* environmentTools.stop(openLazygit);
        yield* environmentTools.stop(openDashboard);
        yield* environmentTools.open(openLazygit);
        expect(spawns).toHaveLength(2);
        const { sessions } = yield* previewManager.list({
          threadId: environmentToolThreadId(DASHBOARD_ID),
        });
        expect(sessions).toEqual([]);
        expect(yield* environmentTools.open(openDashboard)).not.toEqual(tab);
      }).pipe(Effect.scoped),
    );

    it.effect("closes the sessions of a removed tool and of a tool whose kind changed", () =>
      Effect.gen(function* () {
        const { environmentTools, terminalManager, previewManager, setTools } = yield* makeHarness({
          lazygit: LAZYGIT,
          dash: DASHBOARD,
        });
        yield* environmentTools.open(openLazygit);
        yield* environmentTools.open(openDashboard);
        const terminalClosed = yield* Deferred.make<string>();
        const unsubscribe = yield* terminalManager.subscribe((event) =>
          event.type === "closed"
            ? Deferred.succeed(terminalClosed, event.threadId).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const previewEvents = yield* previewManager.subscribeEvents;

        yield* setTools({ dash: { kind: "terminal", name: "Grafana", command: "grafana-tui" } });

        expect(yield* Deferred.await(terminalClosed)).toBe("tool:lazygit");
        const tabClosed = yield* Stream.fromSubscription(previewEvents).pipe(
          Stream.filter((event) => event.type === "closed"),
          Stream.runHead,
        );
        expect(tabClosed).toMatchObject({ value: { threadId: "tool:dash" } });
      }).pipe(Effect.scoped),
    );

    it.effect("keeps sessions while an entry or settings.json fails to decode", () =>
      Effect.gen(function* () {
        const { environmentTools, spawns, previewManager, setTools, breakSettingsFile } =
          yield* makeHarness({ lazygit: LAZYGIT, dash: DASHBOARD });
        yield* environmentTools.open(openLazygit);
        yield* environmentTools.open(openDashboard);
        // gh's status is published after a snapshot's sessions are reconciled, so it marks each
        // snapshot as handled.
        const events = yield* watchStatus(environmentTools);
        yield* Queue.take(events);

        yield* setTools({
          lazygit: { ...LAZYGIT, cwd: 5 },
          dash: { ...DASHBOARD, target: { kind: "environment-port", port: "3000" } },
          gh: GH,
        });
        expect(yield* Queue.take(events)).toMatchObject({
          toolId: "gh",
          status: { state: "pending" },
        });
        yield* breakSettingsFile;
        expect(yield* Queue.take(events)).toMatchObject({ toolId: "gh", status: null });
        yield* setTools({ lazygit: LAZYGIT, gh: GH });
        expect(yield* Queue.take(events)).toMatchObject({
          toolId: "gh",
          status: { state: "pending" },
        });

        yield* environmentTools.open(openLazygit);
        expect(spawns).toHaveLength(1);
        const { sessions } = yield* previewManager.list({
          threadId: environmentToolThreadId(DASHBOARD_ID),
        });
        expect(sessions).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("reopens the tab it opened, not a popup the site opened beside it", () =>
      Effect.gen(function* () {
        const { environmentTools, previewManager } = yield* makeHarness({ dash: DASHBOARD });
        const threadId = environmentToolThreadId(DASHBOARD_ID);
        const tab = tabIdOf(yield* environmentTools.open(openDashboard));
        const popup = yield* previewManager.open({
          threadId,
          url: "http://localhost:3000/grafana/explore",
          runtime: "server",
        });
        yield* TestClock.adjust("1 second");
        yield* previewManager.reportStatus({
          threadId,
          tabId: tab,
          navStatus: { _tag: "Success", url: "http://localhost:3000/grafana/d/1", title: "Home" },
          canGoBack: true,
          canGoForward: false,
          serverControlled: true,
        });
        expect((yield* previewManager.list({ threadId })).sessions[0]?.tabId).toBe(popup.tabId);
        expect(tabIdOf(yield* environmentTools.open(openDashboard))).toBe(tab);

        yield* previewManager.close({ threadId, tabId: tab });
        expect(tabIdOf(yield* environmentTools.open(openDashboard))).not.toBe(popup.tabId);
        const restarted = yield* environmentTools.open({ ...openDashboard, restart: true });
        expect(yield* environmentTools.open(openDashboard)).toEqual(restarted);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps a desktop tab beside the host's tab, and restarts only its own", () =>
      Effect.gen(function* () {
        const { environmentTools, previewManager } = yield* makeHarness({ dash: PUBLIC_DASHBOARD });
        const threadId = environmentToolThreadId(DASHBOARD_ID);
        const openOnDesktop = { ...openDashboard, runtime: "desktop" } as const;
        const hostTab = tabIdOf(yield* environmentTools.open(openDashboard));
        const desktopTab = tabIdOf(yield* environmentTools.open(openOnDesktop));
        expect(desktopTab).not.toBe(hostTab);
        expect(tabIdOf(yield* environmentTools.open(openOnDesktop))).toBe(desktopTab);
        const runtimes = (yield* previewManager.list({ threadId })).sessions.map((session) => [
          session.tabId,
          session.runtime,
        ]);
        expect(runtimes).toEqual(
          expect.arrayContaining([
            [hostTab, "server"],
            [desktopTab, "desktop"],
          ]),
        );

        const restarted = tabIdOf(
          yield* environmentTools.open({ ...openOnDesktop, restart: true }),
        );
        expect(restarted).not.toBe(desktopTab);
        expect(tabIdOf(yield* environmentTools.open(openDashboard))).toBe(hostTab);
      }).pipe(Effect.scoped),
    );

    it.effect("closes desktop tabs once the target becomes host-only", () =>
      Effect.gen(function* () {
        const { environmentTools, previewManager, setTools } = yield* makeHarness({
          dash: PUBLIC_DASHBOARD,
        });
        const threadId = environmentToolThreadId(DASHBOARD_ID);
        yield* environmentTools.open({ ...openDashboard, runtime: "desktop" });
        yield* setTools({ dash: DASHBOARD });
        yield* environmentTools.open({ ...openDashboard, runtime: "desktop" });
        const { sessions } = yield* previewManager.list({ threadId });
        expect(sessions.map((session) => session.runtime)).toEqual(["server"]);
      }).pipe(Effect.scoped),
    );

    it.effect("opens desktop tabs where the host can't run a browser, and cleans them up", () =>
      Effect.gen(function* () {
        const { environmentTools, previewManager, setTools } = yield* makeHarness(
          { dash: PUBLIC_DASHBOARD },
          { platform: "freebsd" },
        );
        const threadId = environmentToolThreadId(DASHBOARD_ID);
        yield* environmentTools.open({ ...openDashboard, runtime: "desktop" });
        yield* setTools({ dash: DASHBOARD });
        expect(
          yield* environmentTools.open({ ...openDashboard, runtime: "desktop" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "EnvironmentToolUnavailableError" });
        expect((yield* previewManager.list({ threadId })).sessions).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("opens a host-only target in the host's browser whatever the client asks", () =>
      Effect.gen(function* () {
        const { environmentTools, previewManager } = yield* makeHarness({ dash: DASHBOARD });
        const threadId = environmentToolThreadId(DASHBOARD_ID);
        yield* environmentTools.open({ ...openDashboard, runtime: "desktop" });
        const { sessions } = yield* previewManager.list({ threadId });
        expect(sessions.map((session) => session.runtime)).toEqual(["server"]);
      }).pipe(Effect.scoped),
    );
  });

  describe("status", () => {
    const answerNextProbe = (
      probeCalls: Queue.Queue<ProbeCall>,
      output: ProcessRunner.ProcessRunOutput,
    ) =>
      Queue.take(probeCalls).pipe(Effect.flatMap((call) => Deferred.succeed(call.respond, output)));

    it.effect("probes only while someone watches, at once when they start", () =>
      Effect.gen(function* () {
        const { environmentTools, probeCalls, home } = yield* makeHarness({ gh: GH });
        yield* TestClock.adjust("5 minutes");
        expect(yield* Queue.size(probeCalls)).toBe(0);

        const events = yield* watchStatus(environmentTools);
        expect(yield* Queue.take(events)).toEqual({
          type: "snapshot",
          statuses: { gh: { state: "pending" } },
        });
        const call = yield* Queue.take(probeCalls);
        expect(call.input).toMatchObject({
          cwd: home,
          maxOutputBytes: 64 * 1024,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        });
        expect(call.input.args.at(-1)).toBe("gh-badge");
        yield* Deferred.succeed(call.respond, badgeOutput("3 PRs waiting"));
        expect(yield* Queue.take(events)).toMatchObject({
          type: "status",
          toolId: "gh",
          status: { state: "ready", badge: { tone: "warn", headline: "3 PRs waiting" } },
        });
      }).pipe(Effect.scoped),
    );

    it.effect("publishes a result only when it changes", () =>
      Effect.gen(function* () {
        const { environmentTools, probeCalls } = yield* makeHarness({ gh: GH });
        const events = yield* watchStatus(environmentTools);
        yield* Queue.take(events);
        yield* answerNextProbe(probeCalls, badgeOutput("3 PRs waiting"));
        yield* Queue.take(events);

        yield* TestClock.adjust("1 minute");
        yield* answerNextProbe(probeCalls, badgeOutput("3 PRs waiting"));
        yield* TestClock.adjust("1 minute");
        yield* answerNextProbe(probeCalls, badgeOutput("2 PRs waiting"));
        expect(yield* Queue.take(events)).toMatchObject({
          status: { state: "ready", badge: { headline: "2 PRs waiting" } },
        });
      }).pipe(Effect.scoped),
    );

    it.effect("keeps the last badge while the probe is unavailable", () =>
      Effect.gen(function* () {
        const { environmentTools, probeCalls } = yield* makeHarness({ gh: GH });
        const events = yield* watchStatus(environmentTools);
        yield* Queue.take(events);
        yield* answerNextProbe(probeCalls, badgeOutput("3 PRs waiting"));
        yield* Queue.take(events);

        const failing = yield* environmentTools.refreshStatus(GH_ID).pipe(Effect.forkChild);
        yield* answerNextProbe(
          probeCalls,
          finished({ code: ChildProcessSpawner.ExitCode(1), stderr: "fetching\nrate limited\n" }),
        );
        yield* Fiber.join(failing);
        expect(yield* Queue.take(events)).toMatchObject({
          status: {
            state: "unavailable",
            reason: "rate limited",
            lastBadge: { headline: "3 PRs waiting" },
          },
        });

        const silent = yield* environmentTools.refreshStatus(GH_ID).pipe(Effect.forkChild);
        yield* answerNextProbe(probeCalls, finished({ code: null, timedOut: true }));
        yield* Fiber.join(silent);
        expect(yield* Queue.take(events)).toMatchObject({
          status: {
            state: "unavailable",
            reason: "No answer within 30s",
            lastBadge: { headline: "3 PRs waiting" },
          },
        });
      }).pipe(Effect.scoped),
    );

    it.effect("drops the result of a run the definition changed under", () =>
      Effect.gen(function* () {
        const { environmentTools, probeCalls, setTools } = yield* makeHarness({ gh: GH });
        const events = yield* watchStatus(environmentTools);
        yield* Queue.take(events);
        const stale = yield* Queue.take(probeCalls);

        yield* setTools({ gh: { ...GH, status: { command: "gh-badge --v2" } } });
        const fresh = yield* Queue.take(probeCalls);
        expect(fresh.input.args.at(-1)).toBe("gh-badge --v2");
        yield* Deferred.succeed(stale.respond, badgeOutput("stale"));
        yield* Deferred.succeed(fresh.respond, badgeOutput("fresh"));
        expect(yield* Queue.take(events)).toMatchObject({
          status: { state: "ready", badge: { headline: "fresh" } },
        });
      }).pipe(Effect.scoped),
    );

    it.effect("a refresh during a run waits for that run instead of starting another", () =>
      Effect.gen(function* () {
        const { environmentTools, probeCalls } = yield* makeHarness({ gh: GH });
        const events = yield* watchStatus(environmentTools);
        yield* Queue.take(events);
        const inFlight = yield* Queue.take(probeCalls);

        const refresh = yield* environmentTools
          .refreshStatus(GH_ID)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(inFlight.respond, badgeOutput("3 PRs waiting"));
        yield* Fiber.join(refresh);
        expect(yield* Queue.size(probeCalls)).toBe(0);
      }).pipe(Effect.scoped),
    );

    it.effect("tells watchers when a probed tool is removed", () =>
      Effect.gen(function* () {
        const { environmentTools, setTools } = yield* makeHarness({ gh: GH });
        const events = yield* watchStatus(environmentTools);
        yield* Queue.take(events);

        yield* setTools({});
        expect(yield* Queue.take(events)).toEqual({ type: "status", toolId: "gh", status: null });
        expect(yield* environmentTools.statuses).toEqual(new Map());
      }).pipe(Effect.scoped),
    );
  });
});
