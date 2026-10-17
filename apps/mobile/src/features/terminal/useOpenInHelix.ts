import { useCallback } from "react";
import { useNavigation } from "@react-navigation/native";
import { AuthTerminalOperateScope, AuthTerminalReadScope } from "@t3tools/contracts";
import type { HelixOpenOptions } from "@t3tools/client-runtime/helix-review";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { uuidv4 } from "../../lib/uuid";
import { prepareCoordinatedHelixReviewLaunch } from "./helixReviewLaunch";
import { stagePendingTerminalLaunch } from "./terminalLaunchContext";
import { stageHelixOpen } from "./helixOpenContext";

export function useOpenInHelix(environmentId: string | null, threadId: string | null) {
  const navigation = useNavigation();
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const { sessions } = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const canRead = useEnvironmentScope(selectedThread?.environmentId ?? null, AuthTerminalReadScope);
  const canOperate = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthTerminalOperateScope,
  );
  const runtime = useRemoteEnvironmentRuntime(selectedThread?.environmentId ?? null);
  const os = runtime?.serverConfig?.environment.platform.os;
  const available = Boolean(
    selectedThread &&
    selectedThread.environmentId === environmentId &&
    selectedThread.id === threadId &&
    selectedThreadProject?.workspaceRoot &&
    sessions !== null &&
    canRead &&
    canOperate &&
    (os === "linux" || os === "darwin"),
  );
  const open = useCallback(
    (options: HelixOpenOptions = {}) => {
      if (
        !available ||
        !selectedThread ||
        !selectedThreadProject?.workspaceRoot ||
        !readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope) ||
        !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)
      )
        return false;
      const prepared = prepareCoordinatedHelixReviewLaunch({
        threadRef: { environmentId: selectedThread.environmentId, threadId: selectedThread.id },
        workspaceRoot: selectedThreadProject.workspaceRoot,
        threadShellWorktreePath: selectedThread.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadWorktreePath,
        sessions: sessions ?? [],
        uniqueSuffix: uuidv4(),
        options,
      });
      if (prepared.launch)
        stagePendingTerminalLaunch({ target: prepared.target, launch: prepared.launch });
      else stageHelixOpen(prepared.target, options);
      navigation.navigate("ThreadTerminal", {
        environmentId: String(prepared.target.environmentId),
        threadId: String(prepared.target.threadId),
        terminalId: prepared.target.terminalId,
      });
      return true;
    },
    [
      available,
      selectedThread,
      selectedThreadProject,
      selectedThreadWorktreePath,
      sessions,
      navigation,
    ],
  );
  return { available, open };
}
