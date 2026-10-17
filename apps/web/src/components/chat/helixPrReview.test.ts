import type { HelixPrReviewSnapshot } from "@t3tools/client-runtime/helix-review-control";
import { describe, expect, it } from "vite-plus/test";
import {
  helixPrActionText,
  helixPrReviewFingerprint,
  helixPrReviewInput,
  helixSuggestionBody,
} from "./helixPrReview";

const snapshot: HelixPrReviewSnapshot = {
  revision: "draft-1",
  pr: {
    url: "https://github.com/acme/repo/pull/4",
    repo: "acme/repo",
    number: 4,
    title: "Parser",
    headSha: "a".repeat(40),
  },
  selection: null,
  comments: [
    {
      id: "old",
      path: "parser.ts",
      side: "LEFT",
      startLine: 2,
      line: 4,
      code: "old",
      body: "Keep the validation",
    },
    {
      id: "new",
      path: "parser.ts",
      side: "RIGHT",
      startLine: 9,
      line: 9,
      code: "new",
      body: "Name this value",
    },
  ],
  suggestions: [
    {
      id: "included",
      path: "parser.ts",
      startLine: 11,
      line: 12,
      original: "before",
      replacement: "after",
      accepted: true,
    },
    {
      id: "excluded",
      path: "other.ts",
      startLine: 1,
      line: 1,
      original: "x",
      replacement: "y",
      accepted: false,
    },
  ],
};

describe("HX PR review payload", () => {
  it("combines human comments and included agent suggestions with old/new ranges and a pinned head", () => {
    expect(helixPrReviewInput(snapshot, "Looks good with these edits", "comment")).toEqual({
      expectedHeadSha: snapshot.pr.headSha,
      verdict: "comment",
      body: "Looks good with these edits",
      comments: [
        {
          path: "parser.ts",
          position: { kind: "deleted", oldLine: 4 },
          startLine: 2,
          body: "Keep the validation",
        },
        { path: "parser.ts", position: { kind: "added", newLine: 9 }, body: "Name this value" },
        {
          path: "parser.ts",
          position: { kind: "added", newLine: 12 },
          startLine: 11,
          body: "```suggestion\nafter\n```",
        },
      ],
    });
  });

  it("uses a fence that cannot be closed by replacement code and preserves deletion semantics", () => {
    expect(helixSuggestionBody("const nested = `hi`;\n```\n")).toBe(
      "````suggestion\nconst nested = `hi`;\n```\n````",
    );
    expect(helixSuggestionBody("")).toBe("```suggestion\n```");
    expect(helixSuggestionBody("\n")).toBe("```suggestion\n\n```");
    expect(helixSuggestionBody("new\n")).toBe("```suggestion\nnew\n```");
    expect(helixSuggestionBody("new\n\n")).toBe("```suggestion\nnew\n\n```");
  });

  it("keeps a human comment on the original PR lines alongside an agent suggestion on those same lines", () => {
    const comment = snapshot.comments[1]!;
    const original = {
      ...snapshot,
      revision: "before-agent-edit",
      comments: [comment],
      suggestions: [],
    };
    const afterEdit = {
      ...original,
      revision: "after-agent-edit",
      suggestions: [
        {
          id: "same-lines",
          path: comment.path,
          startLine: comment.startLine,
          line: comment.line,
          original: `${comment.code}\n`,
          replacement: "agent replacement\n",
          accepted: true,
        },
      ],
    };
    const before = helixPrReviewInput(original, "", "comment");
    const combined = helixPrReviewInput(afterEdit, "", "comment");
    expect(combined.expectedHeadSha).toBe(before.expectedHeadSha);
    expect(combined.comments).toEqual([
      before.comments[0],
      {
        path: comment.path,
        position: { kind: "added", newLine: comment.line },
        body: "```suggestion\nagent replacement\n```",
      },
    ]);
    expect(helixPrReviewFingerprint(afterEdit)).not.toBe(helixPrReviewFingerprint(original));
  });

  it("rejects unpostable replies instead of turning them into new comments", () => {
    expect(() =>
      helixPrReviewInput(
        { ...snapshot, comments: [{ ...snapshot.comments[0]!, replyTo: 42 }] },
        "",
        "comment",
      ),
    ).toThrow("Replies cannot be included");
  });

  it("keeps unsupported excluded suggestions from blocking unrelated review comments", () => {
    const unsupported = {
      ...snapshot.suggestions[0]!,
      accepted: false,
      error: "Outside the PR patch",
    };
    const review = { ...snapshot, suggestions: [unsupported] };
    expect(helixPrReviewInput(review, "", "comment").comments).toHaveLength(2);
    expect(() =>
      helixPrReviewInput(
        { ...review, suggestions: [{ ...unsupported, accepted: true }] },
        "",
        "comment",
      ),
    ).toThrow("Outside the PR patch");
  });

  it("invalidates the frozen review for changed drafts, inclusion, head, or edits", () => {
    const original = helixPrReviewFingerprint(snapshot);
    for (const changed of [
      { ...snapshot, revision: "draft-2" },
      { ...snapshot, comments: [{ ...snapshot.comments[0]!, body: "Changed" }] },
      {
        ...snapshot,
        suggestions: snapshot.suggestions.map((suggestion) => ({
          ...suggestion,
          accepted: !suggestion.accepted,
        })),
      },
      { ...snapshot, pr: { ...snapshot.pr, headSha: "b".repeat(40) } },
    ])
      expect(helixPrReviewFingerprint(changed)).not.toBe(original);
    expect(
      helixPrReviewFingerprint({
        ...snapshot,
        selection: {
          id: "cursor",
          path: "parser.ts",
          side: "RIGHT",
          startLine: 1,
          line: 1,
          code: "code",
        },
      }),
    ).toBe(original);
  });

  it("measures JSON in UTF-8 bytes before sending an action", () => {
    expect(JSON.parse(helixPrActionText({ revision: "1", body: "Why 👋?" }))).toEqual({
      revision: "1",
      body: "Why 👋?",
    });
    expect(() => helixPrActionText({ body: "👋".repeat(2100) })).toThrow("8 KiB");
  });

  it("requires feedback for a comment review while permitting a summary-free approval", () => {
    const empty = { ...snapshot, comments: [], suggestions: [] };
    expect(() => helixPrReviewInput(empty, " ", "comment")).toThrow("Add a summary");
    expect(helixPrReviewInput(empty, "", "approve").comments).toEqual([]);
    expect(() =>
      helixPrReviewInput({ ...snapshot, error: "PR head changed" }, "Summary", "comment"),
    ).toThrow("PR head changed");
  });
});
