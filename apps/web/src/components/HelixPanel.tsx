import { useHelixLocationDelivery } from "./chat/useHelixLocationDelivery";
import { useHelixReviewController } from "./chat/useHelixReviewController";
import { rememberHelixInitialLocation } from "./chat/helixInitialLocation";
import { helixStartupText, isHelixLaunchAwaitingClose } from "./chat/helixStartup";
import { useThreadShell } from "~/state/entities";
import { HelixPrControls } from "./HelixPrControls";
import { randomUUID } from "~/lib/utils";
import {
  useEffect,
  useLayoutEffect,
  useEffectEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  findOpenHelixReviewTerminal,
  helixReviewCommand,
  newHelixReviewTerminalId,
  type HelixOpenOptions,
} from "@t3tools/client-runtime/helix-review";
import {
  encodeHelixReviewDiscovery,
  parseHelixReviewMarkers,
  resolveHelixReviewReadyNonce,
  resolveHelixReviewState,
  type HelixReviewAction,
  type HelixReviewState,
} from "@t3tools/client-runtime/helix-review-control";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
} from "@t3tools/client-runtime/state/terminal";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAttachedTerminalSession, useKnownTerminalSessions } from "~/state/terminalSessions";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { terminalEnvironment } from "~/state/terminal";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { Button } from "./ui/button";

// A code tab is a view onto the editor, not ownership of its process. Remounting
// another file or review must keep the editor and unsaved buffers alive.
const EMPTY_OPTIONS: HelixOpenOptions = {};
const editors = new Map<string, Promise<{ terminalId: string }>>();

