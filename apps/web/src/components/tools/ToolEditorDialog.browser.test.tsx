import type { EnvironmentId, EnvironmentToolId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

import "~/index.css";

const atoms = vi.hoisted(() => ({ rows: { atom: "tool-rows" } }));
const state = vi.hoisted(() => ({
  writable: new Set<string>(),
  webApps: new Set<string>(),
  rows: [] as unknown[],
  save: vi.fn(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown) => {
    if (atom === atoms.rows) return { rows: state.rows, issues: new Map() };
    throw new Error("Unexpected atom");
  }) as never,
}));

vi.mock(import("../../state/environmentTools"), async (original) => ({
  ...(await original()),
  useEnvironmentToolsEnvironmentIds: () => ["primary", "devbox"] as never,
  environmentToolRowsAtom: atoms.rows as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => "primary" as never,
  useEnvironments: (() => ({
    environments: [
      ["primary", "Laptop"],
      ["devbox", "Devbox"],
    ].map(([environmentId, label]) => ({
      environmentId,
      label,
      serverConfig: {
        environment: {
          platform: { machine: "server" },
          capabilities: {
            environmentTools: true,
            environmentToolWebApps: state.webApps.has(environmentId!),
          },
        },
        settings: { tools: {} },
      },
    })),
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
  useAtomCommand: (() => state.save) as never,
}));

import { ToolEditorDialog } from "./ToolEditorDialog";

const renderDialog = (toolId?: string) =>
  render(
    <ToolEditorDialog
      open
      onOpenChange={() => {}}
      {...(toolId === undefined
        ? {}
        : { environmentId: "devbox" as EnvironmentId, toolId: toolId as EnvironmentToolId })}
    />,
  );
const runsOn = () => page.getByRole("combobox", { name: "Runs on" });
const addButton = () => page.getByRole("button", { name: "Add tool" });

function setup() {
  state.writable = new Set(["devbox"]);
  state.webApps = new Set(["devbox"]);
  state.rows = [];
  state.save.mockReset().mockResolvedValue(AsyncResult.success(undefined));
}

it("starts a new tool on a writable environment when the primary one is read-only", async () => {
  setup();
  await using _screen = await renderDialog();

  await expect.element(runsOn()).toHaveTextContent("Devbox");
  await expect.element(addButton()).toBeEnabled();
});

it("keeps the environment picker usable after choosing a read-only environment", async () => {
  setup();
  await using _screen = await renderDialog();

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

it.each(["terminal", "browser", "web"] as const)(
  "saves a new %s tool with its own fields",
  async (kind) => {
    setup();
    await using _screen = await renderDialog();
    await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Dashboard");
    if (kind === "terminal") {
      await userEvent.fill(page.getByRole("textbox", { name: "Command", exact: true }), "lazygit");
    } else {
      await userEvent.click(
        page.getByRole("button", { name: kind === "web" ? "Web app" : "Browser", exact: true }),
      );
      await userEvent.fill(
        page.getByRole("textbox", { name: "URL", exact: true }),
        "https://example.com/dashboard",
      );
    }
    await userEvent.click(addButton());

    expect(state.save).toHaveBeenCalledExactlyOnceWith({
      environmentId: "devbox",
      input: {
        patch: {
          tools: {
            dashboard: {
              kind,
              name: "Dashboard",
              ...(kind === "terminal"
                ? { command: "lazygit" }
                : { target: { kind: "url", url: "https://example.com/dashboard" } }),
            },
          },
        },
      },
    });
  },
);

it("preserves a web app's host port target when editing its name", async () => {
  setup();
  const target = { kind: "environment-port", port: 8443, protocol: "https", path: "/dashboard" };
  state.rows = [
    {
      environmentId: "devbox",
      toolId: "dashboard",
      offline: false,
      definition: { kind: "web", name: "Dashboard", description: "Local app", target },
    },
  ];
  await using _screen = await renderDialog("dashboard");
  await expect
    .element(page.getByRole("textbox", { name: "Port", exact: true }))
    .toHaveValue("8443");
  await expect
    .element(page.getByRole("textbox", { name: "Path optional", exact: true }))
    .toHaveValue("/dashboard");
  await userEvent.fill(page.getByRole("textbox", { name: /^Name/ }), "Operations");
  await userEvent.click(page.getByRole("button", { name: "Save changes" }));

  expect(state.save).toHaveBeenCalledExactlyOnceWith({
    environmentId: "devbox",
    input: {
      patch: {
        tools: { dashboard: { kind: "web", name: "Operations", description: "Local app", target } },
      },
    },
  });
});

it("blocks saving a web app after switching to an older environment and allows changing its kind", async () => {
  setup();
  state.writable = new Set(["primary", "devbox"]);
  await using _screen = await renderDialog();
  await expect
    .element(page.getByRole("button", { name: "Web app", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(runsOn());
  await userEvent.click(page.getByRole("option", { name: "Devbox" }));
  await userEvent.click(page.getByRole("button", { name: "Web app", exact: true }));
  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Dashboard");
  await userEvent.fill(
    page.getByRole("textbox", { name: "URL", exact: true }),
    "https://example.com",
  );
  await userEvent.click(runsOn());
  await userEvent.click(page.getByRole("option", { name: "Laptop" }));
  await expect.element(addButton()).toBeDisabled();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Laptop needs a newer T3 Code to run web apps.");
  expect(state.save).not.toHaveBeenCalled();

  await userEvent.click(page.getByRole("button", { name: "Browser", exact: true }));
  await userEvent.click(addButton());
  expect(state.save).toHaveBeenCalledExactlyOnceWith({
    environmentId: "primary",
    input: {
      patch: {
        tools: {
          dashboard: {
            kind: "browser",
            name: "Dashboard",
            target: { kind: "url", url: "https://example.com" },
          },
        },
      },
    },
  });
});
