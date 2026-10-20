import {
  EnvironmentToolStatus,
  MAX_ENVIRONMENT_TOOL_UNAVAILABLE_REASON_LENGTH,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  cleanEnvironmentToolText,
  decodeEnvironmentTools,
  normalizeEnvironmentToolBadge,
  slugEnvironmentToolId,
} from "./environmentTools.ts";

describe("decodeEnvironmentTools", () => {
  it("keeps valid tools in file order and turns each bad entry into an issue", () => {
    const decoded = decodeEnvironmentTools({
      lazygit: { kind: "terminal", name: "lazygit", command: "lazygit" },
      "Bad Key": { kind: "terminal", name: "x", command: "x" },
      sim: { kind: "simulator", name: "iPhone" },
      btop: { kind: "terminal", name: "btop" },
      grafana: { kind: "browser", name: "Grafana", target: { kind: "url", url: "https://g.dev" } },
      overseer: { kind: "web", name: "Overseer", target: { kind: "environment-port", port: 9877 } },
      slow: {
        kind: "terminal",
        name: "slow",
        command: "slow",
        status: { command: "probe", intervalSeconds: 1 },
      },
    });

    expect(decoded.tools.map((tool) => tool.id)).toEqual(["lazygit", "grafana", "overseer"]);
    expect(decoded.tools[1]?.definition).toEqual({
      kind: "browser",
      name: "Grafana",
      target: { kind: "url", url: "https://g.dev" },
    });
    expect(decoded.issues.map((issue) => issue.key)).toEqual(["Bad Key", "sim", "btop", "slow"]);
    expect(decoded.issues[0]?.message).toBe("Tool ids use lowercase letters, digits and dashes");
    expect(decoded.issues[1]?.message).toBe("Needs a newer T3 Code");
    expect(decoded.issues[2]?.message).toMatch(/^command: /);
    expect(decoded.issues[3]?.message).toMatch(/^status\.intervalSeconds: /);
  });

  it("names the problem when an entry is not a tool at all", () => {
    expect(decodeEnvironmentTools({ a: "btop", b: { name: "btop" } }).issues).toEqual([
      { key: "a", message: "Expected an object" },
      { key: "b", message: 'kind: Expected "terminal" or "browser" or "web"' },
    ]);
  });
});

describe("normalizeEnvironmentToolBadge", () => {
  it("normalizes gtc's badge shape rather than rejecting it", () => {
    const badge = normalizeEnvironmentToolBadge({
      tone: "sparkly",
      glyph: "\u001b●●●●●",
      headline: `3 PRs\nwaiting ${"x".repeat(80)}`,
      detail: ["a", "b", "c", "d", "e", "f"],
      items: Array.from({ length: 10 }, (_, index) => ({ tone: "alert", text: `#${index}` })),
      extra: true,
    });
    if ("error" in badge) throw new Error(badge.error);
    expect(badge.tone).toBe("muted");
    expect(badge.glyph).toBe("●●●●");
    expect(badge.headline).toHaveLength(60);
    expect(badge.headline.startsWith("3 PRs waiting x")).toBe(true);
    expect(badge.headline.endsWith("…")).toBe(true);
    expect(badge.detail).toEqual(["a", "b", "c", "d", "e"]);
    expect(badge.items).toHaveLength(8);
    expect(badge.total).toBe(10);
    expect(badge).not.toHaveProperty("extra");
  });

  it("keeps an explicit total and defaults missing fields", () => {
    expect(normalizeEnvironmentToolBadge({ headline: "ok", total: 42 })).toEqual({
      tone: "muted",
      headline: "ok",
      detail: [],
      items: [],
      total: 42,
    });
  });

  it("counts limits in UTF-16 units without splitting an astral character", () => {
    const astral = "🔴".repeat(150);
    const badge = normalizeEnvironmentToolBadge({
      glyph: "🔴🔴🔴",
      headline: astral,
      detail: [`x${astral}`],
      items: [{ glyph: "x🔴🔴", text: astral }],
    });
    if ("error" in badge) throw new Error(badge.error);
    expect(badge.glyph).toBe("🔴🔴");
    expect(badge.headline).toBe(`${"🔴".repeat(29)}…`);
    expect(badge.detail).toEqual([`x${"🔴".repeat(39)}…`]);
    expect(badge.items[0]).toEqual({ tone: "muted", glyph: "x🔴", text: `${"🔴".repeat(49)}…` });

    const reason = cleanEnvironmentToolText(
      `🔴 error: ${astral}`,
      MAX_ENVIRONMENT_TOOL_UNAVAILABLE_REASON_LENGTH,
    );
    expect(reason).toBe(`🔴 error: ${"🔴".repeat(94)}…`);
    const since = "2026-10-18T12:00:00.000Z";
    const encodeStatus = Schema.encodeUnknownSync(EnvironmentToolStatus);
    expect(() => encodeStatus({ state: "ready", badge, since })).not.toThrow();
    expect(() =>
      encodeStatus({ state: "unavailable", reason, lastBadge: badge, since }),
    ).not.toThrow();
  });

  it("names the field that makes output unusable", () => {
    expect(normalizeEnvironmentToolBadge({ tone: "good" })).toEqual({
      error: expect.stringMatching(/^Output is not a status badge: headline: /),
    });
    expect(normalizeEnvironmentToolBadge("ok")).toHaveProperty("error");
  });
});

describe("slugEnvironmentToolId", () => {
  it("slugs names into unique ids that start with a letter", () => {
    expect(slugEnvironmentToolId("Lazy Git", new Set())).toBe("lazy-git");
    expect(slugEnvironmentToolId("Résumé builder", new Set())).toBe("resume-builder");
    expect(slugEnvironmentToolId("2FA codes", new Set())).toBe("tool-2fa-codes");
    expect(slugEnvironmentToolId("!!!", new Set())).toBe("tool");
    expect(slugEnvironmentToolId("lazygit", new Set(["lazygit", "lazygit-2"]))).toBe("lazygit-3");
  });

  it("stays within the id length when adding a suffix", () => {
    const name = "a very long dashboard name that keeps going";
    const first = slugEnvironmentToolId(name, new Set());
    expect(first).toHaveLength(24);
    const second = slugEnvironmentToolId(name, new Set([first]));
    expect(second.length).toBeLessThanOrEqual(24);
    expect(second.endsWith("-2")).toBe(true);
  });
});
