import {
  EMPTY_TERMINAL_SESSION_STATE,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import {
  EnvironmentId,
  TerminalSessionLookupError,
  type BrowserEnvironmentTool,
  type EnvironmentToolDefinition,
  type EnvironmentToolId,
  type PreviewSessionSnapshot,
  type TerminalEnvironmentTool,
  type TerminalWriteInput,
  type WebEnvironmentTool,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS, isMacPlatform } from "@t3tools/shared/keybindings";
import { injectToolAppBootstrap, TOOL_APP_ESCAPE_MESSAGE_TYPE } from "@t3tools/shared/toolApp";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

const atoms = vi.hoisted(() => ({
  keybindings: { atom: "keybindings" },
  rows: { atom: "rows" },
  presentation: { atom: "presentation" },
  permission: { atom: "permission" },
  attach: { atom: "attach" },
  open: { command: "open" },
  write: { command: "write" },
}));
const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    // Values the page reads through hooks; `update` re-renders their readers.
    row: null as unknown,
    presentation: null as unknown,
    permission: true,
    session: null as unknown,
    preview: null as unknown,
    streamFailure: null as unknown,
    httpBaseUrl: "https://devbox.example/",
    listeners,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    open: vi.fn(),
    write: vi.fn<(request: { input: TerminalWriteInput }) => Promise<unknown>>(),
    otherCommand: vi.fn(),
    navigate: vi.fn(),
  };
});

vi.mock(import("@effect/atom-react"), async (original) => {
  const { DEFAULT_RESOLVED_KEYBINDINGS: keybindings } = await import("@t3tools/shared/keybindings");
  const values = new Map<unknown, unknown>([
    [atoms.keybindings, keybindings],
    [atoms.rows, { rows: [], issues: new Map() }],
  ]);
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useAtomValue: ((atom: unknown, select?: (value: unknown) => unknown) => {
      const value = useSyncExternalStore(state.subscribe, () =>
        atom === atoms.presentation
          ? state.presentation
          : atom === atoms.permission
            ? state.permission
            : (values.get(atom) ?? null),
      );
      return select ? select(value) : value;
    }) as never,
  };
});
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useCanGoBack: () => false,
}));
// The React Compiler memoizes the page, so changes must arrive as a store update.
vi.mock(import("../../state/environmentTools"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const command = (sentinel: object) =>
    Object.assign(sentinel, { permissionAtom: () => atoms.permission });
  return {
    ...(await original()),
    useEnvironmentToolRow: (() => useSyncExternalStore(state.subscribe, () => state.row)) as never,
    useEnvironmentToolStatus: () => undefined,
    environmentToolRowsAtom: atoms.rows as never,
    environmentToolsEnvironment: {
      open: command(atoms.open),
      stop: command({ command: "stop" }),
      refreshStatus: command({ command: "refreshStatus" }),
    } as never,
  };
});
vi.mock(import("../../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationAtom: (() => atoms.presentation) as never,
    },
  };
});
vi.mock(import("../../state/server"), async (original) => ({
  ...(await original()),
  primaryServerKeybindingsAtom: atoms.keybindings as never,
}));
vi.mock(import("../../state/terminal"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    terminalEnvironment: {
      ...actual.terminalEnvironment,
      write: atoms.write as never,
      attach: (() => atoms.attach) as never,
      observe: (() => atoms.attach) as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === atoms.open
      ? state.open
      : command === atoms.write
        ? state.write
        : state.otherCommand) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: null,
    error: null,
    failure: atom === atoms.attach ? state.streamFailure : null,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/terminalSessions"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useAttachedTerminalSession: (() =>
      useSyncExternalStore(state.subscribe, () => state.session)) as never,
  };
});
vi.mock(import("../../previewStateStore"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useThreadPreviewState: (() =>
      useSyncExternalStore(state.subscribe, () => state.preview)) as never,
  };
});
vi.mock(import("../preview/usePreviewSession"), () => ({ usePreviewSession: () => undefined }));
vi.mock(import("../preview/PreviewPanelShell"), () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock(import("../preview/PreviewView"), () => ({
  PreviewView: ({ tabId }: { tabId?: string | null }) => <div data-preview-tab={tabId ?? ""} />,
}));
vi.mock(import("../../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    readEnvironmentScope: () => true,
    useEnvironmentScope: () => true,
    usePreparedConnection: (() => {
      const httpBaseUrl = useSyncExternalStore(state.subscribe, () => state.httpBaseUrl);
      return Option.some({ httpBaseUrl });
    }) as never,
  };
});
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettings: ((select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS)) as never,
}));
vi.mock(import("../../editorPreferences"), async (original) => ({
  ...(await original()),
  useOpenInPreferredEditor: (() => state.otherCommand) as never,
}));
vi.mock(import("./ToolEditorDialog"), () => ({ ToolEditorDialog: () => <></> }));

