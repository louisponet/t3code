import { isEnvironmentToolThreadId, type TerminalSummary, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, subscribeDynamic, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  nextTerminalAttachSeedState,
} from "./terminalSession.ts";

export function createTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const terminalThreadKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId]);
  const terminalSessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId, input.terminalId ?? null]);
  const lifecycleConcurrency = { mode: "serial" as const, key: terminalThreadKey };
  const observeSession = (input: EnvironmentRpcInput<typeof WS_METHODS.terminalObserve>) =>
    Stream.suspend(() =>
      subscribe(WS_METHODS.terminalObserve, input).pipe(
        Stream.scan(nextTerminalAttachSeedState, applyTerminalAttachStreamEvent),
      ),
    );
  const attachSession = (input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>) => {
    // Retry an unanswered first attach unchanged so it can still open the shell.
    let replied = false;
    return subscribeDynamic(WS_METHODS.terminalAttach, () =>
      Effect.sync(() => (replied ? { ...input, resume: true } : input)),
    ).pipe(
      Stream.onFirst(() =>
        Effect.sync(() => {
          replied = true;
        }),
      ),
      Stream.scan(nextTerminalAttachSeedState, applyTerminalAttachStreamEvent),
    );
  };
  const observe = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:terminal:observe",
    subscribe: observeSession,
  });
  const attach = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:terminal:attach",
    subscribe: attachSession,
  });
  // A trimmed client buffer can start mid-screen and lose a TUI's mode setup, so tool views
  // attach fresh on every mount and get the server's mode-prefixed snapshot and redraw.
  const observeTool = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:terminal:observe-tool",
    idleTtlMs: 0,
    subscribe: observeSession,
  });
  const attachTool = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:terminal:attach-tool",
    idleTtlMs: 0,
    subscribe: attachSession,
  });
  return {
    observe: (target: Parameters<typeof observe>[0]) =>
      isEnvironmentToolThreadId(target.input.threadId) ? observeTool(target) : observe(target),
    attach: (target: Parameters<typeof attach>[0]) =>
      isEnvironmentToolThreadId(target.input.threadId) ? attachTool(target) : attach(target),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:events",
      tag: WS_METHODS.subscribeTerminalEvents,
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
          Stream.scan((): ReadonlyArray<TerminalSummary> => [], applyTerminalMetadataStreamEvent),
          // The scan seed is not an authoritative empty server snapshot.
          Stream.drop(1),
        ),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:open",
      tag: WS_METHODS.terminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: WS_METHODS.terminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: WS_METHODS.terminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: terminalSessionKey },
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:clear",
      tag: WS_METHODS.terminalClear,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:restart",
      tag: WS_METHODS.terminalRestart,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:close",
      tag: WS_METHODS.terminalClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}

export * from "./terminalSession.ts";
