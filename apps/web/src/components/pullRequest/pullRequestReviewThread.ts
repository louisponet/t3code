import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderInstanceId,
  renderPullRequestReviewBrief,
  resolveProjectProviderInstanceEnabled,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScopedThreadRef,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import { createPullRequestLinking } from "~/hooks/usePullRequestLinking";
import { useStableCallback } from "~/hooks/useStableCallback";
import { newMessageId, newThreadId } from "~/lib/utils";
import { resolveDefaultProviderModelSelection } from "~/providerInstances";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProject, readProjects, readThreadShells } from "~/state/entities";
import { gitEnvironment } from "~/state/git";
import { environmentServerConfigsAtom, serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { toastManager } from "../ui/toast";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";

type ReviewTarget = Pick<
  EnvironmentPullRequestEntry,
  "environmentId" | "projectId" | "host" | "repository" | "number" | "title" | "url"
>;

/**
 * Model for a new thread when the user has not chosen one: project default, then a recent
 * thread's, swapped for a selectable one when its provider is no longer available.
 */
export function resolveNewThreadModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
  projectDefault: ModelSelection | null,
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "modelSelection">
  >,
  target: { environmentId: EnvironmentId; projectId: ProjectId },
): ModelSelection {
  const preferredInstance = Object.entries(settings.providerInstances).find(
    ([, instance]) => instance.enabled !== false,
  );
  const selection = projectDefault ??
    threads.find(
      (thread) =>
        thread.environmentId === target.environmentId && thread.projectId === target.projectId,
    )?.modelSelection ??
    threads.find((thread) => thread.environmentId === target.environmentId)?.modelSelection ?? {
      instanceId: ProviderInstanceId.make(preferredInstance?.[0] ?? "codex"),
      model:
        (preferredInstance ? DEFAULT_MODEL_BY_PROVIDER[preferredInstance[1].driver] : undefined) ??
        DEFAULT_MODEL,
    };
  const projectProviders = providers.map((provider) => ({
    ...provider,
    enabled: resolveProjectProviderInstanceEnabled(settings, target.projectId, provider.instanceId),
  }));
  return resolveDefaultProviderModelSelection(projectProviders, selection) ?? selection;
}

export function reviewTargetKey(target: Pick<ReviewTarget, "environmentId" | "url">): string {
  return `${target.environmentId}:${target.url}`;
}

/**
 * Review threads that may exist but are not linked yet: a failed link, or a start whose outcome is
 * unknown. A retry links one of these instead of starting a second review. Module scope, so leaving
 * the pull request list does not forget them.
 */
const unlinkedReviewThreads = new Map<string, ScopedThreadRef>();

