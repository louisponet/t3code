import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  desktop: false,
  primary: null as string | null,
  serverBrowser: new Set<string>(),
}));

vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => state.desktop }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.primary } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: (id: string) => state.serverBrowser.has(id),
  useEnvironmentSupportsServerBrowser: () => false,
}));

import { browserToolRuntime } from "./previewRuntime";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;

afterEach(() => {
  state.desktop = false;
  state.primary = null;
  state.serverBrowser = new Set();
});

describe("browserToolRuntime", () => {
  it("renders a remote environment's reachable URL on this computer", () => {
    state.desktop = true;
    state.primary = local;

    expect(browserToolRuntime(remote, { kind: "url", url: "overseer.example.com/ui" })).toBe(
      "desktop",
    );
    expect(browserToolRuntime(remote, { kind: "url", url: "http://localhost:3000" })).toBe(
      "server",
    );
    expect(browserToolRuntime(remote, { kind: "environment-port", port: 3000 })).toBe("server");
  });

  it("keeps the environment's browser where it already renders natively or is the only one", () => {
    state.desktop = true;
    state.primary = local;
    expect(browserToolRuntime(local, { kind: "url", url: "https://grafana.example.com" })).toBe(
      "server",
    );

    state.desktop = false;
    expect(browserToolRuntime(remote, { kind: "url", url: "https://grafana.example.com" })).toBe(
      "server",
    );
  });
});
