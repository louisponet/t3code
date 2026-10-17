import { describe, expect, it } from "vite-plus/test";
import { helixSourceReviewOptions } from "./helixReviewOptions";

describe("mobile Helix comparison scope", () => {
  it("opens uncommitted changes against HEAD", () => {
    expect(helixSourceReviewOptions({ kind: "working-tree" })).toEqual({ baseline: "HEAD" });
  });
  it("keeps branch changes against the server merge base and includes disk edits", () => {
    const baseline = "a".repeat(40);
    expect(helixSourceReviewOptions({ kind: "branch-range", helixBaseline: baseline })).toEqual({
      baseline,
    });
  });
  it("requires a resolved baseline for branch changes on older servers", () => {
    expect(helixSourceReviewOptions({ kind: "branch-range" })).toBeNull();
  });
});
