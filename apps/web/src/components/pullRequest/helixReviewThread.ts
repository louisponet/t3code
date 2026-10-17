import type { ScopedThreadRef } from "@t3tools/contracts";

type ReviewThread = {
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly linkedPullRequest?: { readonly url: string } | null | undefined;
  readonly pullRequests?: readonly { readonly url: string; readonly source: string }[] | undefined;
};

export function isArchivedHelixReviewThread(
  threads: readonly ReviewThread[],
  ref: ScopedThreadRef,
): boolean {
  return threads.some(
    (thread) =>
      thread.environmentId === ref.environmentId &&
      thread.id === ref.threadId &&
      thread.archivedAt !== null,
  );
}

export function findReusableHelixReviewThread<T extends ReviewThread>(
  threads: readonly T[],
  target: { environmentId: string; projectId: string; cwd: string; url: string },
): T | undefined {
  return threads.find(
    (thread) =>
      thread.archivedAt === null &&
      thread.environmentId === target.environmentId &&
      thread.projectId === target.projectId &&
      thread.worktreePath === target.cwd &&
      (thread.linkedPullRequest?.url === target.url ||
        thread.pullRequests?.some(
          (link) => link.url === target.url && link.source !== "stack-dismissed",
        )),
  );
}
