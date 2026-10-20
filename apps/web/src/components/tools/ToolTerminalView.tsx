import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TerminalSessionState } from "@t3tools/client-runtime/state/terminal";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  ENVIRONMENT_TOOL_TERMINAL_ID,
  environmentToolThreadId,
  TerminalSessionLookupError,
  type EnvironmentId,
  type EnvironmentToolId,
  type TerminalEnvironmentTool,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { isElectron } from "../../env";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNavigateBack } from "../../hooks/useNavigateBack";
import { resolveShortcutCommand } from "../../keybindings";
import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentToolsEnvironment } from "../../state/environmentTools";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAttachedTerminalSession } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { fittedTerminalGrid } from "../../terminal/ghostty/surface";
import { TerminalViewport, useTerminalFont } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const isTerminalSessionLookupError = Schema.is(TerminalSessionLookupError);

interface ToolTerminalViewProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly toolId: EnvironmentToolId;
  readonly tool: TerminalEnvironmentTool;
}

/** Ensures the tool runs (when this device may start it), then attaches to its one PTY. */
export function ToolTerminalView(props: ToolTerminalViewProps) {
  const { environmentId, toolId } = props;
  const canOpen = useAtomValue(
    environmentToolsEnvironment.open.permissionAtom(environmentId, { toolId, kind: "terminal" }),
  );
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const open = useAtomCommand(environmentToolsEnvironment.open, { reportFailure: false });
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const font = useTerminalFont(advancedTypography);
  const boxRef = useRef<HTMLDivElement>(null);

  const launch = async (): Promise<boolean> => {
    // A TUI that is still starting misses the resize to the viewport's size, so it starts there.
    const grid = boxRef.current === null ? null : await fittedTerminalGrid(boxRef.current, font);
    const result = await open({
      environmentId,
      input: { toolId, kind: "terminal", ...grid },
    });
    if (result._tag === "Success") {
      setOpened(true);
      setError(null);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : `Couldn't start ${props.tool.name}.`);
    }
    return false;
  };
  // Only the first grant starts the tool: a reconnect can flip permission off and back on, and
  // relaunching then would resurrect a tool another device stopped or one that exited.
  const launchRequested = useRef(false);
  const launchOnPermission = useEffectEvent(() => {
    if (launchRequested.current) return;
    launchRequested.current = true;
    void launch();
  });
  useEffect(() => {
    if (canOpen) launchOnPermission();
  }, [canOpen]);

  if (error !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-md text-sm text-muted-foreground">{error}</p>
        {canOpen ? (
          <Button variant="outline" size="sm" onClick={() => void launch()}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  if (!canRead) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          Pair this client again with terminal access to view this tool.
        </p>
      </div>
    );
  }
  return (
    <div ref={boxRef} className="relative min-h-0 flex-1">
      {/* Read-only devices observe whatever is running; they never start the tool. */}
      {canOpen && !opened ? null : (
        <ToolTerminalSession
          {...props}
          advancedTypography={advancedTypography}
          canOpen={canOpen}
          launch={launch}
        />
      )}
    </div>
  );
}

