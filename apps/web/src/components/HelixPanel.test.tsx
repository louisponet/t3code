import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  EMPTY_TERMINAL_SESSION_STATE,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";
import { AsyncResult } from "effect/reactivity";
import { createContext, useContext } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
const renderers: ReactTestRenderer[] = [];
let nextThreadId = 0;

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

beforeEach(() => {
  state.sessions = [];
  state.missingViewers.clear();
  state.erroredViewers.clear();
  state.open.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.write.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
  vi.unstubAllGlobals();
});

it("shares one replacement when viewers discover the same missing editor at different times", async () => {
  const threadId = ThreadId.make(`recovery-${++nextThreadId}`);
  let first!: ReactTestRenderer;
  let second!: ReactTestRenderer;
  await act(async () => {
    first = create(panel(threadId, "first"));
    second = create(panel(threadId, "second"));
    renderers.push(first, second);
  });
  expect(state.open).toHaveBeenCalledOnce();
  const originalId = state.open.mock.calls[0]![0].input.terminalId as string;
  expect(first.root.findByType("output").children).toEqual([originalId]);
  expect(second.root.findByType("output").children).toEqual([originalId]);

  let finishOpen!: () => void;
  state.open.mockImplementationOnce(
    () => new Promise((resolve) => (finishOpen = () => resolve(AsyncResult.success(undefined)))),
  );
  state.missingViewers.add("first");
  await act(async () => first.update(panel(threadId, "first")));
  expect(state.open).toHaveBeenCalledTimes(2);
  const replacementId = state.open.mock.calls[1]![0].input.terminalId as string;
  expect(replacementId).not.toBe(originalId);

  state.missingViewers.add("second");
  await act(async () => second.update(panel(threadId, "second")));
  expect(state.open).toHaveBeenCalledTimes(2);

  state.missingViewers.clear();
  await act(async () => finishOpen());
  expect(first.root.findByType("output").children).toEqual([replacementId]);
  expect(second.root.findByType("output").children).toEqual([replacementId]);
  expect(
    state.write.mock.calls.filter(([request]) => request.input.data.startsWith("exec sh -c ")),
  ).toHaveLength(2);
});

it("keeps the selected editor through a transient attach failure", async () => {
  const threadId = ThreadId.make(`transient-${++nextThreadId}`);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(panel(threadId, "first"));
    renderers.push(renderer);
  });
  const terminalId = state.open.mock.calls[0]![0].input.terminalId as string;

  state.erroredViewers.add("first");
  await act(async () => renderer.update(panel(threadId, "first")));
  expect(renderer.root.findByType("output").children).toEqual([terminalId]);
  expect(state.open).toHaveBeenCalledOnce();

  state.erroredViewers.clear();
  await act(async () => renderer.update(panel(threadId, "first")));
  expect(renderer.root.findByType("output").children).toEqual([terminalId]);
  expect(state.open).toHaveBeenCalledOnce();
});
