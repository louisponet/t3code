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
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS, isMacPlatform } from "@t3tools/shared/keybindings";
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
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
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
const openRequest = { environmentId, input: { toolId, kind: "terminal" } };

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
});

it("gives the focused TUI every key but the palette escape hatch", async () => {
  await render();
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
  await render();
  await setSession(exitedSession);

  const overlay = container.querySelector<HTMLElement>("[role='dialog']");
  expect(overlay?.textContent).toContain("lazygit exited (code 1)");
  expect(document.activeElement).toBe(overlay);

  state.open.mockClear();
  await act(async () => press(overlay!, { key: "Enter" }));
  expect(state.open).toHaveBeenCalledExactlyOnceWith(openRequest);
});

it("goes back, without relaunching, on Enter at the overlay's Back button", async () => {
  await render();
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
  await render();
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
