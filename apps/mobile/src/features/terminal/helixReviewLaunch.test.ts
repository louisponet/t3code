import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  EMPTY_TERMINAL_SESSION_STATE,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";
import { createHelixLaunchCoordinator, prepareHelixReviewLaunch } from "./helixReviewLaunch";
import { stagePendingTerminalLaunch, takePendingTerminalLaunch } from "./terminalLaunchContext";

const threadRef = {
  environmentId: EnvironmentId.make("remote-env"),
  threadId: ThreadId.make("thread:mobile-review"),
};
const context = {
  threadRef,
  workspaceRoot: "/remote/project",
  threadShellWorktreePath: "/remote/stale-worktree",
  threadDetailWorktreePath: "/remote/worktrees/review",
  uniqueSuffix: "new-launch",
};

function session(
  terminalId: string,
  status: KnownTerminalSession["state"]["status"],
  target = threadRef,
): KnownTerminalSession {
  return {
    target: { ...target, terminalId },
    state: {
      ...EMPTY_TERMINAL_SESSION_STATE,
      status,
      summary: {
        threadId: String(target.threadId),
        terminalId,
        cwd: "/remote/worktrees/review",
        worktreePath: "/remote/worktrees/review",
        status: status === "closed" || status === "error" ? "exited" : status,
        pid: 10,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: true,
        label: "",
        updatedAt: "",
      },
    },
  };
}

describe("mobile HX review launch", () => {
  it("stages the selected remote thread and freshest worktree for the terminal route once", () => {
    const prepared = prepareHelixReviewLaunch({ ...context, sessions: [] });
    expect(prepared.target).toEqual({ ...threadRef, terminalId: "helix-review-new-launch" });
    expect(prepared.launch).toMatchObject({
      cwd: "/remote/worktrees/review",
      worktreePath: "/remote/worktrees/review",
      env: {
        T3CODE_PROJECT_ROOT: "/remote/project",
        T3CODE_WORKTREE_PATH: "/remote/worktrees/review",
      },
    });
    expect(prepared.launch?.initialInput).toContain("--thread");
    expect(prepared.launch?.initialInput).toContain("thread:mobile-review");
    expect(prepared.launch?.initialInput).toContain("--environment-id");
    expect(prepared.launch?.initialInput).toContain("remote-env");
    expect(prepared.launch?.initialInput).toMatch(/\r$/);
    stagePendingTerminalLaunch({ target: prepared.target, launch: prepared.launch! });
    expect(
      takePendingTerminalLaunch({
        ...prepared.target,
        environmentId: EnvironmentId.make("other-env"),
      }),
    ).toBeNull();
    expect(takePendingTerminalLaunch(prepared.target)).toEqual(prepared.launch);
    expect(takePendingTerminalLaunch(prepared.target)).toBeNull();
  });

  it("opens a live dedicated session without putting a command into the active editor", () => {
    const prepared = prepareHelixReviewLaunch({
      ...context,
      sessions: [session("default", "running"), session("helix-review-live", "running")],
    });
    expect(prepared.target.terminalId).toBe("helix-review-live");
    expect(prepared.launch).toBeNull();
  });

  it("starts a fresh review after exit and never attaches to another environment or thread", () => {
    const prepared = prepareHelixReviewLaunch({
      ...context,
      threadDetailWorktreePath: null,
      threadShellWorktreePath: null,
      sessions: [
        session("helix-review-exited", "exited"),
        session("helix-review-remote", "running", {
          ...threadRef,
          environmentId: EnvironmentId.make("other-env"),
        }),
        session("helix-review-other-thread", "running", {
          ...threadRef,
          threadId: ThreadId.make("other-thread"),
        }),
      ],
    });
    expect(prepared.target.terminalId).toBe("helix-review-new-launch");
    expect(prepared.launch?.cwd).toBe("/remote/project");
    expect(prepared.launch?.worktreePath).toBeNull();
  });
  it("opens the requested file and exact comparison on first launch", () => {
    const prepared = prepareHelixReviewLaunch({
      ...context,
      sessions: [],
      options: {
        filePath: "src/a b.ts",
        line: 19,
        baseline: "a".repeat(40),
        revision: "b".repeat(40),
        worktreePath: "/remote/worktrees/review",
      },
    });
    expect(prepared.launch?.initialInput).toContain("--location");
    expect(prepared.launch?.initialInput).toContain("src/a b.ts");
    expect(prepared.launch?.initialInput).toContain('"revision":"' + "b".repeat(40) + '"');
    expect(prepared.launch?.cwd).toBe("/remote/worktrees/review");
  });
  it("opens a new editor after the thread moves worktrees", () => {
    const stale = session("helix-review-stale", "running");
    const prepared = prepareHelixReviewLaunch({
      ...context,
      sessions: [stale],
      threadDetailWorktreePath: "/remote/new-worktree",
    });
    expect(prepared.target.terminalId).toBe("helix-review-new-launch");
    expect(prepared.launch?.cwd).toBe("/remote/new-worktree");
  });
  it("reuses one launching editor when different files open before terminal registration", () => {
    const prepare = createHelixLaunchCoordinator();
    const first = prepare({ ...context, sessions: [], options: { filePath: "a.ts" } });
    const next = prepare({
      ...context,
      uniqueSuffix: "second",
      sessions: [],
      options: { filePath: "b.ts" },
    });
    expect(first.launch).not.toBeNull();
    expect(next.target).toEqual(first.target);
    expect(next.launch).toBeNull();
    const registered = prepare({
      ...context,
      sessions: [session(first.target.terminalId, "running")],
      options: { filePath: "c.ts" },
    });
    expect(registered.target).toEqual(first.target);
    expect(registered.launch).toBeNull();
  });

  it("allows a fresh launch when unregistered startup expires or a terminal exits", () => {
    let now = 0;
    const prepare = createHelixLaunchCoordinator(() => now);
    const first = prepare({ ...context, sessions: [] });
    now = 30_001;
    const second = prepare({ ...context, uniqueSuffix: "after-timeout", sessions: [] });
    expect(second.target.terminalId).not.toBe(first.target.terminalId);
    const exited = prepare({
      ...context,
      uniqueSuffix: "after-exit",
      sessions: [session(second.target.terminalId, "exited")],
    });
    expect(exited.target.terminalId).toBe("helix-review-after-exit");
    expect(exited.launch).not.toBeNull();
  });
});