/** Launches outlive the list that started them, so a remounted list still sees them as pending. */
let pendingReviewKeys: ReadonlySet<string> = new Set();
const pendingListeners = new Set<() => void>();
function setReviewPending(key: string, pending: boolean) {
  const next = new Set(pendingReviewKeys);
  if (pending) next.add(key);
  else next.delete(key);
  pendingReviewKeys = next;
  for (const listener of pendingListeners) listener();
}
function subscribePendingReviews(listener: () => void) {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

function reviewThreadTitle(target: Pick<ReviewTarget, "repository" | "number" | "title">) {
  return `Review ${target.repository.split("/").at(-1)}#${target.number}: ${target.title}`;
}

/**
 * Starts a review thread for a pull request with the configured brief, or reuses the thread
 * already linked to it, then focuses that thread with the pull request open beside it.
 */
export function usePullRequestReviewThread() {
  const navigate = useNavigate();
  const router = useRouter();
  const prepare = useAtomCommand(gitEnvironment.preparePullRequestThread, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const pendingKeys = useSyncExternalStore(subscribePendingReviews, () => pendingReviewKeys);

  const launch = async (
    target: ReviewTarget,
  ): Promise<{ threadRef: ScopedThreadRef; linkError: unknown }> => {
    const { environmentId, projectId } = target;
    const key = reviewTargetKey(target);
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
    const linking = createPullRequestLinking({
      environmentId,
      mode: threadPullRequestLinkMode(config?.environment.capabilities),
      projects: readProjects(),
      commands: { link, unlink, updateMetadata },
    });
    // Reviewer tasks link the PR in their own child threads; the review is their parent.
    const threads = readThreadShells().filter(
      (thread) => thread.lineage.relationshipToParent !== "subagent",
    );
    const linkThread = async (threadRef: ScopedThreadRef) => {
      try {
        await linking.changeLink(threadRef, target.url, true);
        unlinkedReviewThreads.delete(key);
        return { threadRef, linkError: null };
      } catch (linkError) {
        unlinkedReviewThreads.set(key, threadRef);
        return { threadRef, linkError };
      }
    };
    const existing = threads
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.archivedAt === null &&
          linking.isLinked(thread, target.url),
      )
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (existing) {
      unlinkedReviewThreads.delete(key);
      return { threadRef: { environmentId, threadId: existing.id }, linkError: null };
    }
    const started = unlinkedReviewThreads.get(key);
    if (started) {
      const thread = threads.find((candidate) => candidate.id === started.threadId);
      if (thread && thread.archivedAt === null) return linkThread(started);
      // Not synced yet, or never created: warn once, and let the next click start a new review.
      unlinkedReviewThreads.delete(key);
      if (!thread)
        throw new Error(
          "The previous attempt may still have started a review. Check the sidebar, then click Review again to start a new one.",
        );
    }

    if (!linking.canLink(target.url))
      throw new Error("This environment cannot link this pull request to a thread.");
    if (!appAtomRegistry.get(gitEnvironment.preparePullRequestThread.permissionAtom(environmentId)))
      throw new Error("This connection needs source control write access to check out the PR.");
    const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
    const project = readProject({ environmentId, projectId });
    if (settings === null || project === null)
      throw new Error("This pull request's project is not loaded yet. Try again in a moment.");
    const projectSettings = resolveProjectSettings(settings, projectId, project).settings;
    if (projectSettings.pullRequestReviewBrief === "")
      throw new Error("Add a review thread brief in Settings → Source control first.");

    const prepared = await prepare({
      environmentId,
      input: { cwd: project.workspaceRoot, reference: target.url, mode: "worktree" },
    });
    if (prepared._tag === "Failure") throw squashAtomCommandFailure(prepared);
    if (!prepared.value.isOnPullRequestHead || !prepared.value.worktreePath)
      throw new Error(
        "The PR checkout has local changes or stale commits. Clean or update its worktree, then retry.",
      );

    const modelSelection = resolveNewThreadModelSelection(
      settings,
      config?.providers ?? [],
      projectSettings.pullRequestReviewModelSelection ?? projectSettings.defaultModelSelection,
      threads,
      { environmentId, projectId },
    );
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    unlinkedReviewThreads.set(key, { environmentId, threadId });
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: renderPullRequestReviewBrief(projectSettings.pullRequestReviewBrief, target.url),
          attachments: [],
        },
        modelSelection,
        runtimeMode: projectSettings.defaultRuntimeMode,
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId,
            title: reviewThreadTitle(target),
            modelSelection,
            runtimeMode: projectSettings.defaultRuntimeMode,
            interactionMode: "default",
            branch: prepared.value.branch,
            worktreePath: prepared.value.worktreePath,
            createdAt,
          },
        },
        createdAt,
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      if (wasBootstrapThreadNotCreated(error) || wasBootstrapThreadDeleted(error))
        unlinkedReviewThreads.delete(key);
      throw error;
    }
    return linkThread({ environmentId, threadId });
  };

  const review = useStableCallback(async (target: ReviewTarget) => {
    const key = reviewTargetKey(target);
    if (pendingReviewKeys.has(key)) return;
    setReviewPending(key, true);
    const startedAt = router.state.location.href;
    try {
      const { threadRef, linkError } = await launch(target);
      const threadPullRequests =
        appAtomRegistry.get(environmentServerConfigsAtom).get(target.environmentId)?.environment
          .capabilities.threadPullRequests === true;
      useRightPanelStore.getState().openPullRequest(threadRef, {
        projectId: target.projectId,
        ...(threadPullRequests ? { host: target.host } : {}),
        repository: target.repository,
        number: target.number,
        url: target.url,
      });
      const open = () =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      if (linkError !== null)
        toastManager.add({
          type: "warning",
          title: `Review of #${target.number} started, but the PR is not linked`,
          description: linkError instanceof Error ? linkError.message : String(linkError),
        });
      // Preparing a worktree can take a while; do not pull away someone who moved on.
      if (router.state.location.href === startedAt) open();
      else
        toastManager.add({
          type: "success",
          title: `Review thread for #${target.number} is ready`,
          actionProps: { children: "Open", onClick: open },
        });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not start a review of #${target.number}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setReviewPending(key, false);
    }
  });

  return { review, pendingKeys };
}
