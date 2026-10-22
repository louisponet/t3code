import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  EMPTY_TERMINAL_SESSION_STATE,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";
import { AsyncResult } from "effect/reactivity";
import { createContext, useContext } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";

const state = vi.hoisted(() => ({
  sessions: [] as ReadonlyArray<KnownTerminalSession>,
  missingViewers: new Set<string>(),
  erroredViewers: new Set<string>(),
  open: vi.fn(),
  write: vi.fn(),
}));

vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));
vi.mock("~/state/terminal", () => ({
  terminalEnvironment: { open: "open", write: "write" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "open" ? state.open : state.write),
}));
vi.mock("~/state/terminalSessions", () => ({
  useKnownTerminalSessions: () => state.sessions,
  useAttachedTerminalSession: () => {
    const viewer = useContext(ViewerContext);
    const missing = state.missingViewers.has(viewer);
    const error = missing || state.erroredViewers.has(viewer);
    return {
      ...EMPTY_TERMINAL_SESSION_STATE,
      version: 1,
      status: error ? "error" : "running",
      error: error ? "The terminal could not be attached." : null,
      missing,
    };
  },
}));
vi.mock("./ThreadTerminalDrawer", () => ({
  TerminalViewport: ({ terminalId }: { terminalId: string }) => <output>{terminalId}</output>,
}));
vi.mock("./HelixPrControls", () => ({ HelixPrControls: () => null }));

import HelixPanel from "./HelixPanel";

const ViewerContext = createContext("first");

function panel(threadId: ThreadId, viewer: string) {
  return (
    <ViewerContext value={viewer}>
      <HelixPanel
        threadRef={{ environmentId: EnvironmentId.make("helix-recovery"), threadId }}
        cwd="/repo"
        keybindings={[]}
      />
    </ViewerContext>
  );
}

function setup() {
  state.sessions = [];
  state.missingViewers.clear();
  state.erroredViewers.clear();
  state.open.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.write.mockReset().mockResolvedValue(AsyncResult.success(undefined));
}

const shownTerminal = (screen: Screen) => screen.container.querySelector("output")?.textContent;

it("shares one replacement when viewers discover the same missing editor at different times", async () => {
  setup();
  const threadId = ThreadId.make("recovery");
  await using first = await render(panel(threadId, "first"));
  await using second = await render(panel(threadId, "second"));
  expect(state.open).toHaveBeenCalledOnce();
  const originalId = state.open.mock.calls[0]![0].input.terminalId as string;
  await vi.waitFor(() => expect(shownTerminal(first)).toBe(originalId));
  await vi.waitFor(() => expect(shownTerminal(second)).toBe(originalId));

  let finishOpen!: () => void;
  state.open.mockImplementationOnce(
    () => new Promise((resolve) => (finishOpen = () => resolve(AsyncResult.success(undefined)))),
  );
  state.missingViewers.add("first");
  await first.rerender(panel(threadId, "first"));
  expect(state.open).toHaveBeenCalledTimes(2);
  const replacementId = state.open.mock.calls[1]![0].input.terminalId as string;
  expect(replacementId).not.toBe(originalId);

  state.missingViewers.add("second");
  await second.rerender(panel(threadId, "second"));
  expect(state.open).toHaveBeenCalledTimes(2);

  state.missingViewers.clear();
  await act(async () => finishOpen());
  await vi.waitFor(() => expect(shownTerminal(first)).toBe(replacementId));
  await vi.waitFor(() => expect(shownTerminal(second)).toBe(replacementId));
  expect(
    state.write.mock.calls.filter(([request]) => request.input.data.startsWith("exec sh -c ")),
  ).toHaveLength(2);
});

it("keeps the selected editor through a transient attach failure", async () => {
  setup();
  const threadId = ThreadId.make("transient");
  await using screen = await render(panel(threadId, "first"));
  const terminalId = state.open.mock.calls[0]![0].input.terminalId as string;

  state.erroredViewers.add("first");
  await screen.rerender(panel(threadId, "first"));
  await vi.waitFor(() => expect(shownTerminal(screen)).toBe(terminalId));
  expect(state.open).toHaveBeenCalledOnce();

  state.erroredViewers.clear();
  await screen.rerender(panel(threadId, "first"));
  await vi.waitFor(() => expect(shownTerminal(screen)).toBe(terminalId));
  expect(state.open).toHaveBeenCalledOnce();
});
