import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type EnvironmentToolDefinition,
  type EnvironmentToolId,
} from "@t3tools/contracts";
import { PencilIcon, RotateCwIcon, SquareIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { isElectron } from "../../env";
import {
  environmentToolRowsAtom,
  environmentToolsEnvironment,
  useEnvironmentToolRow,
  useEnvironmentToolStatus,
  type EnvironmentToolRows,
} from "../../state/environmentTools";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { ToolBrowserView } from "./ToolBrowserView";
import { ToolEditorDialog } from "./ToolEditorDialog";
import { ToolStatusBadge } from "./ToolStatusBadge";
import { ToolTerminalView } from "./ToolTerminalView";

type EnvironmentAvailability =
  | "unknown"
  | "offline"
  | "connecting"
  | "loading"
  | "unsupported"
  | "ready";

function environmentAvailability(
  presentation: EnvironmentPresentation | null,
): EnvironmentAvailability {
  if (presentation === null) return "unknown";
  switch (presentation.connection.phase) {
    case "connected":
      break;
    case "connecting":
    case "reconnecting":
      return "connecting";
    default:
      return "offline";
  }
  if (presentation.serverConfig === null) return "loading";
  return presentation.serverConfig.environment.capabilities.environmentTools === true
    ? "ready"
    : "unsupported";
}

const selectEnvironmentLabel = (presentation: EnvironmentPresentation | null) =>
  presentation?.entry.target.label ?? null;

const selectConnectionPhase = (presentation: EnvironmentPresentation | null) =>
  presentation?.connection.phase ?? null;

const selectToolsSpanEnvironments = ({ rows }: EnvironmentToolRows) =>
  rows.some((row) => row.environmentId !== rows[0]?.environmentId);

export function ToolPage({
  environmentId,
  toolId,
}: {
  readonly environmentId: EnvironmentId;
  readonly toolId: EnvironmentToolId;
}) {
  const row = useEnvironmentToolRow(environmentId, toolId);
  const presentationAtom = environmentPresentations.presentationAtom(environmentId);
  const phase = useAtomValue(presentationAtom, selectConnectionPhase);
  const environmentLabel =
    useAtomValue(presentationAtom, selectEnvironmentLabel) ?? "This environment";
  const showEnvironment = useAtomValue(environmentToolRowsAtom, selectToolsSpanEnvironments);
  // Mounting a view starts its tool, so a shown view stays mounted while the connection
  // recovers instead of starting a tool that was stopped or exited in the meantime.
  const [viewShown, setViewShown] = useState(false);
  const recovering =
    viewShown && (phase === "connecting" || phase === "reconnecting" || phase === "offline");
  const tool = row !== null && (!row.offline || recovering) ? row.definition : null;
  if (viewShown !== (tool !== null)) setViewShown(tool !== null);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="min-w-0 truncate text-sm font-medium">{tool?.name ?? toolId}</h1>
          {showEnvironment ? <Badge variant="outline">{environmentLabel}</Badge> : null}
          {tool === null ? null : (
            <ToolPageControls environmentId={environmentId} toolId={toolId} tool={tool} />
          )}
        </WorkspacePageHeader>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {recovering ? (
            <div
              role="status"
              className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center"
            >
              <Badge variant="warning">
                {phase === "offline"
                  ? `${environmentLabel} is offline`
                  : `Reconnecting to ${environmentLabel}…`}
              </Badge>
            </div>
          ) : null}
          {tool === null ? (
            <ToolUnavailable
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              toolId={toolId}
            />
          ) : tool.kind === "terminal" ? (
            <ToolTerminalView
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              toolId={toolId}
              tool={tool}
            />
          ) : (
            <ToolBrowserView environmentId={environmentId} toolId={toolId} toolName={tool.name} />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function ToolPageControls({
  environmentId,
  toolId,
  tool,
}: {
  readonly environmentId: EnvironmentId;
  readonly toolId: EnvironmentToolId;
  readonly tool: EnvironmentToolDefinition;
}) {
  const target = { toolId, kind: tool.kind };
  const status = useEnvironmentToolStatus(environmentId, toolId);
  const canOpen = useAtomValue(
    environmentToolsEnvironment.open.permissionAtom(environmentId, target),
  );
  const canStop = useAtomValue(
    environmentToolsEnvironment.stop.permissionAtom(environmentId, target),
  );
  const canRefresh = useAtomValue(
    environmentToolsEnvironment.refreshStatus.permissionAtom(environmentId),
  );
  const canEdit = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const open = useAtomCommand(environmentToolsEnvironment.open, `restart ${tool.name}`);
  const stop = useAtomCommand(environmentToolsEnvironment.stop, `stop ${tool.name}`);
  const refreshStatus = useAtomCommand(
    environmentToolsEnvironment.refreshStatus,
    `refresh ${tool.name} status`,
  );
  const refreshStatusQuietly = useAtomCommand(environmentToolsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState(false);
  const probed = tool.status !== undefined;

  // The probe often reports on what the tool just changed, so leaving the page refreshes it.
  const refreshOnLeave = useEffectEvent(() => {
    if (probed && canRefresh) void refreshStatusQuietly({ environmentId, input: { toolId } });
  });
  useEffect(() => () => refreshOnLeave(), []);

  return (
    <>
      <ToolStatusBadge status={status} size="header" description={tool.description} />
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {probed && canRefresh ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void refreshStatus({ environmentId, input: { toolId } })}
          >
            <RefreshIcon />
            Refresh
          </Button>
        ) : null}
        {tool.kind === "terminal" && canOpen ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void open({ environmentId, input: { toolId, kind: "terminal", restart: true } })
            }
          >
            <RotateCwIcon />
            Restart
          </Button>
        ) : null}
        {canStop ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void stop({ environmentId, input: target })}
          >
            <SquareIcon />
            Stop
          </Button>
        ) : null}
        {canEdit ? (
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            <PencilIcon />
            Edit
          </Button>
        ) : null}
      </div>
      <ToolEditorDialog
        open={editing}
        onOpenChange={setEditing}
        environmentId={environmentId}
        toolId={toolId}
      />
    </>
  );
}

function ToolUnavailable({
  environmentId,
  environmentLabel,
  toolId,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly toolId: EnvironmentToolId;
}) {
  const availability = useAtomValue(
    environmentPresentations.presentationAtom(environmentId),
    environmentAvailability,
  );
  const issue = useAtomValue(
    environmentToolRowsAtom,
    ({ issues }) => issues.get(environmentId)?.find((entry) => entry.key === toolId)?.message,
  );
  const message =
    availability === "unknown"
      ? "This environment is not connected to this client."
      : availability === "offline"
        ? `${environmentLabel} is offline.`
        : availability === "connecting"
          ? `Connecting to ${environmentLabel}…`
          : availability === "unsupported"
            ? `${environmentLabel} needs a newer T3 Code to run tools.`
            : availability === "loading"
              ? null
              : issue !== undefined
                ? `The "${toolId}" tool has a problem: ${issue}. Fix it in Settings → Tools.`
                : `${environmentLabel} has no tool named "${toolId}".`;
  if (message === null) return null;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
