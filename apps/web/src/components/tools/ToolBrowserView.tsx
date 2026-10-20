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
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";

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
}

/** The tool's tab always lives in the environment's browser, so a port target is the host's. */
export function ToolBrowserView(props: {
  readonly environmentId: EnvironmentId;
  readonly toolId: EnvironmentToolId;
  readonly toolName: string;
}) {
  const { environmentId, toolId } = props;
  const canOpen = useAtomValue(
    environmentToolsEnvironment.open.permissionAtom(environmentId, { toolId, kind: "browser" }),
  );
  const open = useAtomCommand(environmentToolsEnvironment.open, { reportFailure: false });
  const threadRef = scopeThreadRef(environmentId, environmentToolThreadId(toolId));
  usePreviewSession(threadRef);
  const preview = useThreadPreviewState(threadRef);
  const [tab, setTab] = useState<OpenedTab | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listed = tab !== null && preview.sessions[tab.id] !== undefined;
  if (tab !== null && tab.epoch === null && listed) setTab({ ...tab, epoch: preview.serverEpoch });
  const gone = tab !== null && tab.epoch !== null && preview.listLoaded && !listed;
  // Tab ids carry the server epoch: a tab lost to a server restart reopens. On the same server a
  // tool restart, or a stop and start from any device, replaces the tab, so follow the thread's
  // remaining tab; with none left the tool was stopped and stays closed.
  const restarted = gone && preview.serverEpoch !== tab.epoch;
  const replacement =
    gone && !restarted
      ? Object.values(preview.sessions).find((session) => session.runtime === "server")
      : undefined;
  if (replacement !== undefined) setTab({ id: replacement.tabId, epoch: preview.serverEpoch });

  const launch = async () => {
    const result = await open({ environmentId, input: { toolId, kind: "browser" } });
    if (result._tag === "Success") {
      if (!isUnknownUnionMember(result.value) && result.value.kind === "browser") {
        setTab({ id: result.value.tabId, epoch: null });
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
  if (!listed) return <ToolViewMessage>Opening {props.toolName}…</ToolViewMessage>;
  return (
    <PreviewPanelShell mode="embedded">
      <PreviewView threadRef={threadRef} tabId={tab.id} visible allowRuntimeMove={false} />
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
