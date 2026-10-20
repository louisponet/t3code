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

import { alternatePreviewRuntime, browserToolRuntime, previewRuntimeFor } from "./previewRuntime";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;

afterEach(() => {
  state.desktop = false;
  state.primary = null;
  state.serverBrowser = new Set();
});

describe("previewRuntimeFor", () => {
  it("opens a remote environment's tabs on this computer in the desktop app", () => {
    state.desktop = true;
    state.primary = local;
    state.serverBrowser = new Set([local, remote]);

    expect(previewRuntimeFor(remote)).toBeUndefined();
    expect(previewRuntimeFor(local)).toBe("server");
  });

  it("uses the environment's browser where the client has none of its own", () => {
    state.serverBrowser = new Set([remote]);

    expect(previewRuntimeFor(remote)).toBe("server");
  });
});

describe("alternatePreviewRuntime", () => {
  it("moves a remote environment's tab between this computer and the environment", () => {
    state.desktop = true;

    expect(alternatePreviewRuntime(remote, local, true, {})).toBe("server");
    expect(alternatePreviewRuntime(remote, local, true, { runtime: "server" })).toBe("desktop");
    expect(alternatePreviewRuntime(local, local, true, {})).toBeNull();
    expect(alternatePreviewRuntime(remote, local, false, {})).toBeNull();
  });

  it("offers no move outside the desktop app", () => {
    expect(alternatePreviewRuntime(remote, null, true, { runtime: "server" })).toBeNull();
  });
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
