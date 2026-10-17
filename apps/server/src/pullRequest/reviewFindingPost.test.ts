import { describe, expect, it } from "vite-plus/test";

import {
  patchHasFile,
  reviewFindingAgentMessage,
  reviewFindingCommentBody,
  reviewFindingConversationBody,
  reviewFindingPosition,
} from "./reviewFindingPost.ts";

const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,4 +10,5 @@ export function app() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  " return a;",
  "@@ -40,2 +41,3 @@",
  " first();",
  "+second();",
  " third();",
  "diff --git a/src/notes.md b/src/notes.md",
  "--- a/src/notes.md",
  "+++ b/src/notes.md",
  "@@ -1,2 +1,3 @@",
  " # Notes",
  "--- removed rule",
  "+++ b/fake.ts",
  "+tail",
  "diff --git a/src/other.ts b/src/other.ts",
  "--- a/src/other.ts",
  "+++ b/src/other.ts",
  "@@ -3 +3 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("reviewFindingPosition", () => {
  it("anchors an added line on the new side", () => {
    expect(reviewFindingPosition(patch, "src/app.ts", 11)).toEqual({
      position: { kind: "added", newLine: 11 },
    });
  });

  it("anchors a context line on the right side with both line numbers", () => {
    expect(reviewFindingPosition(patch, "src/app.ts", 13)).toEqual({
      position: { kind: "context", oldLine: 12, newLine: 13, side: "right" },
    });
    expect(reviewFindingPosition(patch, "src/app.ts", 41)).toEqual({
      position: { kind: "context", oldLine: 40, newLine: 41, side: "right" },
    });
  });

  it("returns null for a line outside every hunk", () => {
    expect(reviewFindingPosition(patch, "src/app.ts", 25)).toBeNull();
    expect(reviewFindingPosition(patch, "src/app.ts", 9)).toBeNull();
  });

  it("returns null for a file the patch does not touch", () => {
    expect(reviewFindingPosition(patch, "src/missing.ts", 1)).toBeNull();
    expect(patchHasFile(patch, "src/missing.ts")).toBe(false);
    expect(patchHasFile(patch, "src/app.ts")).toBe(true);
  });

  it("reads each file's own hunks in a multi-file patch", () => {
    expect(reviewFindingPosition(patch, "src/other.ts", 3)).toEqual({
      position: { kind: "added", newLine: 3 },
    });
    expect(reviewFindingPosition(patch, "src/other.ts", 11)).toBeNull();
  });

  it("treats header-looking lines inside a hunk as source lines", () => {
    expect(reviewFindingPosition(patch, "src/notes.md", 2)).toEqual({
      position: { kind: "added", newLine: 2 },
    });
    expect(reviewFindingPosition(patch, "src/notes.md", 3)).toEqual({
      position: { kind: "added", newLine: 3 },
    });
    expect(patchHasFile(patch, "fake.ts")).toBe(false);
  });

  it("anchors a range on its last line and keeps its first line", () => {
    expect(reviewFindingPosition(patch, "src/app.ts", 10, 12)).toEqual({
      position: { kind: "added", newLine: 12 },
      startLine: 10,
    });
  });

  it("drops the range when its end is outside the diff or in another hunk", () => {
    expect(reviewFindingPosition(patch, "src/app.ts", 11, 30)).toEqual({
      position: { kind: "added", newLine: 11 },
    });
    expect(reviewFindingPosition(patch, "src/app.ts", 11, 42)).toEqual({
      position: { kind: "added", newLine: 11 },
    });
  });

  it("names a renamed file's old path, which GitLab places a comment by", () => {
    const renamed = [
      "diff --git a/src/a.ts b/src/b.ts",
      "similarity index 90%",
      "rename from src/a.ts",
      "rename to src/b.ts",
      "--- a/src/a.ts",
      "+++ b/src/b.ts",
      "@@ -10,2 +10,2 @@",
      " keep();",
      "-old();",
      "+new();",
    ].join("\n");
    expect(reviewFindingPosition(renamed, "src/b.ts", 10)).toEqual({
      position: { kind: "context", oldLine: 10, newLine: 10, side: "right" },
      oldPath: "src/a.ts",
    });
    expect(reviewFindingPosition(patch, "src/app.ts", 11)).not.toHaveProperty("oldPath");
  });

  it("reads quoted paths", () => {
    const quoted = [
      String.raw`diff --git "a/src\\notes.ts" "b/src\\notes.ts"`,
      String.raw`--- "a/src\\notes.ts"`,
      String.raw`+++ "b/src\\notes.ts"`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(reviewFindingPosition(quoted, String.raw`src\notes.ts`, 1)).toEqual({
      position: { kind: "added", newLine: 1 },
    });
  });
});

describe("review finding bodies", () => {
  const finding = {
    severity: "major" as const,
    title: "Null deref on empty list",
    body: "    indented code\n\nMore text.  \n\n",
    path: "src/app.ts",
    line: 11,
    endLine: 12,
    headSha: "abcdef0123456789",
  };

  it("heads the comment with severity and title and keeps leading whitespace", () => {
    expect(reviewFindingCommentBody(finding)).toBe(
      "**Major: Null deref on empty list**\n\n    indented code\n\nMore text.",
    );
  });

  it("omits the severity and an empty body", () => {
    expect(reviewFindingCommentBody({ title: "Rename this", body: " \n" })).toBe("**Rename this**");
  });

  it("names the location in a conversation comment, and the commit once the head moved", () => {
    expect(reviewFindingConversationBody(finding, "abcdef0123456789")).toBe(
      "`src/app.ts:11-12`\n\n**Major: Null deref on empty list**\n\n    indented code\n\nMore text.",
    );
    expect(reviewFindingConversationBody(finding, "fedcba")).toMatch(
      /^`src\/app\.ts:11-12` at abcdef0\n\n/,
    );
    expect(
      reviewFindingConversationBody({ title: "Overall", body: "", headSha: null }, "fedcba"),
    ).toBe("**Overall**");
  });

  it("quotes the finding in the message sent to the agent", () => {
    expect(
      reviewFindingAgentMessage({ findingId: "3", ...finding, endLine: undefined }, "Why?"),
    ).toBe("**Re: finding 3** — Null deref on empty list (`src/app.ts:11`)\n\nWhy?");
    expect(reviewFindingAgentMessage({ findingId: "4", title: "Overall" }, "Agreed")).toBe(
      "**Re: finding 4** — Overall\n\nAgreed",
    );
  });
});
