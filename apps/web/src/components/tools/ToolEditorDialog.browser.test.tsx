import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({ writable: new Set<string>() }));

vi.mock(import("../../state/environmentTools"), async (original) => ({
  ...(await original()),
  useEnvironmentToolsEnvironmentIds: () => ["primary", "devbox"] as never,
  environmentToolRowsAtom: Atom.make({ rows: [], issues: new Map() }) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => "primary" as never,
  useEnvironments: (() => ({
    environments: [
      { environmentId: "primary", label: "Laptop", serverConfig: null },
      { environmentId: "devbox", label: "Devbox", serverConfig: null },
    ],
  })) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: EnvironmentId | null, scope: string) =>
    scope === "settings:write" && environmentId !== null && state.writable.has(environmentId);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import { ToolEditorDialog } from "./ToolEditorDialog";

let root: Root;
let container: HTMLDivElement;

const render = () =>
  act(async () => root.render(<ToolEditorDialog open onOpenChange={() => {}} />));
const runsOn = () => page.getByRole("combobox", { name: "Runs on" });
const addButton = () => page.getByRole("button", { name: "Add tool" });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.writable = new Set(["devbox"]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("starts a new tool on a writable environment when the primary one is read-only", async () => {
  await render();

  await expect.element(runsOn()).toHaveTextContent("Devbox");
  await expect.element(addButton()).toBeEnabled();
});

it("keeps the environment picker usable after choosing a read-only environment", async () => {
  await render();

  await userEvent.click(runsOn());
  await userEvent.click(page.getByRole("option", { name: "Laptop" }));
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("This connection cannot change tools on Laptop.");
  await expect.element(addButton()).toBeDisabled();
  await expect.element(runsOn()).toBeEnabled();

  await userEvent.click(runsOn());
  await userEvent.click(page.getByRole("option", { name: "Devbox" }));
  await expect.element(addButton()).toBeEnabled();
});
