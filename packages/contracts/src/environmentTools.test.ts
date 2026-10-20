import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { isUnknownUnionMember, UnknownUnionMember } from "./baseSchemas.ts";
import {
  EnvironmentToolBadge,
  EnvironmentToolDefinition,
  EnvironmentToolId,
  EnvironmentToolOpenResult,
  EnvironmentToolStatus,
  EnvironmentToolStatusEvent,
  environmentToolThreadId,
  isEnvironmentToolThreadId,
} from "./environmentTools.ts";
import { KeybindingRule } from "./keybindings.ts";
import { ServerSettingsPatch } from "./settings.ts";

const decodeDefinition = Schema.decodeUnknownSync(EnvironmentToolDefinition);
const isToolId = Schema.is(EnvironmentToolId);
const decodeStatus = Schema.decodeUnknownSync(EnvironmentToolStatus);
const decodeEvent = Schema.decodeUnknownSync(EnvironmentToolStatusEvent);
const decodeBadge = Schema.decodeUnknownSync(EnvironmentToolBadge);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodePatch = Schema.encodeSync(ServerSettingsPatch);
const decodeRule = Schema.decodeUnknownSync(KeybindingRule);

describe("EnvironmentToolDefinition", () => {
  it("decodes terminal and browser tools", () => {
    expect(
      decodeDefinition({ kind: "terminal", name: " lazygit ", command: "lazygit", cwd: "~/src" }),
    ).toEqual({ kind: "terminal", name: "lazygit", command: "lazygit", cwd: "~/src" });
    expect(
      decodeDefinition({
        kind: "browser",
        name: "Grafana",
        target: { kind: "environment-port", port: 3000, path: "/d/main" },
        status: { command: "gtc prs --badge", intervalSeconds: 120 },
      }),
    ).toEqual({
      kind: "browser",
      name: "Grafana",
      target: { kind: "environment-port", port: 3000, path: "/d/main" },
      status: { command: "gtc prs --badge", intervalSeconds: 120 },
    });
  });

  it("accepts web apps in settings with a host port or a URL", () => {
    for (const target of [
      { kind: "environment-port", port: 9877, path: "/ui/" },
      { kind: "url", url: "http://dashboard.internal/ui/" },
    ]) {
      const tool = { kind: "web", name: "Overseer", target };
      expect(decodeDefinition(tool)).toEqual(tool);
      expect(decodePatch({ tools: { overseer: tool } }).tools).toEqual({ overseer: tool });
      expect(encodePatch(decodePatch({ tools: { overseer: tool } }))).toEqual({
        tools: { overseer: tool },
      });
    }
  });

  it("rejects a kind this build does not know and out-of-range probe settings", () => {
    expect(() => decodeDefinition({ kind: "simulator", name: "iPhone" })).toThrow();
    expect(() =>
      decodeDefinition({
        kind: "terminal",
        name: "btop",
        command: "btop",
        status: { command: "true", intervalSeconds: 5 },
      }),
    ).toThrow();
  });
});

describe("EnvironmentToolId", () => {
  it("accepts lowercase slugs that start with a letter", () => {
    expect(isToolId("lazygit")).toBe(true);
    expect(isToolId("pr-dash-2")).toBe(true);
    expect(isToolId("a".repeat(24))).toBe(true);
  });

  it("rejects ids that would reorder or break the record", () => {
    expect(isToolId("123")).toBe(false);
    expect(isToolId("2fa")).toBe(false);
    expect(isToolId("LazyGit")).toBe(false);
    expect(isToolId("lazy git")).toBe(false);
    expect(isToolId("")).toBe(false);
    expect(isToolId("a".repeat(25))).toBe(false);
  });

  it("maps to a reserved thread namespace", () => {
    const threadId = environmentToolThreadId(EnvironmentToolId.make("lazygit"));
    expect(threadId).toBe("tool:lazygit");
    expect(isEnvironmentToolThreadId(threadId)).toBe(true);
    expect(isEnvironmentToolThreadId("7f0c2a8e-thread")).toBe(false);
  });

  it("names keybinding commands with the same rules", () => {
    expect(decodeRule({ key: "mod+shift+g", command: "tool.lazygit.open" }).command).toBe(
      "tool.lazygit.open",
    );
    expect(() => decodeRule({ key: "mod+shift+g", command: "tool.2fa.open" })).toThrow();
    expect(() => decodeRule({ key: "mod+shift+g", command: "tool.LazyGit.open" })).toThrow();
  });
});

describe("ServerSettingsPatch.tools", () => {
  const tool = { kind: "terminal", name: "btop", command: "btop" };

  it("requires a valid id to upsert but removes any key", () => {
    expect(decodePatch({ tools: { btop: tool } }).tools).toEqual({ btop: tool });
    expect(() => decodePatch({ tools: { "Bad Key": tool } })).toThrow();
    expect(decodePatch({ tools: { "Bad Key": null } }).tools).toEqual({ "Bad Key": null });
  });

  it("refuses to write or send a kind this build does not know", () => {
    const sim = { sim: { kind: "simulator", name: "iPhone" } };
    expect(() => decodePatch({ tools: sim })).toThrow();
    expect(() => encodePatch({ tools: sim })).toThrow();
    expect(encodePatch({ tools: { btop: tool } })).toEqual({
      tools: { btop: tool },
    });
  });
});

describe("status wire types", () => {
  const badge = {
    tone: "warn",
    headline: "3 PRs waiting",
    detail: ["2 need review"],
    items: [{ tone: "alert", text: "#412 CI failing" }],
    total: 3,
  };

  it("renders an unknown tone as muted", () => {
    const decoded = decodeBadge({
      ...badge,
      tone: "sparkly",
      items: [{ tone: "neon", text: "x" }],
    });
    expect(decoded.tone).toBe("muted");
    expect(decoded.items[0]?.tone).toBe("muted");
  });

  it("decodes states and event types from a newer server as unknown members", () => {
    expect(isUnknownUnionMember(decodeStatus({ state: "throttled" }))).toBe(true);
    expect(decodeStatus({ state: "ready", badge, since: "2026-10-20T10:00:00.000Z" })).toEqual({
      state: "ready",
      badge,
      since: "2026-10-20T10:00:00.000Z",
    });
    expect(decodeEvent({ type: "reset" })).toEqual(new UnknownUnionMember("type", "reset"));
    const snapshot = decodeEvent({
      type: "snapshot",
      statuses: { btop: { state: "pending" }, gtc: { state: "throttled" } },
    });
    expect(snapshot).toEqual({
      type: "snapshot",
      statuses: { btop: { state: "pending" }, gtc: new UnknownUnionMember("state", "throttled") },
    });
  });

  it("still fails a known state whose payload is broken", () => {
    expect(() =>
      decodeStatus({ state: "unavailable", reason: "x".repeat(201), since: "" }),
    ).toThrow();
  });
});

describe("EnvironmentToolOpenResult", () => {
  const decodeOpen = Schema.decodeUnknownSync(EnvironmentToolOpenResult);

  it("decodes a web app proxy URL without a thread or browser session", () => {
    const opened = {
      kind: "web",
      relativeUrl: "/api/tool-app/signed-token/?view=main#dashboard",
      expiresAt: 1_800_000_000_000,
    };
    expect(decodeOpen(opened)).toEqual(opened);
    expect(isUnknownUnionMember(decodeOpen({ kind: "native" }))).toBe(true);
    expect(() => decodeOpen({ kind: "web", relativeUrl: opened.relativeUrl })).toThrow();
  });
});