import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { ToolPage } from "./ToolPage";

const environmentId = EnvironmentId.make("devbox");
const toolId = "lazygit" as EnvironmentToolId;
const tool: TerminalEnvironmentTool = { kind: "terminal", name: "lazygit", command: "lazygit" };
const runningSession: TerminalSessionState = {
  ...EMPTY_TERMINAL_SESSION_STATE,
  status: "running",
  version: 1,
};
// The tool starts at the grid its viewport will show, not the PTY default.
const openRequest = {
  environmentId,
  input: { toolId, kind: "terminal", cols: expect.any(Number), rows: expect.any(Number) },
};

const toolRow = (definition: EnvironmentToolDefinition, offline = false) => ({
  environmentId,
  toolId,
  definition,
  offline,
});
const presentation = (phase: "connected" | "reconnecting" | "offline" | "error") => ({
  entry: { target: { label: "Devbox" } },
  connection: { phase, error: null, traceId: null },
  serverConfig: { environment: { capabilities: { environmentTools: true } } },
});

let root: Root;
let container: HTMLDivElement;
let shellCommands: string[];
let paletteCommands: string[];

// Mirrors the app's capture-phase handlers (sidebar toggle, reopen closed view), which see every
// key before the terminal does.
function recordShellShortcut(event: KeyboardEvent) {
  const command = resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS);
  if (command !== null) shellCommands.push(command);
}
// Mirrors the command palette's bubble-phase handler.
function recordPaletteShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  const command = resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
    context: { terminalFocus: isTerminalFocused() },
  });
  if (command !== null) paletteCommands.push(command);
}

async function render() {
  await act(async () => root.render(<ToolPage environmentId={environmentId} toolId={toolId} />));
}

// The launch measures the viewport's grid first, which waits for the terminal fonts.
async function renderLaunched() {
  await render();
  await vi.waitFor(() => expect(state.open).toHaveBeenCalled());
  await act(async () => {});
}

