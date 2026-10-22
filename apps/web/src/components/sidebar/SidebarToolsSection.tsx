import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  AuthTerminalReadScope,
  type BrowserNavigationTarget,
  type ContextMenuItem,
  type PreviewRuntime,
  ENVIRONMENT_TOOL_TERMINAL_ID,
  type EnvironmentId,
  type EnvironmentToolId,
  environmentToolThreadId,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  AppWindowIcon,
  GlobeIcon,
  PlusIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { memo, useRef, useState } from "react";

import { browserToolRuntime } from "../../browser/previewRuntime";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useResizeDrag } from "../../hooks/useResizeDrag";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { previewStateAtom, type ThreadPreviewState } from "../../previewStateStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  environmentToolRowsAtom,
  environmentToolsEnvironment,
  type EnvironmentToolRow,
  useEnvironmentToolStatus,
  useEnvironmentToolsEnvironmentIds,
} from "../../state/environmentTools";
import { environmentToolRowKey } from "../../state/environmentTools.logic";
import { useEnvironmentIdentities } from "../../state/environments";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreviewSession } from "../preview/usePreviewSession";
import { ToolEditorDialog, useRemoveEnvironmentTool } from "../tools/ToolEditorDialog";
import { ToolStatusBadge, ToolToneDot } from "../tools/ToolStatusBadge";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ScrollArea } from "../ui/scroll-area";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import { groupSidebarTools, worstToolTone } from "./SidebarToolsSection.logic";

const TOOLS_EXPANDED_KEY = "t3code:sidebar:tools-expanded";
const TOOLS_HEIGHT_KEY = "t3code:sidebar:tools-height";
// Fractions of the viewport height, which the sidebar spans, so sizes follow window resizes.
// Until the user drags the list, it grows with its tools up to the default cap; after that it
// keeps the dragged height, leaving empty space below a short list.
const DEFAULT_TOOLS_MAX_HEIGHT = 0.25;
const MIN_TOOLS_HEIGHT = 0.05;
const MAX_TOOLS_HEIGHT = 0.75;
const ToolsHeightSchema = Schema.NullOr(Schema.Finite);

const clampToolsHeight = (fraction: number) =>
  Math.min(MAX_TOOLS_HEIGHT, Math.max(MIN_TOOLS_HEIGHT, fraction));

type ToolMenuAction = "open" | "restart" | "stop" | "refresh" | "edit" | "remove";

const worstToolToneAtom = Atom.make((get) =>
  worstToolTone(
    get(environmentToolRowsAtom).rows.flatMap((row) =>
      row.offline
        ? []
        : [get(environmentToolsEnvironment.statuses(row.environmentId)).get(row.toolId)],
    ),
  ),
).pipe(Atom.withLabel("sidebar-tools-worst-tone"));

// The session's own status, not hasRunningSubprocess: a command that the shell execs is the
// PTY's root process and has no children.
const terminalToolRunningAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((toolId: EnvironmentToolId) => {
    const threadId = environmentToolThreadId(toolId);
    return Atom.make(
      (get) =>
        Option.getOrNull(
          AsyncResult.value(get(terminalEnvironment.metadata({ environmentId, input: null }))),
        )?.some(
          (summary) =>
            summary.threadId === threadId &&
            summary.terminalId === ENVIRONMENT_TOOL_TERMINAL_ID &&
            summary.status === "running",
        ) ?? false,
    ).pipe(Atom.withLabel(`sidebar-tool-terminal-running:${environmentId}:${toolId}`));
  }),
);

const NOT_RUNNING_ATOM = Atom.make(false).pipe(Atom.withLabel("sidebar-tool-not-running"));

const hasRuntimeSessions = (runtime: PreviewRuntime) => (state: ThreadPreviewState) =>
  Object.values(state.sessions).some((session) => (session.runtime ?? "desktop") === runtime);
const HAS_RUNTIME_SESSIONS = {
  desktop: hasRuntimeSessions("desktop"),
  server: hasRuntimeSessions("server"),
};

