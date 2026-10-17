import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { findReusableHelixReviewThread, isArchivedHelixReviewThread } from "./helixReviewThread";

const target = {
  environmentId: "env",
  projectId: "project",
  cwd: "/review",
  url: "https://github.com/acme/repo/pull/1",
};
const thread = {
  environmentId: target.environmentId,
  id: "thread",
  projectId: target.projectId,
  worktreePath: target.cwd,
  archivedAt: null,
  linkedPullRequest: { url: target.url },
};

describe("Helix PR review thread reuse", () => {
  it("skips an archived matching thread and reuses the active thread for the same PR checkout", () => {
    const active = { ...thread, id: "active" };
    expect(
      findReusableHelixReviewThread([{ ...thread, archivedAt: "2026-10-17" }, active], target),
    ).toBe(active);
    expect(
      findReusableHelixReviewThread([{ ...thread, archivedAt: "2026-10-17" }], target),
    ).toBeUndefined();
  });
  it("invalidates a cached review when its thread is archived without crossing environments", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    expect(isArchivedHelixReviewThread([thread], ref)).toBe(false);
    expect(isArchivedHelixReviewThread([{ ...thread, archivedAt: "2026-10-17" }], ref)).toBe(true);
    expect(
      isArchivedHelixReviewThread(
        [{ ...thread, environmentId: "other", archivedAt: "2026-10-17" }],
        ref,
      ),
    ).toBe(false);
  });
});
