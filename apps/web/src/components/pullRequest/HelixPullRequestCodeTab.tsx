import { findReusableHelixReviewThread, isArchivedHelixReviewThread } from "./helixReviewThread";
import { resolveNewThreadModelSelection } from "./pullRequestReviewThread";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useProject, useThreadShells, readThreadShells } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { EMPTY_SERVER_PROVIDERS } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { randomUUID } from "~/lib/utils";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_RUNTIME_MODE,
  ThreadId,
  type EnvironmentId,
  type PullRequestDetailView,
  type PullRequestRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { useAtomCommand } from "~/state/use-atom-command";
import { threadEnvironment } from "~/state/threads";
import { primaryServerKeybindingsAtom } from "~/state/server";
import HelixPanel from "../HelixPanel";
import { Button } from "../ui/button";
import type { PullRequestAgentSelectionInput } from "./PullRequestCodeTab";
import type { PullRequestFinding } from "./pullRequestDetail.logic";

const reviews = new Map<string, { threadRef: ScopedThreadRef; cwd: string }>();
const linkedReviews = new Set<string>();
const preparations = new Map<string, Promise<{ threadRef: ScopedThreadRef; cwd: string }>>();

export default function HelixPullRequestCodeTab({
  environmentId,
  reference,
  detail,
  revealRequest = null,
  selectedCommitOid,
  onSelectedCommitChange,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  selectedCommitOid: string | null;
  onSelectedCommitChange: (oid: string | null) => void;
  pendingFinding?: string | null;
  fixFindingLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
  onAddToAgentSelection?: (input: PullRequestAgentSelectionInput) => void;
  onRefresh: () => void;
  refreshToken?: number;
  backgroundRefreshToken?: number;
  revealRequest?: { readonly path: string; readonly nonce: number } | null;
}) {
  const key = JSON.stringify([
    environmentId,
    reference.projectId,
    detail.url,
    detail.headSha ?? null,
  ]);
  const [storedReview, setReview] = useState(() =>
    linkedReviews.has(key) ? (reviews.get(key) ?? null) : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = useProject({ environmentId, projectId: reference.projectId });
  const environmentSettings = useEnvironmentSettings(environmentId);
  const projectSettings = resolveProjectSettings(environmentSettings, reference.projectId, project);
  const threads = useThreadShells();
  const reviewArchived =
    storedReview !== null && isArchivedHelixReviewThread(threads, storedReview.threadRef);
  const review = reviewArchived ? null : storedReview;
  useEffect(() => {
    if (!reviewArchived) return;
    reviews.delete(key);
    linkedReviews.delete(key);
  }, [reviewArchived, key]);
  const providersByEnvironment = useEnvironmentProviders();
  const modelSelection = resolveNewThreadModelSelection(
    environmentSettings,
    providersByEnvironment.get(environmentId) ?? EMPTY_SERVER_PROVIDERS,
    projectSettings.settings.defaultModelSelection,
    threads,
    { environmentId, projectId: reference.projectId },
  );
  const prepare = usePreparePullRequestThreadAction({ environmentId, cwd: detail.workspaceRoot });
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const linking = usePullRequestLinking(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const commitDiff = useEnvironmentQuery(
    selectedCommitOid
      ? pullRequestEnvironment.diff({
          environmentId,
          input: { ...reference, commit: selectedCommitOid },
        })
      : null,
  );
  function prepareReview() {
    if (busy) return;
    setBusy(true);
    setError(null);
    let pending = preparations.get(key);
    if (!pending) {
      pending = (async () => {
        const prepared = await prepare.run({ reference: detail.url, mode: "worktree" });
        if (prepared._tag === "Failure") throw squashAtomCommandFailure(prepared);
        if (!prepared.value.isOnPullRequestHead || !prepared.value.worktreePath)
          throw new Error(
            "The PR checkout has local changes or stale commits. Clean or update its review worktree, then retry to review the requested PR revision.",
          );
        const latestThreads = readThreadShells();
        const cached = reviews.get(key);
        if (cached && isArchivedHelixReviewThread(latestThreads, cached.threadRef)) {
          reviews.delete(key);
          linkedReviews.delete(key);
        }
        const existing = findReusableHelixReviewThread(latestThreads, {
          environmentId,
          projectId: reference.projectId,
          cwd: prepared.value.worktreePath,
          url: detail.url,
        });
        let next =
          reviews.get(key) ??
          (existing
            ? {
                threadRef: { environmentId, threadId: existing.id },
                cwd: prepared.value.worktreePath,
              }
            : undefined);
        if (!next) {
          const threadId = ThreadId.make(randomUUID());
          const created = await create({
            environmentId,
            input: {
              threadId,
              projectId: reference.projectId,
              title: `Review ${reference.repository}#${reference.number}`,
              modelSelection,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: "default",
              branch: prepared.value.branch,
              worktreePath: prepared.value.worktreePath,
            },
          });
          if (created._tag === "Failure") throw squashAtomCommandFailure(created);
          const threadRef = { environmentId, threadId };
          next = { threadRef, cwd: prepared.value.worktreePath };
          reviews.set(key, next);
        }
        await linking.changeLink(next.threadRef, detail.url, true);
        linkedReviews.add(key);
        return next;
      })();
      preparations.set(key, pending);
      void pending
        .finally(() => {
          if (preparations.get(key) === pending) preparations.delete(key);
        })
        .catch(() => {});
    }
    void pending
      .then(setReview, (failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false));
  }
  if (!review)
    return (
      <div className="flex h-full min-h-0 flex-col items-start justify-center gap-3 p-6 text-sm">
        <p>Review this pull request in Helix using its own worktree.</p>
        <Button disabled={busy || !prepare.isAllowed} onClick={() => void prepareReview()}>
          {busy ? "Preparing Helix…" : "Prepare Helix review"}
        </Button>
        {!prepare.isAllowed ? (
          <p className="text-muted-foreground">
            This connection needs source control write access to prepare the PR worktree.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  if (selectedCommitOid && !commitDiff.data?.helixComparison)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {commitDiff.isPending
          ? "Loading commit comparison…"
          : (commitDiff.error ??
            "Update this environment’s T3 server to open this exact commit comparison in Helix.")}
      </p>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 p-1">
        <select
          aria-label="PR comparison"
          value={selectedCommitOid ?? ""}
          onChange={(event) => onSelectedCommitChange(event.target.value || null)}
          className="max-w-full rounded border border-border bg-background p-1 text-xs"
        >
          <option value="">Entire pull request</option>
          {detail.commits.map((commit) => (
            <option key={commit.oid} value={commit.oid}>
              {commit.oid.slice(0, 8)} · {commit.messageHeadline}
            </option>
          ))}
        </select>
      </div>
      <HelixPanel
        threadRef={review.threadRef}
        cwd={review.cwd}
        worktreePath={review.cwd}
        keybindings={keybindings}
        options={{
          mode: "review",
          worktreePath: review.cwd,
          ...(selectedCommitOid
            ? {
                baseline: commitDiff.data!.helixComparison!.baseline,
                revision: commitDiff.data!.helixComparison!.revision,
              }
            : {}),
          ...(revealRequest ? { filePath: revealRequest.path } : {}),
        }}
        requestId={revealRequest?.nonce ?? 0}
      />
    </div>
  );
}
