import { describe, expect, it } from "vite-plus/test";
import {
  findOpenHelixReviewTerminal,
  helixReviewCommand,
  newHelixReviewTerminalId,
} from "./helixReview.ts";
describe("Helix launches", () => {
  it("defaults to work and passes an explicit review mode", () => {
    expect(helixReviewCommand("thread-1", "environment-1")).toContain('"mode":"work"');
    expect(helixReviewCommand("thread-1", "environment-1", { mode: "review" })).toContain(
      '"mode":"review"',
    );
  });
  it("reuses only a running editor in the requested mode", () => {
    const workId = newHelixReviewTerminalId("one", "work");
    const reviewId = newHelixReviewTerminalId("two", "review");
    const sessions = [
      { target: { terminalId: "helix-review-legacy" }, state: { status: "running" } },
      { target: { terminalId: workId }, state: { status: "running" } },
      { target: { terminalId: reviewId }, state: { status: "running" } },
    ];
    expect(findOpenHelixReviewTerminal(sessions, undefined, "work")).toBe(workId);
    expect(findOpenHelixReviewTerminal(sessions, undefined, "review")).toBe(reviewId);
    sessions[2]!.state.status = "exited";
    expect(findOpenHelixReviewTerminal(sessions, undefined, "review")).toBeNull();
    expect(findOpenHelixReviewTerminal(sessions, [reviewId], "work")).toBeNull();
  });
});
