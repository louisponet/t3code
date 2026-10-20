import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ writable: new Set<string>() }));

const environment = (environmentId: string, label: string) => ({
  environmentId,
  label,
  connection: { phase: "connected" },
  serverConfig: {
    environment: { capabilities: { environmentTools: true }, platform: { machine: "server" } },
    settings: {},
  },
});

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    environments: [environment("primary", "Laptop"), environment("devbox", "Devbox")],
  })) as never,
}));
vi.mock(import("../../state/environmentTools"), async (original) => ({
  ...(await original()),
  useEnvironmentToolsEnvironmentIds: () => ["primary", "devbox"] as never,
  environmentToolRowsAtom: Atom.make({
    rows: ["primary", "devbox"].map((environmentId) => ({
      environmentId,
      toolId: "lazygit",
      definition: { kind: "terminal", name: "lazygit", command: "lazygit" },
      offline: false,
    })),
    issues: new Map(),
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((environmentId: EnvironmentId | null, scope: string) =>
    scope === "settings:write" &&
    environmentId !== null &&
    state.writable.has(environmentId)) as never,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(
      environments
        .map(({ environmentId }) => environmentId)
        .filter((environmentId) => state.writable.has(environmentId)),
    )) as never,
}));
vi.mock(import("../tools/ToolEditorDialog"), async (original) => ({
  ...(await original()),
  ToolEditorDialog: ((props: { open: boolean; environmentId?: string }) =>
    props.open ? <p role="dialog">editing {props.environmentId}</p> : null) as never,
  useRemoveEnvironmentTool: () => vi.fn(),
}));
// The real layout reads search targets and override state; this suite is about where Add goes.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsSection: (({
    headerAction,
    children,
  }: {
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  )) as never,
  SettingsRow: (({ title, control }: { title: ReactNode; control?: ReactNode }) => (
    <div>
      {title}
      {control}
    </div>
  )) as never,
}));

import { ToolsSettings } from "./ToolsSettings";

let root: Root;
let container: HTMLDivElement;

const render = () => act(async () => root.render(<ToolsSettings />));
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

it("adds to the first writable environment when the first capable one is read-only", async () => {
  await render();

  await userEvent.click(addButton());
  await expect.element(page.getByRole("dialog")).toHaveTextContent("editing devbox");
});

it("disables Add when no capable environment is writable", async () => {
  state.writable = new Set();
  await render();

  await expect.element(addButton()).toBeDisabled();
});
