import { ReviewFindingError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  reviewFindingActions,
  reviewFindingFailureMessage,
  reviewFindingLocation,
  reviewFindingPostedLabel,
} from "./reviewFinding.ts";

const pullRequest = { host: "github.com", repository: "o/r", number: 12, url: "https://x/12" };

describe("reviewFindingLocation", () => {
  it("names the file, line and range the finding points at", () => {
    expect(reviewFindingLocation({})).toBeNull();
    expect(reviewFindingLocation({ path: "a.rs" })).toBe("a.rs");
    expect(reviewFindingLocation({ path: "a.rs", line: 4 })).toBe("a.rs:4");
    expect(reviewFindingLocation({ path: "a.rs", line: 4, endLine: 4 })).toBe("a.rs:4");
    expect(reviewFindingLocation({ path: "a.rs", line: 4, endLine: 9 })).toBe("a.rs:4-9");
  });
});

describe("reviewFindingActions", () => {
  it("offers dismiss and post only while open, and a way back from dismissed", () => {
    expect(reviewFindingActions({ findingStatus: "open" }, "local")).toEqual({
      dismiss: true,
      restore: false,
      post: true,
      comment: true,
    });
    expect(reviewFindingActions({ findingStatus: "dismissed" }, "local")).toEqual({
      dismiss: false,
      restore: true,
      post: false,
      comment: true,
    });
    expect(reviewFindingActions({ findingStatus: "posted" }, "local")).toEqual({
      dismiss: false,
      restore: false,
      post: false,
      comment: true,
    });
  });

  it("offers nothing on a finding inherited from another thread", () => {
    expect(reviewFindingActions({ findingStatus: "open" }, "inherited")).toEqual({
      dismiss: false,
      restore: false,
      post: false,
      comment: false,
    });
  });
});

describe("reviewFindingPostedLabel", () => {
  it("says where a posted finding landed", () => {
    expect(reviewFindingPostedLabel({ findingStatus: "open", pullRequest })).toBeNull();
    expect(
      reviewFindingPostedLabel({ findingStatus: "posted", postedAs: "inline", pullRequest }),
    ).toBe("Posted inline on #12");
    expect(
      reviewFindingPostedLabel({ findingStatus: "posted", postedAs: "comment", pullRequest }),
    ).toBe("Posted on #12");
  });
});

describe("reviewFindingFailureMessage", () => {
  it("passes server reasons through and hides anything else", () => {
    expect(
      reviewFindingFailureMessage(
        new ReviewFindingError({ reason: "post_failed", detail: "Head changed." }),
      ),
    ).toBe("Could not post the finding to the pull request. Head changed.");
    expect(reviewFindingFailureMessage(new Error("socket closed"))).toBe(
      "Could not update the finding. Try again.",
    );
  });
});
