import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildEnvironmentToolRows } from "./environmentTools.logic";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");

const lazygit = { kind: "terminal", name: "Lazygit", command: "lazygit" };
const grafana = {
  kind: "browser",
  name: "Grafana",
  target: { kind: "url", url: "https://g.example" },
};

describe("buildEnvironmentToolRows", () => {
  it("keeps environment order and each environment's file order", () => {
    const { rows } = buildEnvironmentToolRows(null, [
      {
        environmentId: server,
        offline: false,
        webApps: false,
        tools: { zeta: lazygit, alpha: grafana },
      },
      {
        environmentId: laptop,
        offline: true,
        webApps: false,
        tools: { btop: { ...lazygit, name: "btop" } },
      },
    ]);
    expect(rows.map((row) => [row.environmentId, row.toolId, row.offline])).toEqual([
      [server, "zeta", false],
      [server, "alpha", false],
      [laptop, "btop", true],
    ]);
  });

  it("reports issues for connected environments only, next to the tools that decode", () => {
    const broken = { "Bad Key": lazygit, ok: lazygit };
    const result = buildEnvironmentToolRows(null, [
      { environmentId: server, offline: false, webApps: false, tools: broken },
      { environmentId: laptop, offline: true, webApps: false, tools: broken },
    ]);
    expect(result.rows.map((row) => row.toolId)).toEqual(["ok", "ok"]);
    expect([...result.issues.keys()]).toEqual([server]);
    expect(result.issues.get(server)?.[0]?.key).toBe("Bad Key");
  });

  it("returns the previous value when an unrelated settings write decodes the same tools", () => {
    const first = buildEnvironmentToolRows(null, [
      {
        environmentId: server,
        offline: false,
        webApps: false,
        tools: { lazygit, grafana, "Bad Key": {} },
      },
    ]);
    const next = buildEnvironmentToolRows(first, [
      {
        environmentId: server,
        offline: false,
        webApps: false,
        tools: structuredClone({ lazygit, grafana, "Bad Key": {} }),
      },
    ]);
    expect(next).toBe(first);
  });

  it("replaces only the rows that changed", () => {
    const first = buildEnvironmentToolRows(null, [
      { environmentId: server, offline: false, webApps: false, tools: { lazygit, grafana } },
    ]);
    const edited = buildEnvironmentToolRows(first, [
      {
        environmentId: server,
        offline: false,
        webApps: false,
        tools: { lazygit: { ...lazygit, command: "lazygit -p ~/src" }, grafana },
      },
    ]);
    expect(edited.rows[0]).not.toBe(first.rows[0]);
    expect(edited.rows[1]).toBe(first.rows[1]);
    expect(edited.issues).toBe(first.issues);

    const disconnected = buildEnvironmentToolRows(edited, [
      {
        environmentId: server,
        offline: true,
        webApps: false,
        tools: { lazygit: edited.rows[0]!.definition, grafana },
      },
    ]);
    expect(disconnected.rows.map((row) => row.offline)).toEqual([true, true]);
  });

  it("hides web apps on older servers and reveals them after a capability upgrade", () => {
    const tools = { lazygit, dashboard: { ...grafana, kind: "web" } };
    const oldServer = buildEnvironmentToolRows(null, [
      { environmentId: server, offline: false, webApps: false, tools },
    ]);
    expect(oldServer.rows.map((row) => row.toolId)).toEqual(["lazygit"]);
    expect(oldServer.issues.get(server)).toEqual([
      { key: "dashboard", message: "Needs a newer T3 Code" },
    ]);

    const upgraded = buildEnvironmentToolRows(oldServer, [
      { environmentId: server, offline: false, webApps: true, tools },
    ]);
    expect(upgraded.rows.map((row) => row.definition.kind)).toEqual(["terminal", "web"]);
    expect(upgraded.rows[0]).toBe(oldServer.rows[0]);
    expect(upgraded.issues.size).toBe(0);

    const disconnected = buildEnvironmentToolRows(upgraded, [
      { environmentId: server, offline: true, webApps: true, tools },
    ]);
    expect(disconnected.rows.map((row) => row.toolId)).toEqual(["lazygit", "dashboard"]);
  });
});
