import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  environmentToolThreadId,
  isUnknownUnionMember,
  type EnvironmentId,
  type EnvironmentToolId,
  type PreviewRuntime,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { markToolTabLaunched } from "../../browser/launchedToolTabs";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { useThreadPreviewState } from "../../previewStateStore";
import { environmentToolsEnvironment } from "../../state/environmentTools";
import { useAtomCommand } from "../../state/use-atom-command";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { PreviewView } from "../preview/PreviewView";
import { usePreviewSession } from "../preview/usePreviewSession";
import { Button } from "../ui/button";

interface OpenedTab {
  readonly id: string;
  /** The server epoch the tab was listed under; null until it is listed. */
  readonly epoch: string | null;
  /** Where the server opened the tab, which may not be where the view asked. */
  readonly runtime: PreviewRuntime | null;
}

export function ToolBrowserView(props: {
  readonly environmentId: EnvironmentId;
  readonly toolId: EnvironmentToolId;
  readonly toolName: string;
  readonly runtime: PreviewRuntime;
}) {
  const { environmentId, toolId, runtime } = props;
  const canOpen = useAtomValue(
    environmentToolsEnvironment.open.permissionAtom(environmentId, { toolId, kind: "browser" }),
  );
  const open = useAtomCommand(environmentToolsEnvironment.open, { reportFailure: false });
  const threadRef = scopeThreadRef(environmentId, environmentToolThreadId(toolId));
  usePreviewSession(threadRef);
  const preview = useThreadPreviewState(threadRef);
  const [tab, setTab] = useState<OpenedTab | null>(null);
  const [error, setError] = useState<string | null>(null);

  const session = tab === null ? undefined : preview.sessions[tab.id];
  // Desktop tab ids repeat across server restarts, so a listed tab takes the current epoch.
  if (tab !== null && session !== undefined && tab.epoch !== preview.serverEpoch) {
    setTab({ ...tab, epoch: preview.serverEpoch, runtime: session.runtime ?? "desktop" });
  }
  const gone = tab !== null && tab.epoch !== null && preview.listLoaded && session === undefined;
  // A tab lost to a server restart reopens. On the same server a tool restart, or a stop and
  // start from any device viewing the same runtime, replaces the tab, so follow that runtime's
  // remaining tab; with none left the tool was stopped and stays closed.
  const restarted = gone && preview.serverEpoch !== tab.epoch;
  const replacement =
    gone && !restarted
      ? Object.values(preview.sessions).find(
          (candidate) => (candidate.runtime ?? "desktop") === tab.runtime,
        )
      : undefined;
  if (tab !== null && replacement !== undefined) {
    setTab({ ...tab, id: replacement.tabId, epoch: preview.serverEpoch });
  }

  const launchedKey =
    tab === null || tab.epoch === null ? null : previewRuntimeTabId(threadRef, tab.epoch, tab.id);
  useEffect(() => {
    if (launchedKey !== null) markToolTabLaunched(launchedKey);
  }, [launchedKey]);

  const launch = async () => {
    const result = await open({ environmentId, input: { toolId, kind: "browser", runtime } });
    if (result._tag === "Success") {
      if (!isUnknownUnionMember(result.value) && result.value.kind === "browser") {
        setTab({ id: result.value.tabId, epoch: null, runtime: null });
        setError(null);
      }
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : `Couldn't open ${props.toolName}.`);
  };
  const launchNow = useEffectEvent(() => void launch());
  const shouldLaunch = canOpen && (tab === null || restarted);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Opens the server tab; state changes only once the server answers.
    if (shouldLaunch) launchNow();
  }, [shouldLaunch]);

  if (!canOpen) {
    return (
      <ToolViewMessage>
        Pair this client again with preview access to open browser tools.
      </ToolViewMessage>
    );
  }
  if (error !== null) {
    return (
      <ToolViewMessage>
        {error}
        <Button variant="outline" size="sm" onClick={() => void launch()}>
          Try again
        </Button>
      </ToolViewMessage>
    );
  }
  if (gone && !restarted) {
    return (
      <ToolViewMessage>
        {props.toolName} is stopped.
        <Button size="sm" onClick={() => void launch()}>
          Start
        </Button>
      </ToolViewMessage>
    );
  }
  // The first browser on a host can take a while: it downloads Chrome.
  if (session === undefined) return <ToolViewMessage>Opening {props.toolName}…</ToolViewMessage>;
  return (
    <PreviewPanelShell mode="embedded">
      <PreviewView threadRef={threadRef} tabId={session.tabId} visible allowRuntimeMove={false} />
    </PreviewPanelShell>
  );
}

export function ToolViewMessage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
