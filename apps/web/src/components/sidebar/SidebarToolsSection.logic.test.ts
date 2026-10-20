import {
  EnvironmentId,
  EnvironmentToolId,
  type EnvironmentToolBadge,
  type EnvironmentToolStatus,
  type EnvironmentToolTone,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentToolRow } from "../../state/environmentTools.logic";
import { groupSidebarTools, worstToolTone } from "./SidebarToolsSection.logic";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const labels = new Map([
  [laptop, "Laptop"],
  [server, "Build server"],
]);

const row = (environmentId: EnvironmentId, id: string, offline = false): EnvironmentToolRow => ({
  environmentId,
  toolId: EnvironmentToolId.make(id),
  definition: { kind: "terminal", name: id, command: id },
  offline,
});

const badge = (tone: EnvironmentToolTone): EnvironmentToolBadge => ({
  tone,
  headline: tone,
  detail: [],
  items: [],
  total: 0,
});
const ready = (tone: EnvironmentToolTone): EnvironmentToolStatus => ({
  state: "ready",
  badge: badge(tone),
  since: "2026-10-20T10:00:00.000Z",
});

describe("groupSidebarTools", () => {
  it("leaves tools of a single environment unlabelled and in file order", () => {
    const rows = [row(server, "zeta"), row(server, "alpha")];
    expect(groupSidebarTools(rows, labels)).toEqual([{ environmentId: server, label: null, rows }]);
  });

  it("labels each environment once tools span more than one, offline ones included", () => {
    const rows = [row(server, "lazygit"), row(server, "btop"), row(laptop, "htop", true)];
    const groups = groupSidebarTools(rows, labels);
    expect(groups.map((group) => [group.label, group.rows.map((entry) => entry.toolId)])).toEqual([
      ["Build server", ["lazygit", "btop"]],
      ["Laptop", ["htop"]],
    ]);
    expect(groups[1]?.rows[0]).toBe(rows[2]);
  });
});

describe("worstToolTone", () => {
  it("ignores good, pending and missing statuses", () => {
    expect(worstToolTone([ready("good"), { state: "pending" }, undefined])).toBeNull();
  });

  it("picks the most severe tone and counts an unavailable probe as muted", () => {
    const unavailable: EnvironmentToolStatus = {
      state: "unavailable",
      reason: "No answer within 30s",
      lastBadge: badge("alert"),
      since: "2026-10-20T10:00:00.000Z",
    };
    expect(worstToolTone([ready("good"), unavailable])).toBe("muted");
    expect(worstToolTone([unavailable, ready("info")])).toBe("info");
    expect(worstToolTone([ready("warn"), ready("alert"), ready("info")])).toBe("alert");
  });
});