export const SidebarToolsSection = memo(function SidebarToolsSection() {
  const { rows, issues } = useAtomValue(environmentToolRowsAtom);
  const identities = useEnvironmentIdentities();
  const capableIds = useEnvironmentToolsEnvironmentIds();
  const writableIds = useEnvironmentsWithScope(
    capableIds.map((environmentId) => ({ environmentId })),
    AuthSettingsWriteScope,
  );
  const [expanded, setExpanded] = useLocalStorage(TOOLS_EXPANDED_KEY, true, Schema.Boolean);
  const [storedHeight, setStoredHeight] = useLocalStorage(
    TOOLS_HEIGHT_KEY,
    null,
    ToolsHeightSchema,
  );
  const showList = expanded && rows.length > 0;
  const listRef = useRef<HTMLDivElement>(null);
  const { refresh: _refresh, ...resizeHandlers } = useResizeDrag<HTMLDivElement>(() => {
    const list = listRef.current;
    if (!list) return null;
    const viewportHeight = window.innerHeight;
    // Restored rather than removed: a click without a drag stores nothing, so React will not
    // rewrite the rendered size.
    const { height, maxHeight } = list.style;
    return {
      size: list.getBoundingClientRect().height,
      edge: "top",
      resize(value) {
        const next = clampToolsHeight(value / viewportHeight) * viewportHeight;
        list.style.setProperty("max-height", "none");
        list.style.setProperty("height", `${next}px`);
        return next;
      },
      finish(size, moved) {
        if (moved) setStoredHeight(size / viewportHeight);
      },
      cleanup() {
        list.style.maxHeight = maxHeight;
        list.style.height = height;
      },
    };
  }, String(showList));
  const [editor, setEditor] = useState<{
    readonly open: boolean;
    readonly environmentId?: EnvironmentId;
    readonly toolId?: EnvironmentToolId;
  }>({ open: false });
  const activeKey = useParams({
    strict: false,
    select: (params) =>
      params.environmentId === undefined || params.toolId === undefined
        ? null
        : environmentToolRowKey(params.environmentId, params.toolId),
  });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const openTool = useAtomCommand(environmentToolsEnvironment.open, "tool restart");
  const stopTool = useAtomCommand(environmentToolsEnvironment.stop, "tool stop");
  const refreshStatus = useAtomCommand(
    environmentToolsEnvironment.refreshStatus,
    "tool status refresh",
  );
  const removeTool = useRemoveEnvironmentTool();

  const navigateToTool = useStableCallback((row: EnvironmentToolRow) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/tools/$environmentId/$toolId",
      params: { environmentId: row.environmentId, toolId: row.toolId },
    });
  });
  const openToolSettings = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/settings/tools" });
  };
  const showRowMenu = useStableCallback(
    (row: EnvironmentToolRow, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const { environmentId, toolId, definition } = row;
        const input = { toolId, kind: definition.kind };
        const canOperate =
          !row.offline &&
          appAtomRegistry.get(
            environmentToolsEnvironment.open.permissionAtom(environmentId, input),
          );
        const canWrite =
          !row.offline && readEnvironmentScope(environmentId, AuthSettingsWriteScope);
        const items: Array<ContextMenuItem<ToolMenuAction>> = [
          { id: "open", label: "Open" },
          ...(definition.kind === "web"
            ? []
            : [
                { id: "restart" as const, label: "Restart", disabled: !canOperate },
                { id: "stop" as const, label: "Stop", disabled: !canOperate },
              ]),
          ...(definition.status === undefined
            ? []
            : [{ id: "refresh" as const, label: "Refresh status", disabled: row.offline }]),
          { id: "edit", label: "Edit…", disabled: !canWrite, separatorBefore: true },
          { id: "remove", label: "Remove", destructive: true, disabled: !canWrite },
        ];
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "open":
            navigateToTool(row);
            return;
          case "restart":
            await openTool({
              environmentId,
              input: {
                ...input,
                restart: true,
                ...(definition.kind === "browser"
                  ? { runtime: browserToolRuntime(environmentId, definition.target) }
                  : {}),
              },
            });
            return;
          case "stop":
            await stopTool({ environmentId, input });
            return;
          case "refresh":
            await refreshStatus({ environmentId, input: { toolId } });
            return;
          case "edit":
            setEditor({ open: true, environmentId, toolId });
            return;
          case "remove":
            await removeTool(environmentId, toolId, definition.name);
            return;
        }
      })();
    },
  );

  if (rows.length === 0 && issues.size === 0) return null;

  const labelById = new Map(
    identities.map((identity) => [identity.environmentId, identity.label] as const),
  );
  const issueCount = [...issues.values()].reduce((total, list) => total + list.length, 0);

  return (
    <SidebarGroup className="shrink-0" data-testid="sidebar-tools">
      {showList ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize tools"
                className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize touch-none after:absolute after:inset-x-0 after:top-0 after:h-px hover:after:bg-sidebar-border"
                onDoubleClick={() => setStoredHeight(null)}
                {...resizeHandlers}
              />
            }
          />
          <TooltipPopup side="right">Drag to resize, double-click to reset</TooltipPopup>
        </Tooltip>
      ) : null}
      <div className="flex items-center gap-0.5">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            accessory={expanded ? null : <CollapsedToolsTone />}
          >
            Tools
          </CollapsibleSectionHeader>
        </div>
        {issueCount > 0 ? (
          <SidebarHeaderIconButton
            label={`${issueCount} tool ${issueCount === 1 ? "entry needs" : "entries need"} attention`}
            onClick={openToolSettings}
          >
            {/* Wrapped: the button colors its direct svg children. */}
            <span className="text-warning-foreground">
              <TriangleAlertIcon className="size-4" />
            </span>
          </SidebarHeaderIconButton>
        ) : null}
        {writableIds.size > 0 ? (
          <SidebarHeaderIconButton label="Add tool" onClick={() => setEditor({ open: true })}>
            <PlusIcon />
          </SidebarHeaderIconButton>
        ) : null}
      </div>
      {showList ? (
        <ScrollArea
          ref={listRef}
          hideScrollbars
          scrollFade
          className="h-auto"
          style={
            storedHeight === null
              ? { maxHeight: `${DEFAULT_TOOLS_MAX_HEIGHT * 100}vh` }
              : { height: `${clampToolsHeight(storedHeight) * 100}vh` }
          }
        >
          {groupSidebarTools(rows, labelById).map((group) => (
            <div key={group.environmentId}>
              {group.label === null ? null : (
                <p className="truncate px-2 pt-1 pb-0.5 text-3xs font-medium text-sidebar-muted-foreground/60">
                  {group.label}
                </p>
              )}
              <SidebarMenu>
                {group.rows.map((row) => (
                  <SidebarToolRow
                    key={row.toolId}
                    row={row}
                    environmentLabel={labelById.get(row.environmentId) ?? row.environmentId}
                    active={activeKey === environmentToolRowKey(row.environmentId, row.toolId)}
                    onOpen={navigateToTool}
                    onContextMenu={showRowMenu}
                  />
                ))}
              </SidebarMenu>
            </div>
          ))}
        </ScrollArea>
      ) : null}
      <ToolEditorDialog
        open={editor.open}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
        environmentId={editor.environmentId}
        toolId={editor.toolId}
      />
    </SidebarGroup>
  );
});