function press(target: Element, init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

const writtenData = () => state.write.mock.calls.map(([request]) => request.input.data);

async function update(changes: Partial<typeof state>) {
  await act(async () => {
    Object.assign(state, changes);
    for (const listener of state.listeners) listener();
  });
}

const setSession = (session: TerminalSessionState) => update({ session });

const findTerminalInput = () =>
  vi.waitFor(() => {
    const element = container.querySelector<HTMLTextAreaElement>(
      "[data-terminal-owner='tool'] textarea[aria-label='Terminal input']",
    );
    expect(element).not.toBeNull();
    return element!;
  });

const exitedSession: TerminalSessionState = {
  ...runningSession,
  status: "exited",
  version: 2,
  summary: {
    threadId: "tool:lazygit",
    terminalId: "main",
    cwd: "/home/dev",
    worktreePath: null,
    status: "exited",
    pid: null,
    exitCode: 1,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "lazygit",
    updatedAt: "2026-10-20T00:00:00.000Z",
  },
};

beforeEach(() => {
  state.row = toolRow(tool);
  state.presentation = presentation("connected");
  state.permission = true;
  state.session = runningSession;
  state.preview = null;
  state.streamFailure = null;
  state.httpBaseUrl = "https://devbox.example/";
  state.listeners.clear();
  state.open
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ kind: "terminal", threadId: "tool:lazygit", terminalId: "main" }),
    );
  state.write.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.otherCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.navigate.mockReset();
  shellCommands = [];
  paletteCommands = [];
  window.addEventListener("keydown", recordShellShortcut, true);
  window.addEventListener("keydown", recordPaletteShortcut);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.cssText = "display:flex;width:900px;height:600px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.removeEventListener("keydown", recordShellShortcut, true);
  window.removeEventListener("keydown", recordPaletteShortcut);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("gives the focused TUI every key but the palette escape hatch", async () => {
  await renderLaunched();
  expect(state.open).toHaveBeenCalledExactlyOnceWith(openRequest);
  const input = await findTerminalInput();
  // The viewport focuses the surface once its WASM core is up and listening.
  await vi.waitFor(() => expect(document.activeElement).toBe(input));

  for (const key of ["b", "d", "n", "w", "j"]) {
    press(input, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true });
  }
  press(input, { key: "Escape", code: "Escape" });

  await vi.waitFor(() =>
    expect(writtenData()).toEqual(["\u0002", "\u0004", "\u000e", "\u0017", "\n", "\u001b"]),
  );
  expect(shellCommands).toEqual([]);
  expect(paletteCommands).toEqual([]);
  expect(state.navigate).not.toHaveBeenCalled();

  const mod = isMacPlatform(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  press(input, { key: "K", code: "KeyK", shiftKey: true, ...mod });
  expect(paletteCommands).toEqual(["commandPalette.toggle"]);
  expect(writtenData()).toHaveLength(6);
});

it("relaunches from the exit overlay with Enter", async () => {
  await renderLaunched();
  await setSession(exitedSession);

  const overlay = container.querySelector<HTMLElement>("[role='dialog']");
  expect(overlay?.textContent).toContain("lazygit exited (code 1)");
  expect(document.activeElement).toBe(overlay);

  state.open.mockClear();
  await act(async () => press(overlay!, { key: "Enter" }));
  expect(state.open).toHaveBeenCalledExactlyOnceWith(openRequest);
});

it("goes back, without relaunching, on Enter at the overlay's Back button", async () => {
  await renderLaunched();
  await setSession(exitedSession);
  const back = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Back"),
  );
  back!.focus();

  state.open.mockClear();
  await userEvent.keyboard("{Enter}");
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
  expect(state.open).not.toHaveBeenCalled();
});

it("keeps the tool through a reconnect and never restarts one stopped meanwhile", async () => {
  await renderLaunched();
  const input = await findTerminalInput();
  expect(state.open).toHaveBeenCalledOnce();

  await update({ presentation: presentation("offline"), row: toolRow(tool, true) });
  expect(container.querySelector("[role='status']")?.textContent).toBe("Devbox is offline");
  // A failed reconnect attempt drops the session, so permission flips off and back on.
  await update({
    presentation: presentation("reconnecting"),
    row: toolRow(tool, true),
    permission: false,
  });
  expect(container.querySelector("[role='status']")?.textContent).toBe("Reconnecting to Devbox…");
  expect(await findTerminalInput()).toBe(input);

  // Stopped on another device meanwhile: the attach resubscribes and finds no session.
  await update({
    presentation: presentation("connected"),
    row: toolRow(tool),
    permission: true,
    session: { ...runningSession, status: "error", version: 2 },
    streamFailure: new TerminalSessionLookupError({ threadId: "tool:lazygit", terminalId: "main" }),
  });
  expect(container.querySelector("[role='status']")).toBeNull();
  expect(container.querySelector("[role='dialog']")?.textContent).toContain("lazygit is stopped");
  expect(await findTerminalInput()).toBe(input);
  expect(state.open).toHaveBeenCalledOnce();
});

it("shows the environment's failure instead of a tool it cannot reach", async () => {
  await render();
  await findTerminalInput();

  await update({ presentation: presentation("error"), row: toolRow(tool, true) });
  expect(container.querySelector("[data-terminal-owner='tool']")).toBeNull();
  expect(container.textContent).toContain("Devbox is offline.");
});