function ToolTerminalSession({
  environmentId,
  environmentLabel,
  toolId,
  tool,
  advancedTypography,
  canOpen,
  launch,
}: ToolTerminalViewProps & {
  readonly advancedTypography: boolean;
  readonly canOpen: boolean;
  readonly launch: () => Promise<boolean>;
}) {
  const terminal = {
    threadId: environmentToolThreadId(toolId),
    terminalId: ENVIRONMENT_TOOL_TERMINAL_ID,
  };
  const threadRef = { environmentId, threadId: terminal.threadId };
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const refreshStatus = useAtomCommand(environmentToolsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const session = useAttachedTerminalSession({ environmentId, terminal });
  // The same stream the viewport renders, read for its typed failure and to restart it.
  const stream = useEnvironmentQuery(
    (canOperateTerminal ? terminalEnvironment.attach : terminalEnvironment.observe)({
      environmentId,
      input: terminal,
    }),
  );
  const refreshStream = useEffectEvent(() => stream.refresh());
  const lookupFailed = isTerminalSessionLookupError(stream.failure);
  const attached = session.version > 0;
  const running = attached && session.status === "running";

  const [relaunching, setRelaunching] = useState(false);
  if (relaunching && running) setRelaunching(false);
  const [focusRequestId, setFocusRequestId] = useState(1);

  const relaunch = async () => {
    setRelaunching(true);
    if (await launch()) setFocusRequestId((id) => id + 1);
    else setRelaunching(false);
  };

  // A failed stream has ended; attach again once the session runs, whoever started it.
  const sessionListed = session.summary?.status === "running";
  useEffect(() => {
    if (lookupFailed && sessionListed) refreshStream();
  }, [lookupFailed, sessionListed]);

  // A failed lookup means the session is gone, whether someone stopped it or the server
  // restarted. Nothing here tells those apart, so it never starts the tool again on its own.
  const overlay = relaunching
    ? null
    : attached && session.status === "exited"
      ? "exited"
      : (attached && session.status === "closed") || lookupFailed
        ? "stopped"
        : null;

  const beforeKey = (event: KeyboardEvent) =>
    resolveShortcutCommand(event, keybindings, {
      context: { terminalFocus: true, terminalOpen: true, toolFocus: true },
    }) === null;

  const openLink = (url: string) => {
    const target = URL.parse(url);
    if (
      target !== null &&
      isLoopbackHost(target.hostname) &&
      !(isElectron && environmentId === primaryEnvironmentId)
    ) {
      const id = toastManager.add({
        type: "info",
        title: `${target.host} runs on ${environmentLabel}`,
        description: "Add it as a browser tool to open it here.",
        actionProps: {
          children: "Copy",
          onClick: () => {
            toastManager.close(id);
            void writeTextToClipboard(url, "link").catch(() => undefined);
          },
        },
      });
      return;
    }
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to open link",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
  };

  return (
    <>
      <div data-terminal-owner="tool" className="absolute inset-0">
        <TerminalViewport
          advancedTypography={advancedTypography}
          threadRef={threadRef}
          threadId={terminal.threadId}
          terminalId={terminal.terminalId}
          terminalLabel={tool.name}
          onSessionExited={() => {
            if (tool.status) void refreshStatus({ environmentId, input: { toolId } });
          }}
          focusRequestId={focusRequestId}
          autoFocus
          visible
          resizeEpoch={0}
          drawerHeight={0}
          keybindings={keybindings}
          beforeKey={beforeKey}
          onOpenLink={openLink}
        />
      </div>
      {overlay === null ? null : (
        <ToolTerminalOverlay
          message={
            overlay === "stopped"
              ? `${tool.name} is stopped`
              : exitMessage(tool.name, session.summary)
          }
          action={overlay === "stopped" ? "Start" : "Relaunch"}
          canRun={canOpen}
          onRun={() => void relaunch()}
        />
      )}
    </>
  );
}

function exitMessage(name: string, summary: TerminalSessionState["summary"]): string {
  if (summary?.exitCode != null) return `${name} exited (code ${summary.exitCode})`;
  if (summary?.exitSignal != null) return `${name} exited (signal ${summary.exitSignal})`;
  return `${name} exited`;
}

/** Sits outside the terminal's focus owner so app shortcuts work again while it shows. */
function ToolTerminalOverlay(props: {
  readonly message: string;
  readonly action: string;
  readonly canRun: boolean;
  readonly onRun: () => void;
}) {
  const goBack = useNavigateBack();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={props.message}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 outline-none"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        // Enter on a focused button keeps its own action.
        const onOverlay = event.target === event.currentTarget;
        if (event.key === "Enter" && onOverlay && props.canRun) props.onRun();
        else if (event.key === "Escape") goBack();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="flex flex-col items-center gap-3 rounded-lg border bg-popover p-5 text-center shadow-lg">
        <p className="text-sm font-medium text-foreground">{props.message}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={goBack}>
            Back
            <kbd className="text-muted-foreground">Esc</kbd>
          </Button>
          <Button size="sm" disabled={!props.canRun} onClick={props.onRun}>
            {props.action}
            <kbd className="opacity-70">Enter</kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}
