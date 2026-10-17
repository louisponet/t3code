import * as Schema from "effect/Schema";

import { MessageId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

export const REVIEW_FINDING_COMMENT_MAX_CHARS = 16_000;

/** Posting is its own method: a client can only reach "posted" through the pull request. */
export const ReviewFindingSetStatusInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  status: Schema.Literals(["open", "dismissed"]),
});
export type ReviewFindingSetStatusInput = typeof ReviewFindingSetStatusInput.Type;

export const ReviewFindingPostInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
});
export type ReviewFindingPostInput = typeof ReviewFindingPostInput.Type;

export const ReviewFindingPostResult = Schema.Struct({
  postedAs: Schema.Literals(["inline", "comment"]),
});
export type ReviewFindingPostResult = typeof ReviewFindingPostResult.Type;

export const ReviewFindingCommentInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  messageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(REVIEW_FINDING_COMMENT_MAX_CHARS)),
  creationSource: Schema.Literals(["web", "mobile"]),
});
export type ReviewFindingCommentInput = typeof ReviewFindingCommentInput.Type;

const REVIEW_FINDING_FAILURE_MESSAGES = {
  not_found: "This finding no longer exists.",
  already_posted: "This finding was already posted to the pull request.",
  not_open: "Restore this finding before posting it.",
  pull_request_unavailable: "Could not read the pull request.",
  post_failed: "Could not post the finding to the pull request.",
  record_failed: "Could not update the finding.",
  send_failed: "Could not send the comment to the agent.",
} as const;

export const ReviewFindingFailureReason = Schema.Literals(
  Object.keys(REVIEW_FINDING_FAILURE_MESSAGES) as Array<
    keyof typeof REVIEW_FINDING_FAILURE_MESSAGES
  >,
);
export type ReviewFindingFailureReason = typeof ReviewFindingFailureReason.Type;

export class ReviewFindingError extends Schema.TaggedError<ReviewFindingError>()(
  "ReviewFindingError",
  {
    reason: ReviewFindingFailureReason,
    /** The host's or orchestrator's own words, which say what to fix. */
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const base = REVIEW_FINDING_FAILURE_MESSAGES[this.reason];
    return this.detail === undefined ? base : `${base} ${this.detail}`;
  }
}