it("follows the browser tool's replacement tab and shows stopped only once none is left", async () => {
  const browserTool: BrowserEnvironmentTool = {
    kind: "browser",
    name: "Docs",
    target: { kind: "url", url: "https://example.com" },
  };
  const serverTab = (tabId: string) =>
    ({
      threadId: "tool:lazygit",
      tabId,
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      runtime: "server",
      updatedAt: "2026-10-20T00:00:00.000Z",
    }) as PreviewSessionSnapshot;
  const previewWith = (...tabIds: string[]) => ({
    sessions: Object.fromEntries(tabIds.map((tabId) => [tabId, serverTab(tabId)])),
    listLoaded: true,
    serverEpoch: "epoch-1",
  });
  state.row = toolRow(browserTool);
  state.preview = previewWith();
  state.open.mockResolvedValue(
    AsyncResult.success({ kind: "browser", threadId: "tool:lazygit", tabId: "tab-a" }),
  );
  const shownTab = () =>
    container.querySelector("[data-preview-tab]")?.getAttribute("data-preview-tab");

  await render();
  await update({ preview: previewWith("tab-a") });
  expect(shownTab()).toBe("tab-a");

  // Restarted from the sidebar: the server closes tab A and opens tab B on the same epoch.
  await update({ preview: previewWith("tab-b") });
  expect(shownTab()).toBe("tab-b");

  await update({ preview: previewWith() });
  expect(container.textContent).toContain("Docs is stopped.");
  expect(state.open).toHaveBeenCalledOnce();
});

const webTool: WebEnvironmentTool = {
  kind: "web",
  name: "Dashboard",
  target: { kind: "environment-port", port: 3000 },
};
const webOpened = (relativeUrl: string, expiresAt = Date.now() + 12 * 60 * 60_000) =>
  AsyncResult.success({ kind: "web", relativeUrl, expiresAt });
function pendingWebOpen() {
  let resolve!: (result: ReturnType<typeof webOpened>) => void;
  const promise = new Promise<ReturnType<typeof webOpened>>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const shownFrame = () => container.querySelector("iframe");
const reloadWeb = () => {
  const button = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes("Reload"),
  );
  return act(async () => button!.click());
};

it("renders a web app on the selected environment and reloads without terminal controls", async () => {
  state.row = toolRow(webTool);
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/first/"));
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/second/"));

  await render();
  expect(shownFrame()?.src).toBe("https://devbox.example/api/tool-app/first/");
  expect(shownFrame()?.sandbox.contains("allow-same-origin")).toBe(false);
  expect(container.textContent).not.toContain("Restart");
  expect(container.textContent).not.toContain("Stop");

  const initial = shownFrame();
  await reloadWeb();
  expect(shownFrame()).not.toBe(initial);
  expect(shownFrame()?.src).toBe("https://devbox.example/api/tool-app/second/");
  expect(state.open).toHaveBeenCalledTimes(2);
  expect(state.open).toHaveBeenLastCalledWith({
    environmentId,
    input: { toolId, kind: "web" },
  });
});

it("waits for a connected session before opening a web app and relaunches after reconnect", async () => {
  state.row = toolRow(webTool);
  state.presentation = presentation("reconnecting");
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/first/"));
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/reconnected/"));

  await render();
  expect(state.open).not.toHaveBeenCalled();
  expect(shownFrame()).toBeNull();

  await update({ presentation: presentation("connected") });
  expect(shownFrame()?.src).toBe("https://devbox.example/api/tool-app/first/");

  await update({ presentation: presentation("reconnecting"), row: toolRow(webTool, true) });
  await update({ httpBaseUrl: "https://relay.example/environment/" });
  expect(state.open).toHaveBeenCalledOnce();
  expect(shownFrame()).toBeNull();

  await update({ presentation: presentation("connected"), row: toolRow(webTool) });
  expect(shownFrame()?.src).toBe("https://relay.example/api/tool-app/reconnected/");
  expect(state.open).toHaveBeenCalledTimes(2);
});

