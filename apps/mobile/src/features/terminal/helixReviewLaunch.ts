import {
  findOpenHelixReviewTerminal,
  helixReviewCommand,
  newHelixReviewTerminalId,
  type HelixOpenOptions,
} from "@t3tools/client-runtime/helix-review";
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import {
  resolvePreferredThreadWorktreePath,
  type PendingTerminalLaunch,
} from "./terminalLaunchContext";

export function prepareHelixReviewLaunch(input: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
  readonly sessions: ReadonlyArray<KnownTerminalSession>;
  readonly uniqueSuffix: string;
  readonly options?: HelixOpenOptions;
}) {
  const worktreePath = input.options?.worktreePath ?? resolvePreferredThreadWorktreePath(input);
  const cwd = worktreePath ?? input.workspaceRoot;
  const existingTerminalId = findOpenHelixReviewTerminal(
    input.sessions.filter(
      ({ target, state }) =>
        target.environmentId === input.threadRef.environmentId &&
        target.threadId === input.threadRef.threadId &&
        state.summary?.cwd === cwd &&
        (state.summary.worktreePath ?? null) === worktreePath,
    ),
  );
  const target = {
    ...input.threadRef,
    terminalId: existingTerminalId ?? newHelixReviewTerminalId(input.uniqueSuffix),
  };
  if (existingTerminalId !== null) return { target, launch: null };

  const project = { cwd: input.workspaceRoot };
  const launch: PendingTerminalLaunch = {
    cwd: projectScriptCwd({ project, worktreePath }),
    worktreePath,
    env: projectScriptRuntimeEnv({ project, worktreePath }),
    initialInput: `${helixReviewCommand(target.threadId, target.environmentId, input.options)}\r`,
  };
  return { target, launch };
}

export function createHelixLaunchCoordinator(now = Date.now) {
  const pending = new Map<
    string,
    { target: ReturnType<typeof prepareHelixReviewLaunch>["target"]; expires: number }
  >();
  return (input: Parameters<typeof prepareHelixReviewLaunch>[0]) => {
    const prepared = prepareHelixReviewLaunch(input);
    const worktreePath = input.options?.worktreePath ?? resolvePreferredThreadWorktreePath(input);
    const key = JSON.stringify([
      input.threadRef.environmentId,
      input.threadRef.threadId,
      worktreePath ?? input.workspaceRoot,
    ]);
    const time = now();
    for (const [key, reservation] of pending) if (reservation.expires <= time) pending.delete(key);
    if (!prepared.launch) {
      pending.delete(key);
      return prepared;
    }
    const reservation = pending.get(key);
    const known =
      reservation &&
      input.sessions.find(
        ({ target }) =>
          target.environmentId === reservation.target.environmentId &&
          target.threadId === reservation.target.threadId &&
          target.terminalId === reservation.target.terminalId,
      );
    if (reservation && !known) return { target: reservation.target, launch: null };
    // Reserve through navigation and the initial terminal RPC. A failed launch
    // with no metadata must eventually permit another attempt.
    pending.set(key, { target: prepared.target, expires: time + 30_000 });
    return prepared;
  };
}

export const prepareCoordinatedHelixReviewLaunch = createHelixLaunchCoordinator();