export default function HelixPanel({
  threadRef,
  cwd,
  worktreePath,
  options = EMPTY_OPTIONS,
  keybindings,
  requestId = 0,
}: {
  threadRef: ScopedThreadRef;
  cwd: string;
  worktreePath?: string | null | undefined;
  options?: HelixOpenOptions;
  keybindings: ResolvedKeybindingsConfig;
  requestId?: number;
}) {
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const sessions = useKnownTerminalSessions(threadRef);
  const open = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const write = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const [editorOwner, setEditorOwner] = useState<{
    key: string;
    editor: { terminalId: string };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const targetJson = JSON.stringify(options);
  const launchRequest = useEffectEvent(() => ({
    cwd,
    worktreePath,
    threadRef,
    targetJson,
    open,
    write,
  }));
  const key = JSON.stringify([threadRef.environmentId, threadRef.threadId, worktreePath ?? cwd]);
  const editor = editorOwner?.key === key ? editorOwner.editor : null;
  useEffect(() => {
    if (!canRead || !canOperate || sessions === null) return;
    void retry;
    const { cwd, worktreePath, threadRef, targetJson, open, write } = launchRequest();
    let cancelled = false;
    let pending = editors.get(key);
    if (!pending) {
      const existing = findOpenHelixReviewTerminal(
        sessions.filter(
          (entry) =>
            (entry.state.summary?.worktreePath ?? entry.state.summary?.cwd) ===
            (worktreePath ?? cwd),
        ),
      );
      pending = (async () => {
        if (existing) return { terminalId: existing };
        const terminalId = newHelixReviewTerminalId(randomUUID());
        const result = await open({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            terminalId,
            cwd,
            ...(worktreePath ? { worktreePath } : {}),
            cols: 100,
            rows: 32,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const sent = await write({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            terminalId,
            data: `${helixReviewCommand(threadRef.threadId, threadRef.environmentId, JSON.parse(targetJson))}\n`,
          },
        });
        if (sent._tag === "Failure") throw squashAtomCommandFailure(sent);
        rememberHelixInitialLocation(terminalId, targetJson);
        return { terminalId };
      })();
      editors.set(key, pending);
      void pending.catch(() => {
        if (editors.get(key) === pending) editors.delete(key);
      });
    }
    void pending.then(
      (value) => {
        const known = sessions.find((entry) => entry.target.terminalId === value.terminalId);
        if (known && known.state.status !== "running") {
          if (editors.get(key) === pending) editors.delete(key);
          if (!cancelled) setRetry((value) => value + 1);
          return;
        }
        if (!cancelled) setEditorOwner({ key, editor: value });
      },
      (failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, canRead, canOperate, sessions, retry]);
  if (!canRead || !canOperate)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Helix needs terminal read and operate access on this connection.
      </p>
    );
  if (error)
    return (
      <div role="alert" className="p-4 text-sm">
        <p>{error}</p>
        <Button
          onClick={() => {
            setError(null);
            setRetry((value) => value + 1);
          }}
        >
          Retry Helix
        </Button>
      </div>
    );
  if (!editor) return <p className="p-4 text-sm text-muted-foreground">Opening Helix…</p>;
  return (
    <HelixSession
      key={`${key}:${editor.terminalId}`}
      threadRef={threadRef}
      cwd={cwd}
      worktreePath={worktreePath}
      editor={editor}
      targetJson={targetJson}
      requestId={requestId}
      keybindings={keybindings}
      onExit={() => {
        editors.delete(key);
        setEditorOwner(null);
        setError("Helix exited. Reopen it to continue editing.");
      }}
    />
  );
}

function HelixSession({
  threadRef,
  cwd,
  worktreePath,
  editor,
  targetJson,
  requestId,
  keybindings,
  onExit,
}: {
  threadRef: ScopedThreadRef;
  cwd: string;
  worktreePath: string | null | undefined;
  editor: { terminalId: string };
  targetJson: string;
  requestId: number;
  keybindings: ResolvedKeybindingsConfig;
  onExit: () => void;
}) {
  const session = useAttachedTerminalSession({
    environmentId: threadRef.environmentId,
    terminal: {
      threadId: threadRef.threadId,
      terminalId: editor.terminalId,
      cwd,
      ...(worktreePath ? { worktreePath } : {}),
    },
  });
  const write = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const thread = useThreadShell(threadRef);
  const controllerRef = useHelixReviewController(randomUUID);
  const output = useMemo(() => {
    const update = readTerminalOutputUpdate(session.output, INITIAL_TERMINAL_OUTPUT_CURSOR);
    return update.type === "none" ? "" : update.data;
  }, [session.output]);
  const markers = useMemo(() => parseHelixReviewMarkers(output), [output]);

  const lifecycle = `${session.lifecycleVersion}:${session.output.generation}`;
  const [readiness, setReadiness] = useState<{ lifecycle: string; nonce: string | null }>({
    lifecycle,
    nonce: null,
  });
  const nonce = resolveHelixReviewReadyNonce(
    markers,
    readiness.lifecycle === lifecycle ? readiness.nonce : null,
  );
  if (readiness.lifecycle !== lifecycle || readiness.nonce !== nonce)
    setReadiness({ lifecycle, nonce });
  const [cachedState, setCachedState] = useState<{
    lifecycle: string;
    state: HelixReviewState | null;
  }>({ lifecycle, state: null });
  const state = resolveHelixReviewState(
    markers,
    nonce,
    cachedState.lifecycle === lifecycle ? cachedState.state : null,
  );
  if (cachedState.lifecycle !== lifecycle || cachedState.state !== state)
    setCachedState({ lifecycle, state });
  const target =
    nonce === null
      ? null
      : {
          ...threadRef,
          terminalId: editor.terminalId,
          lifecycleVersion: session.lifecycleVersion,
          attachGeneration: session.output.generation,
          nonce,
        };
  const targetRef = useRef(target);
  useLayoutEffect(() => {
    targetRef.current = target;
  });
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const discovered = useRef<string | null>(null);
  useEffect(() => {
    if (session.status !== "running" || session.version === 0 || discovered.current === lifecycle)
      return;
    discovered.current = lifecycle;
    void write({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId: editor.terminalId,
        data: encodeHelixReviewDiscovery(),
      },
    });
  }, [
    lifecycle,
    session.status,
    session.version,
    write,
    threadRef.environmentId,
    threadRef.threadId,
    editor.terminalId,
  ]);
  useEffect(() => {
    controllerRef.current?.update(target, markers);
  });
  const send = useCallback(
    async (action: HelixReviewAction, text?: string) => {
      const controller = controllerRef.current;
      if (!controller)
        throw new Error("The HX editor is still connecting. Retry after it is ready.");
      const retry = controller.getRetry();
      if (retry && (retry.action !== action || retry.text !== text))
        throw new Error(
          "Retry the previous HX action before starting another action; its delivery has not been confirmed.",
        );
      const captured = targetRef.current;
      if (!captured)
        throw new Error(
          "Helix is still starting. If it does not become ready, run hx-t3 setup on this environment.",
        );
      setBusy(true);
      try {
        const id = await controller.send(captured, action, text, async (data) => {
          if (
            targetRef.current?.nonce !== captured.nonce ||
            targetRef.current?.lifecycleVersion !== captured.lifecycleVersion ||
            targetRef.current?.attachGeneration !== captured.attachGeneration
          )
            return false;
          const result = await write({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, terminalId: editor.terminalId, data },
          });
          return result._tag === "Success";
        });
        if (controllerRef.current === controller) setError(null);
        return id;
      } finally {
        if (controllerRef.current === controller) setBusy(false);
      }
    },
    [controllerRef, write, threadRef.environmentId, threadRef.threadId, editor.terminalId],
  );
  useHelixLocationDelivery({
    controllerRef,
    terminalId: editor.terminalId,
    targetJson,
    requestId,
    lifecycle,
    ready: nonce !== null && state !== null,
    canOpenFile: state?.canOpenFile,
    canOpenSnapshot: state?.canOpenSnapshot,
    send,
    onError: setError,
  });
  const run = (action: HelixReviewAction, value?: string) => {
    void send(action, value).catch((failure) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  };
  const submitText = (action: "comment" | "ask") => {
    void send(action, text)
      .then(() => setText(""))
      .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  };
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 p-1 text-xs">
        <span className="px-2 font-medium">Helix</span>
        <Button size="xs" disabled={!target || busy} onClick={() => run("files")}>
          Files
        </Button>
        <Button size="xs" disabled={!target || busy} onClick={() => run("previous")}>
          Previous
        </Button>
        <Button size="xs" disabled={!target || busy} onClick={() => run("next")}>
          Next
        </Button>
        <Button size="xs" disabled={!state?.canStage || busy} onClick={() => run("stage")}>
          Stage
        </Button>
        <Button
          size="xs"
          disabled={!state?.canMarkReviewed || busy}
          onClick={() => run(state?.reviewed ? "unmark-reviewed" : "mark-reviewed")}
        >
          {state?.reviewed ? "Unmark reviewed" : "Mark reviewed"}
        </Button>
        <span className="text-muted-foreground">
          {state ? `${state.reviewedCount}/${state.totalCount} reviewed` : "Connecting to HX…"}
        </span>
      </div>
      {!nonce ? (
        <div
          role="status"
          className="max-h-48 shrink-0 overflow-auto border-b border-border/60 p-2 text-xs"
        >
          <p>
            {session.error ??
              "Waiting for Helix. If setup is required, run hx-t3 setup on this environment and reopen the editor."}
          </p>
          <pre className="whitespace-pre-wrap break-words">{helixStartupText(output)}</pre>
          <Button
            size="xs"
            onClick={() => {
              void write({
                environmentId: threadRef.environmentId,
                input: {
                  threadId: threadRef.threadId,
                  terminalId: editor.terminalId,
                  data: encodeHelixReviewDiscovery(),
                },
              });
            }}
          >
            Retry HX connection
          </Button>
          {isHelixLaunchAwaitingClose(output) ? (
            <Button
              size="xs"
              onClick={() => {
                void write({
                  environmentId: threadRef.environmentId,
                  input: {
                    threadId: threadRef.threadId,
                    terminalId: editor.terminalId,
                    data: "\n",
                  },
                });
              }}
            >
              Close failed launch
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="shrink-0 p-2 text-xs text-destructive">
          <p>{error}</p>
          <Button
            size="xs"
            disabled={busy || !target}
            onClick={() => {
              const retry = controllerRef.current?.getRetry();
              if (retry) run(retry.action, retry.text);
              else run("open-file", targetJson);
            }}
          >
            Retry HX action
          </Button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <TerminalViewport
          advancedTypography={false}
          threadRef={threadRef}
          threadId={threadRef.threadId}
          terminalId={editor.terminalId}
          terminalLabel="Helix"
          cwd={cwd}
          worktreePath={worktreePath ?? null}
          onSessionExited={onExit}
          focusRequestId={requestId}
          autoFocus
          visible
          resizeEpoch={0}
          drawerHeight={0}
          keybindings={keybindings}
        />
      </div>
      <form
        className="flex shrink-0 flex-col gap-1 border-t border-border/60 p-1"
        onSubmit={(event) => {
          event.preventDefault();
          submitText("comment");
        }}
      >
        <input
          aria-label="Comment or question about the selected code"
          className="w-full min-w-0 bg-transparent px-2 py-1 text-xs outline-none"
          placeholder="Comment or ask about the selected code…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex w-full flex-wrap items-center gap-1">
          <Button size="xs" type="submit" disabled={!state?.canComment || !text.trim() || busy}>
            Comment
          </Button>
          <Button
            size="xs"
            disabled={!target || state?.canAsk === false || !text.trim() || busy}
            onClick={() => submitText("ask")}
          >
            Ask
          </Button>
          <Button
            size="xs"
            disabled={!state?.pendingCommentCount || busy}
            onClick={() => run("discard-last-comment")}
          >
            Undo comment
          </Button>
          <Button
            size="xs"
            disabled={!target || state?.canSend === false || busy}
            onClick={() => run("send")}
          >
            Send{state?.pendingCommentCount ? ` (${state.pendingCommentCount})` : ""}
          </Button>
        </div>
      </form>
      {state?.canReviewPr && target && thread ? (
        <HelixPrControls
          key={target.nonce}
          target={target}
          projectId={thread.projectId}
          markers={markers}
          send={send}
        />
      ) : null}
    </div>
  );
}