it("ignores a pending web launch after reload and after permission is revoked", async () => {
  state.row = toolRow(webTool);
  const pending = pendingWebOpen();
  state.open.mockReturnValueOnce(pending.promise);
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/current/"));

  await render();
  expect(container.textContent).toContain("Opening Dashboard…");
  await reloadWeb();
  await act(async () => pending.resolve(webOpened("/api/tool-app/stale/")));
  expect(shownFrame()?.src).toBe("https://devbox.example/api/tool-app/current/");

  const revoked = pendingWebOpen();
  state.open.mockReturnValueOnce(revoked.promise);
  await reloadWeb();
  await update({ permission: false });
  await act(async () => revoked.resolve(webOpened("/api/tool-app/revoked/")));
  expect(shownFrame()).toBeNull();
  expect(container.textContent).toContain("Pair this client again with preview access");

  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/repaired/"));
  await update({ permission: true });
  expect(shownFrame()?.src).toBe("https://devbox.example/api/tool-app/repaired/");
});

it("recovers a failed web launch with Reload and uses a new connection origin", async () => {
  state.row = toolRow(webTool);
  state.open.mockResolvedValueOnce(AsyncResult.success({ kind: "browser", tabId: "wrong-kind" }));
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/recovered/"));
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/remote/"));

  await render();
  expect(container.textContent).toContain("Couldn't open Dashboard.");
  await reloadWeb();
  expect(shownFrame()?.src).toBe("https://devbox.example/api/tool-app/recovered/");

  await update({ httpBaseUrl: "https://relay.example/environment/" });
  expect(shownFrame()?.src).toBe("https://relay.example/api/tool-app/remote/");
});

it("renames a web app without reopening its frame", async () => {
  state.row = toolRow(webTool);
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/first/"));
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/reopened/"));
  await render();
  const initial = shownFrame();

  await update({ row: toolRow({ ...webTool, name: "Metrics" }) });
  expect(shownFrame()).toBe(initial);
  expect(shownFrame()?.title).toBe("Metrics");
  expect(state.open).toHaveBeenCalledOnce();
});

it("opens the edited web target and discards the previous target's pending response", async () => {
  state.row = toolRow(webTool);
  const pending = pendingWebOpen();
  state.open.mockReturnValueOnce(pending.promise);
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/edited/"));
  await render();

  await update({ row: toolRow({ ...webTool, target: { kind: "environment-port", port: 4000 } }) });
  await act(async () => pending.resolve(webOpened("/api/tool-app/outdated/")));
  expect(shownFrame()?.src).toBe("https://devbox.example/api/tool-app/edited/");
  expect(state.open).toHaveBeenCalledTimes(2);
});

it("re-mints the web frame before expiry and cancels renewal on permission loss", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  state.row = toolRow(webTool);
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/first/", Date.now() + 120_000));
  state.open.mockResolvedValueOnce(webOpened("/api/tool-app/renewed/", Date.now() + 240_000));

  await render();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(shownFrame()?.src).toBe("https://devbox.example/api/tool-app/renewed/");
  await update({ permission: false });
  await act(async () => vi.advanceTimersByTimeAsync(240_000));
  expect(state.open).toHaveBeenCalledTimes(2);
  expect(shownFrame()).toBeNull();
});

it("returns the focused web app's palette escape to T3 and ignores other message sources", async () => {
  const html = injectToolAppBootstrap("<html><body><button autofocus>App</button></body></html>");
  state.row = toolRow(webTool);
  state.open.mockResolvedValue(webOpened(`data:text/html,${encodeURIComponent(html)}`));
  await render();
  const frame = shownFrame()!;
  await new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  frame.focus();
  expect(isTerminalFocused()).toBe(true);

  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: { type: TOOL_APP_ESCAPE_MESSAGE_TYPE },
    }),
  );
  expect(paletteCommands).toEqual([]);

  const mod = isMacPlatform(navigator.platform) ? "Meta" : "Control";
  await userEvent.keyboard(`{${mod}>}{Shift>}K{/Shift}{/${mod}}`);
  await vi.waitFor(() => expect(paletteCommands).toEqual(["commandPalette.toggle"]));

  container.querySelector("button")!.focus();
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: { type: TOOL_APP_ESCAPE_MESSAGE_TYPE },
    }),
  );
  expect(paletteCommands).toHaveLength(1);
});
