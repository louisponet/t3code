import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isUnknownUnionMember,
  type EnvironmentId,
  type EnvironmentToolId,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { isToolAppEscapeMessage } from "@t3tools/shared/toolApp";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { resolveAssetUrl } from "../../assets/assetUrls";
import { environmentToolsEnvironment } from "../../state/environmentTools";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ToolViewMessage } from "./ToolBrowserView";

type FrameState =
  | { readonly state: "opening" }
  | { readonly state: "ready"; readonly src: string }
  | { readonly state: "error"; readonly message: string };

// Reload before expiry so subresource requests keep using a valid token.
const REMINT_AHEAD_MS = 60_000;

export function ToolWebAppView(props: {
  readonly environmentId: EnvironmentId;
  readonly toolId: EnvironmentToolId;
  readonly toolName: string;
  readonly reloadEpoch: number;
  readonly connected: boolean;
}) {
  const { environmentId, toolId } = props;
  const canOpen = useAtomValue(
    environmentToolsEnvironment.open.permissionAtom(environmentId, { toolId, kind: "web" }),
  );
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const [attempt, setAttempt] = useState(0);
  if (!canOpen) {
    return (
      <ToolViewMessage>
        Pair this client again with preview access to open web tools.
      </ToolViewMessage>
    );
  }
  if (!props.connected || httpBaseUrl === null)
    return <ToolViewMessage>Connecting to {props.toolName}…</ToolViewMessage>;
  return (
    <ToolWebAppSession
      key={JSON.stringify([environmentId, toolId, httpBaseUrl, props.reloadEpoch, attempt])}
      environmentId={environmentId}
      toolId={toolId}
      toolName={props.toolName}
      httpBaseUrl={httpBaseUrl}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

function ToolWebAppSession(props: {
  readonly environmentId: EnvironmentId;
  readonly toolId: EnvironmentToolId;
  readonly toolName: string;
  readonly httpBaseUrl: string;
  readonly onRetry: () => void;
}) {
  const open = useAtomCommand(environmentToolsEnvironment.open, { reportFailure: false });
  const requestOpen = useEffectEvent(() =>
    open({ environmentId: props.environmentId, input: { toolId: props.toolId, kind: "web" } }),
  );
  const openFailureMessage = useEffectEvent(() => `Couldn't open ${props.toolName}.`);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frame, setFrame] = useState<FrameState>({ state: "opening" });

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const launch = async () => {
      const result = await requestOpen();
      if (disposed) return;
      if (result._tag === "Success") {
        if (!isUnknownUnionMember(result.value) && result.value.kind === "web") {
          const src = resolveAssetUrl(props.httpBaseUrl, result.value.relativeUrl);
          if (src !== null) {
            setFrame({ state: "ready", src });
            const delay = Math.max(0, result.value.expiresAt - REMINT_AHEAD_MS - Date.now());
            timer = setTimeout(() => void launch(), delay);
            return;
          }
        }
        setFrame({ state: "error", message: openFailureMessage() });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setFrame({
        state: "error",
        message: failure instanceof Error ? failure.message : openFailureMessage(),
      });
    };
    void launch();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [props.httpBaseUrl]);

  // The injected bootstrap reports mod+shift+k; replay it here, where the
  // frame's tool focus makes it resolve to the command palette.
  useEffect(() => {
    const replayEscape = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        !isToolAppEscapeMessage(event.data)
      ) {
        return;
      }
      const mac = isMacPlatform(navigator.platform);
      frame.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          metaKey: mac,
          ctrlKey: !mac,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    window.addEventListener("message", replayEscape);
    return () => window.removeEventListener("message", replayEscape);
  }, []);

  if (frame.state === "error") {
    return (
      <ToolViewMessage>
        {frame.message}
        <Button variant="outline" size="sm" onClick={props.onRetry}>
          Try again
        </Button>
      </ToolViewMessage>
    );
  }
  if (frame.state === "opening")
    return <ToolViewMessage>Opening {props.toolName}…</ToolViewMessage>;
  return (
    <iframe
      ref={frameRef}
      key={frame.src}
      src={frame.src}
      title={props.toolName}
      data-terminal-owner="tool"
      // An opaque origin keeps the app away from T3's session and DOM.
      sandbox="allow-scripts allow-forms allow-popups allow-downloads"
      allow="clipboard-write"
      className="min-h-0 flex-1 border-0"
    />
  );
}
