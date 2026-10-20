import {
  EnvironmentToolId,
  EnvironmentToolStatusEvent,
  type EnvironmentToolStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyEnvironmentToolStatusEvent,
  type EnvironmentToolStatuses,
} from "./environmentTools.ts";

const decodeEvent = Schema.decodeUnknownSync(EnvironmentToolStatusEvent);
const lazygit = EnvironmentToolId.make("lazygit");
const btop = EnvironmentToolId.make("btop");
const ready = (headline: string) => ({
  state: "ready" as const,
  badge: { tone: "warn" as const, headline, detail: [], items: [], total: 0 },
  since: "2026-10-20T10:00:00.000Z",
});
const apply = (current: EnvironmentToolStatuses, event: unknown) =>
  applyEnvironmentToolStatusEvent(current, decodeEvent(event));
const EMPTY: EnvironmentToolStatuses = new Map();

describe("applyEnvironmentToolStatusEvent", () => {
  it("replaces everything on a snapshot, dropping states this build cannot read", () => {
    const current = new Map<EnvironmentToolId, EnvironmentToolStatus>([[btop, ready("old")]]);
    const next = apply(current, {
      type: "snapshot",
      statuses: { lazygit: { state: "pending" }, gtc: { state: "throttled" } },
    });
    expect([...next]).toEqual([[lazygit, { state: "pending" }]]);
  });

  it("upserts one tool and removes it on null", () => {
    const added = apply(EMPTY, { type: "status", toolId: "lazygit", status: ready("3 PRs") });
    const updated = apply(added, { type: "status", toolId: "btop", status: { state: "pending" } });
    expect([...updated.keys()]).toEqual([lazygit, btop]);
    expect(updated.get(lazygit)).toBe(added.get(lazygit));

    const removed = apply(updated, { type: "status", toolId: "lazygit", status: null });
    expect([...removed.keys()]).toEqual([btop]);
    expect(apply(removed, { type: "status", toolId: "lazygit", status: null })).toBe(removed);
  });

  it("ignores event types from a newer server and treats an unreadable state as no status", () => {
    const current = apply(EMPTY, { type: "status", toolId: "lazygit", status: ready("3 PRs") });
    expect(apply(current, { type: "reset" })).toBe(current);
    expect(
      apply(current, { type: "status", toolId: "lazygit", status: { state: "throttled" } }).size,
    ).toBe(0);
  });

  it("keeps the same map and status objects when nothing changed", () => {
    const current = apply(EMPTY, {
      type: "snapshot",
      statuses: { lazygit: ready("3 PRs"), btop: { state: "pending" } },
    });
    expect(
      apply(current, {
        type: "snapshot",
        statuses: { lazygit: ready("3 PRs"), btop: { state: "pending" } },
      }),
    ).toBe(current);
    expect(apply(current, { type: "status", toolId: "lazygit", status: ready("3 PRs") })).toBe(
      current,
    );

    const changed = apply(current, {
      type: "snapshot",
      statuses: { lazygit: ready("3 PRs"), btop: ready("idle") },
    });
    expect(changed).not.toBe(current);
    expect(changed.get(lazygit)).toBe(current.get(lazygit));
  });
});