function CollapsedToolsTone() {
  const tone = useAtomValue(worstToolToneAtom);
  return tone === null ? null : <ToolToneDot tone={tone} />;
}

const SidebarToolRow = memo(function SidebarToolRow(props: {
  row: EnvironmentToolRow;
  environmentLabel: string;
  active: boolean;
  onOpen: (row: EnvironmentToolRow) => void;
  onContextMenu: (row: EnvironmentToolRow, position: { x: number; y: number }) => void;
}) {
  const { row } = props;
  const Icon =
    row.definition.kind === "terminal"
      ? SquareTerminalIcon
      : row.definition.kind === "web"
        ? AppWindowIcon
        : GlobeIcon;
  const button = (
    <SidebarMenuButton
      isActive={props.active}
      aria-current={props.active ? "page" : undefined}
      onClick={() => props.onOpen(row)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(row, { x: event.clientX, y: event.clientY });
      }}
    >
      <span
        className={cn(
          "relative flex shrink-0 text-sidebar-muted-foreground/80",
          row.offline && "opacity-50",
        )}
      >
        <Icon className="size-4" />
        {row.offline || row.definition.kind === "web" ? null : row.definition.kind ===
          "terminal" ? (
          <TerminalToolRunningDot environmentId={row.environmentId} toolId={row.toolId} />
        ) : (
          <BrowserToolRunningDot
            environmentId={row.environmentId}
            toolId={row.toolId}
            target={row.definition.target}
          />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", row.offline && "opacity-50")}>
        {row.definition.name}
      </span>
      {row.offline ? null : <ToolRowBadge row={row} />}
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem>
      {row.offline ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup side="right">{props.environmentLabel} is offline</TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
    </SidebarMenuItem>
  );
});

function ToolRowBadge({ row }: { row: EnvironmentToolRow }) {
  const status = useEnvironmentToolStatus(row.environmentId, row.toolId);
  return <ToolStatusBadge status={status} size="row" description={row.definition.description} />;
}

function RunningDot() {
  return (
    <>
      <span
        aria-hidden
        className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-success ring-1 ring-sidebar"
      />
      <span className="sr-only">Running</span>
    </>
  );
}

function TerminalToolRunningDot(props: {
  environmentId: EnvironmentId;
  toolId: EnvironmentToolId;
}) {
  const canRead = useEnvironmentScope(props.environmentId, AuthTerminalReadScope);
  const running = useAtomValue(
    canRead ? terminalToolRunningAtom(props.environmentId)(props.toolId) : NOT_RUNNING_ATOM,
  );
  return running ? <RunningDot /> : null;
}

// Only the runtime this client opens counts: the other runtime's tab is not what it would show.
function BrowserToolRunningDot(props: {
  environmentId: EnvironmentId;
  toolId: EnvironmentToolId;
  target: BrowserNavigationTarget;
}) {
  const threadRef = scopeThreadRef(props.environmentId, environmentToolThreadId(props.toolId));
  usePreviewSession(threadRef);
  const runtime = browserToolRuntime(props.environmentId, props.target);
  const running = useAtomValue(
    previewStateAtom(scopedThreadKey(threadRef)),
    HAS_RUNTIME_SESSIONS[runtime],
  );
  return running ? <RunningDot /> : null;
}
