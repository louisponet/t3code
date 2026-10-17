import type { HelixReviewState } from "@t3tools/client-runtime/helix-review-control";
import { describe, expect, it } from "vite-plus/test";
import { helixReviewToolbar } from "./helixReviewToolbar";

const state: HelixReviewState = {
  mode: "review",
  nonce: "22222222-2222-4222-8222-222222222222",
  canStage: false,
  canMarkReviewed: true,
  reviewed: false,
  reviewedCount: 1,
  totalCount: 3,
};

describe("HX review toolbar", () => {
  it("shows only the current mode's destination even when every capability is available", () => {
    const capabilities = {
      ...state,
      canStage: true,
      canComment: true,
      canSend: true,
      canReviewPr: true,
      pendingCommentCount: 2,
    };
    const work = helixReviewToolbar({ ...capabilities, mode: "work" }).actions.map(
      ({ action }) => action,
    );
    expect(work).toEqual([
      "comment",
      "files",
      "previous",
      "next",
      "ask",
      "stage",
      "discard-last-comment",
      "send",
    ]);
    const review = helixReviewToolbar({ ...capabilities, mode: "review" }).actions.map(
      ({ action }) => action,
    );
    expect(review).toEqual([
      "files",
      "previous",
      "next",
      "ask",
      "mark-reviewed",
      "pr-comment",
      "pr-review",
    ]);
  });
  it("keeps Stage for legacy editors and uncommitted changes", () => {
    const legacy = helixReviewToolbar(null);
    expect(legacy.actions.map(({ action }) => action)).toEqual([
      "files",
      "previous",
      "next",
      "ask",
      "stage",
      "send",
    ]);
    expect(legacy.progress).toBeNull();
    const uncommitted = helixReviewToolbar({
      ...state,
      mode: "work",
      canStage: true,
      canMarkReviewed: false,
      reviewed: null,
      reviewedCount: 0,
      totalCount: 0,
    });
    expect(uncommitted.actions).toEqual(legacy.actions);
    expect(uncommitted.progress).toBeNull();
  });

  it("marks the current committed change and uses the next change's actual state after advancing", () => {
    const current = helixReviewToolbar(state);
    expect(current.actions.map(({ action }) => action)).toContain("mark-reviewed");
    expect(current.actions.map(({ action }) => action)).not.toContain("stage");
    expect(current.progress).toBe("1/3 changes reviewed in this file");

    const advanced = helixReviewToolbar({ ...state, reviewedCount: 2 });
    expect(advanced.actions.map(({ action }) => action)).toContain("mark-reviewed");
    expect(advanced.actions.map(({ action }) => action)).not.toContain("unmark-reviewed");
    expect(advanced.progress).toBe("2/3 changes reviewed in this file");

    const reviewed = helixReviewToolbar({ ...state, reviewed: true, reviewedCount: 3 });
    expect(reviewed.actions.map(({ action }) => action)).toContain("unmark-reviewed");
    expect(reviewed.actions.map(({ action }) => action)).not.toContain("mark-reviewed");
    expect(reviewed.progress).toBe("3/3 changes reviewed in this file");
  });

  it("keeps file progress while no current change can be marked", () => {
    const outsideChange = helixReviewToolbar({
      ...state,
      canMarkReviewed: false,
      reviewed: null,
    });
    expect(outsideChange.actions.map(({ action }) => action)).toEqual([
      "files",
      "previous",
      "next",
      "ask",
    ]);
    expect(outsideChange.progress).toBe("1/3 changes reviewed in this file");
  });

  it("offers PR draft controls only for a capable host and counts the combined review", () => {
    expect(helixReviewToolbar(state).actions.map(({ action }) => action)).not.toContain(
      "pr-comment",
    );
    const pr = helixReviewToolbar({ ...state, canReviewPr: true }, 3);
    expect(pr.actions.find(({ action }) => action === "pr-comment")?.label).toBe(
      "Draft PR comment",
    );
    expect(pr.actions.find(({ action }) => action === "pr-review")?.label).toBe(
      "Review drafts · 3",
    );
    expect(pr.actions.find(({ action }) => action === "ask")?.label).toBe("Ask agent");
  });
  it("keeps agent comments available outside PRs and disables snapshot questions", () => {
    const actions = helixReviewToolbar({
      ...state,
      mode: "work",
      canComment: true,
      pendingCommentCount: 2,
      canAsk: false,
    }).actions;
    expect(actions[0]?.action).toBe("comment");
    expect(actions.some(({ action }) => action === "ask")).toBe(false);
    expect(actions.find(({ action }) => action === "send")?.label).toBe("Send to agent · 2");
    expect(actions.some(({ action }) => action === "discard-last-comment")).toBe(true);
  });
  it("omits Send for historical snapshots and editors without an agent handoff", () => {
    expect(
      helixReviewToolbar({ ...state, canSend: false }).actions.some(
        ({ action }) => action === "send",
      ),
    ).toBe(false);
    expect(
      helixReviewToolbar({ ...state, mode: "work" }).actions.some(
        ({ action }) => action === "send",
      ),
    ).toBe(true);
  });
});
