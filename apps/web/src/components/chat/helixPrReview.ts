import type { HelixPrReviewSnapshot } from "@t3tools/client-runtime/helix-review-control";
import type { PullRequestReviewCommentDraft, PullRequestReviewVerdict } from "@t3tools/contracts";

export function helixPrActionText(value: unknown) {
  const text = JSON.stringify(value);
  if (encodeURIComponent(text).replace(/%[\da-f]{2}/giu, "x").length > 8 * 1024)
    throw new Error("This comment is too long for HX. Shorten it to fit within 8 KiB.");
  return text;
}

export function helixSuggestionBody(replacement: string) {
  const longest = Math.max(
    0,
    ...Array.from(replacement.matchAll(/`+/gu), ([match]) => match.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}suggestion\n${replacement}${!replacement || replacement.endsWith("\n") ? "" : "\n"}${fence}`;
}

export function helixPrReviewFingerprint(review: HelixPrReviewSnapshot) {
  return JSON.stringify({
    revision: review.revision,
    pr: review.pr,
    comments: review.comments,
    suggestions: review.suggestions,
    error: review.error,
  });
}

export function helixPrReviewInput(
  review: HelixPrReviewSnapshot,
  body: string,
  verdict: PullRequestReviewVerdict,
) {
  if (review.error) throw new Error(review.error);
  if (review.comments.some((comment) => comment.replyTo !== undefined))
    throw new Error(
      "Replies cannot be included in this review. Remove the reply draft and post it on the pull request.",
    );
  const comments: PullRequestReviewCommentDraft[] = review.comments.map((comment) => ({
    path: comment.path,
    position:
      comment.side === "LEFT"
        ? { kind: "deleted", oldLine: comment.line }
        : { kind: "added", newLine: comment.line },
    ...(comment.startLine < comment.line ? { startLine: comment.startLine } : {}),
    body: comment.body,
  }));
  for (const suggestion of review.suggestions) {
    if (!suggestion.accepted) continue;
    if (suggestion.error) throw new Error(suggestion.error);
    comments.push({
      path: suggestion.path,
      position: { kind: "added", newLine: suggestion.line },
      ...(suggestion.startLine < suggestion.line ? { startLine: suggestion.startLine } : {}),
      body: helixSuggestionBody(suggestion.replacement),
    });
  }
  if (verdict !== "approve" && !body.trim() && !comments.length)
    throw new Error("Add a summary, a comment, or an included suggestion before submitting.");
  return { expectedHeadSha: review.pr.headSha, verdict, body, comments };
}

export function helixPrLineLabel(anchor: {
  side?: "LEFT" | "RIGHT";
  startLine: number;
  line: number;
}) {
  return `${anchor.side === "LEFT" ? "Old" : "New"} ${anchor.startLine === anchor.line ? `line ${anchor.line}` : `lines ${anchor.startLine}–${anchor.line}`}`;
}
