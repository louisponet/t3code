import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import {
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { useProject, useEnvironmentServerConfig, useThreadShells } from "../../state/entities";
import { composerPullRequests } from "../../state/pull-requests";
import { threadEnvironment } from "../../state/threads";
import { gitEnvironment } from "../../state/git";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { resolveSelectableModelSelection } from "../../lib/modelOptions";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { stageHelixOpen } from "../terminal/helixOpenContext";
import { uuidv4 } from "../../lib/uuid";
import { prepareCoordinatedHelixReviewLaunch } from "../terminal/helixReviewLaunch";
import { stagePendingTerminalLaunch } from "../terminal/terminalLaunchContext";
import { pullRequestTarget, type PullRequestDiffParams } from "./usePullRequestDiff";

const reviewThreads = new Map<
  string,
  { threadId: ThreadId; worktreePath: string; branch: string }
>();

export function HelixPullRequestFileScreen(props: {
  params: PullRequestDiffParams & {
    path: string;
    focus?: { side: "old" | "new"; start: number; end: number };
  };
}) {
  const { params } = props;
  const navigation = useNavigation();
  const target = pullRequestTarget(params);
  const project = useProject({
    environmentId: target.environmentId,
    projectId: target.input.projectId,
  });
  const config = useEnvironmentServerConfig(target.environmentId);
  const commitDiff = useEnvironmentQuery(
    params.commit
      ? composerPullRequests.diff({ ...target, input: { ...target.input, commit: params.commit } })
      : null,
  );
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const linkedThreads = useEnvironmentQuery(composerPullRequests.linkedThreads(target));
  const shells = useThreadShells();
  const reviewKey = JSON.stringify([
    params.environmentId,
    params.projectId,
    params.host,
    params.repository,
    params.number,
    detail.data?.headSha,
  ]);
  const cachedEntry = reviewThreads.get(reviewKey);
  const cached =
    cachedEntry &&
    !shells.some((thread) => thread.id === cachedEntry.threadId && thread.archivedAt !== null)
      ? cachedEntry
      : undefined;
  const candidate = shells.find(
    (thread) =>
      thread.environmentId === params.environmentId &&
      thread.projectId === params.projectId &&
      thread.archivedAt === null &&
      linkedThreads.data?.threads.some((linked) => linked.id === thread.id),
  );
  const reuseId = cached?.threadId ?? candidate?.id ?? null;
  const known = useKnownTerminalSessions({
    environmentId: target.environmentId,
    threadId: reuseId,
  });
  const prepare = useAtomCommand(gitEnvironment.preparePullRequestThread, { reportFailure: false });
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const launched = useRef<string | null>(null);
  const currentKey = useRef<string | null>(null);
  const key = JSON.stringify([
    params.environmentId,
    params.projectId,
    params.number,
    params.path,
    params.commit,
    revision,
  ]);
  useLayoutEffect(() => {
    currentKey.current = key;
    return () => {
      currentKey.current = null;
    };
  }, [key]);
  useEffect(() => {
    if (
      !project ||
      !config ||
      !detail.data ||
      linkedThreads.isPending ||
      (reuseId !== null && known.isPending) ||
      (params.commit && commitDiff.isPending) ||
      launched.current === key
    )
      return;
    launched.current = key;
    const pr = detail.data;
    void (async () => {
      if (
        !readEnvironmentScope(target.environmentId, AuthTerminalReadScope) ||
        !readEnvironmentScope(target.environmentId, AuthTerminalOperateScope)
      )
        throw new Error("Opening Helix requires terminal read and operate access.");
      const os = config.environment.platform.os;
      if (os !== "linux" && os !== "darwin")
        throw new Error("Helix requires a Linux or macOS host.");
      if (params.commit && !commitDiff.data?.helixComparison)
        throw new Error(
          "This server did not provide exact parent and commit revisions. Update the server to review this commit in Helix.",
        );
      const modelSelection = resolveSelectableModelSelection(config, null, project.id);
      if (!modelSelection && !reuseId)
        throw new Error(
          "Choose an available model for this project before creating a review thread.",
        );
      let threadId = reuseId ?? ThreadId.make(uuidv4());
      const prepared = await prepare({
        environmentId: target.environmentId,
        input: { cwd: project.workspaceRoot, reference: pr.url, mode: "worktree", threadId },
      });
      if (prepared._tag !== "Success")
        throw new Error(
          "Could not prepare this PR worktree. Check source control permissions and connection.",
        );
      if (!prepared.value.worktreePath || !prepared.value.isOnPullRequestHead)
        throw new Error(
          "The PR worktree has local changes and could not update to the PR head. Resolve them before reviewing.",
        );
      if (currentKey.current !== key) return;
      const reusable =
        cached ??
        (candidate?.worktreePath === prepared.value.worktreePath &&
        candidate.branch === prepared.value.branch
          ? candidate
          : null);
      if (!reusable) {
        if (!modelSelection)
          throw new Error("Choose an available model before creating a PR review thread.");
        if (reuseId) threadId = ThreadId.make(uuidv4());
        const created = await create({
          environmentId: target.environmentId,
          input: {
            threadId,
            projectId: project.id,
            title: `Review #${pr.number}: ${pr.title}`,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: prepared.value.branch,
            worktreePath: prepared.value.worktreePath,
          },
        });
        if (created._tag !== "Success") throw new Error("Could not create the PR review thread.");
      }
      reviewThreads.set(reviewKey, {
        threadId,
        worktreePath: prepared.value.worktreePath,
        branch: prepared.value.branch,
      });
      if (currentKey.current !== key) return;
      const parsed = parseChangeRequestUrl(pr.url);
      if (!parsed) throw new Error("The PR URL could not be linked to this review thread.");
      const linked = await link({
        environmentId: target.environmentId,
        input: {
          threadId,
          ...normalizeThreadPullRequestKey(parsed),
          url: pr.url,
          source: "manual",
        },
      });
      if (linked._tag !== "Success")
        throw new Error("Could not link this PR to the review thread.");
      if (currentKey.current !== key) return;
      const launch = prepareCoordinatedHelixReviewLaunch({
        threadRef: { environmentId: EnvironmentId.make(params.environmentId), threadId },
        workspaceRoot: project.workspaceRoot,
        threadShellWorktreePath: prepared.value.worktreePath,
        threadDetailWorktreePath: prepared.value.worktreePath,
        sessions: known.sessions ?? [],
        uniqueSuffix: uuidv4(),
        options: {
          mode: "review",
          ...(params.commit ? commitDiff.data?.helixComparison : {}),
          filePath: params.path,
          ...(params.focus ? { line: params.focus.start, side: params.focus.side } : {}),
          worktreePath: prepared.value.worktreePath,
        },
      });
      if (launch.launch)
        stagePendingTerminalLaunch({ target: launch.target, launch: launch.launch });
      else
        stageHelixOpen(launch.target, {
          mode: "review",
          ...(params.commit ? commitDiff.data?.helixComparison : {}),
          filePath: params.path,
          ...(params.focus ? { line: params.focus.start, side: params.focus.side } : {}),
          worktreePath: prepared.value.worktreePath,
        });
      navigation.navigate("ThreadTerminal", {
        environmentId: params.environmentId,
        threadId: String(threadId),
        terminalId: launch.target.terminalId,
      });
    })().catch((cause: unknown) => {
      if (currentKey.current !== key) return;
      setError(cause instanceof Error ? cause.message : "Could not open this PR in Helix.");
    });
  }, [
    key,
    project,
    config,
    detail.data,
    prepare,
    create,
    link,
    navigation,
    params,
    target.environmentId,
    linkedThreads.isPending,
    reuseId,
    cached,
    candidate,
    known.sessions,
    known.isPending,
    reviewKey,
    commitDiff.isPending,
    commitDiff.data,
  ]);
  const displayedError =
    error ?? detail.error ?? linkedThreads.error ?? commitDiff.error ?? known.error;
  return (
    <View className="flex-1 bg-sheet">
      <EmptyState
        title={displayedError ? "PR review unavailable" : "Preparing PR in Helix…"}
        detail={displayedError ?? "Preparing the PR worktree and review thread."}
      />
      {displayedError ? (
        <Button
          label="Retry"
          onPress={() => {
            detail.refresh();
            linkedThreads.refresh();
            if (params.commit) commitDiff.refresh();
            setError(null);
            setRevision((value) => value + 1);
          }}
        />
      ) : null}
    </View>
  );
}
