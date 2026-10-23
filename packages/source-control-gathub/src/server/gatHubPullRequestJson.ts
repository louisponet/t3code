import {
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestChecksState,
  type PullRequestComment,
  type PullRequestReviewDecision,
  type PullRequestState,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import { gatHubPullRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { sortChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestActivity,
  ProviderChangeRequestDetail,
  ProviderDiffSlice,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Schema from "effect/Schema";

/** GatHub writes UTC as `2026-10-23 17:02:28`. */
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u));
const iso = (timestamp: string) => `${timestamp.replace(" ", "T")}Z`;

export const GatHubPull = Schema.Struct({
  id: PositiveInt,
  title: TrimmedNonEmptyString,
  author: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  head: TrimmedNonEmptyString,
  created_at: Timestamp,
  updated_at: Timestamp,
  merged_at: Schema.NullOr(Timestamp),
  comment_count: Schema.Int,
  can_comment: Schema.Boolean,
  can_manage: Schema.Boolean,
});
export type GatHubPull = typeof GatHubPull.Type;

export const GatHubPulls = Schema.Struct({
  pulls: Schema.Array(GatHubPull),
  pulls_truncated: Schema.Boolean,
});

const GatHubCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: Schema.String,
});

const GatHubComment = Schema.Struct({
  id: Schema.Union([Schema.Int, Schema.String]),
  author: TrimmedNonEmptyString,
  body: Schema.String,
  created_at: Timestamp,
  edited_at: Schema.optional(Schema.NullOr(Timestamp)),
  can_edit: Schema.optional(Schema.Boolean),
});

const GatHubReview = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Int, Schema.String])),
  reviewer: TrimmedNonEmptyString,
  state: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Timestamp,
});

const GatHubFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  status: Schema.optional(Schema.String),
  // A file too large to show arrives with neither counts nor a patch.
  additions: Schema.NullOr(Schema.Int),
  deletions: Schema.NullOr(Schema.Int),
  patch: Schema.optional(Schema.NullOr(Schema.String)),
  truncated: Schema.optional(Schema.Boolean),
});

export const GatHubPullDetail = Schema.Struct({
  ...GatHubPull.fields,
  body: Schema.NullOr(Schema.String),
  can_review: Schema.Boolean,
  checks: Schema.Array(GatHubCheck),
  comments: Schema.Array(GatHubComment),
  reviews: Schema.Array(GatHubReview),
  files: Schema.Array(GatHubFile),
  files_truncated: Schema.Boolean,
  merge: Schema.Struct({
    can_merge: Schema.Boolean,
    default_title: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  review_status: Schema.Struct({
    approved_by: Schema.Array(Schema.String),
    changes_requested_by: Schema.Array(Schema.String),
    satisfied: Schema.Boolean,
  }),
});
export type GatHubPullDetail = typeof GatHubPullDetail.Type;

const actor = (login: string): PullRequestActor => ({ login, name: null, avatarUrl: null });

export function pullState(pull: Pick<GatHubPull, "state" | "merged">): PullRequestState {
  return pull.merged ? "merged" : pull.state;
}

/** GatHub records when a pull merged but not when one closed, which its last update is. */
function closedAt(pull: GatHubPull): string | null {
  if (pull.merged_at !== null) return iso(pull.merged_at);
  return pull.state === "closed" ? iso(pull.updated_at) : null;
}

export function toChangeRequest(pull: GatHubPull, host: string): ProviderChangeRequest {
  return {
    number: pull.id,
    title: pull.title,
    url: gatHubPullRequestUrl(host, pull.id),
    author: actor(pull.author),
    headBranch: pull.source,
    baseBranch: pull.target,
    state: pullState(pull),
    isDraft: pull.draft,
    mergeability: "unknown",
    // A listed pull carries no line counts; only its detail read has the files.
    additions: 0,
    deletions: 0,
    createdAt: iso(pull.created_at),
    mergedAt: pull.merged_at === null ? null : iso(pull.merged_at),
    closedAt: closedAt(pull),
    updatedAt: iso(pull.updated_at),
    reviewRequestLogins: [],
    labels: [],
  };
}

function checkStatus(status: string): PullRequestCheck["status"] {
  switch (status) {
    case "success":
    case "succeeded":
      return "success";
    case "failure":
    case "failed":
    case "rejected":
    case "error":
      return "failure";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

function checksState(checks: ReadonlyArray<PullRequestCheck>): PullRequestChecksState | null {
  if (checks.length === 0) return null;
  if (checks.some((check) => check.status === "failure")) return "failing";
  if (checks.some((check) => check.status === "pending")) return "pending";
  return "passing";
}

function reviewDecision(detail: GatHubPullDetail): PullRequestReviewDecision | null {
  const status = detail.review_status;
  if (status.changes_requested_by.length > 0) return "changes-requested";
  if (!status.satisfied) return "review-required";
  return status.approved_by.length > 0 ? "approved" : null;
}

export function toViewerPermissions(detail: GatHubPullDetail): PullRequestViewerPermissions {
  const state = pullState(detail);
  return {
    actions: [
      ...(detail.can_manage && state === "open"
        ? ([...(detail.draft ? (["ready"] as const) : []), "close"] as const)
        : detail.can_manage && state === "closed"
          ? (["reopen"] as const)
          : []),
      ...(detail.merge.can_merge && state === "open" ? (["merge"] as const) : []),
    ],
    comment: detail.can_comment,
    resolve: false,
    verdicts: detail.can_review
      ? ["approve", "request-changes", "comment"]
      : detail.can_comment
        ? ["comment"]
        : [],
    requestReviewers: false,
  };
}

export function fileStats(detail: GatHubPullDetail) {
  return detail.files.map((file) => ({
    path: file.path,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  }));
}

export function toDetail(detail: GatHubPullDetail, host: string): ProviderChangeRequestDetail {
  const checks = sortChecks(
    detail.checks.map((check) => ({
      name: check.name,
      status: checkStatus(check.status),
      description: null,
      url: null,
    })),
  );
  const state = checksState(checks);
  const canMerge = detail.merge.can_merge && pullState(detail) === "open";
  // A file too large to count would make any total a guess; 0/0 is shown as no count.
  const counted = detail.files.every((file) => file.additions !== null && file.deletions !== null);
  const files = counted ? fileStats(detail) : [];
  return {
    ...toChangeRequest(detail, host),
    headSha: detail.head,
    body: detail.body ?? "",
    mergeability: canMerge ? "mergeable" : "unknown",
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    changedFiles: detail.files.length,
    mergedAt: detail.merged_at === null ? null : iso(detail.merged_at),
    closedAt: closedAt(detail),
    reviewers: [
      ...new Set([
        ...detail.review_status.approved_by,
        ...detail.review_status.changes_requested_by,
      ]),
    ].map(actor),
    reviewDecision: reviewDecision(detail),
    checks,
    ...(state === null ? {} : { checksState: state }),
    // GatHub only squashes.
    mergeCapabilities: { merge: false, squash: canMerge, rebase: false },
    viewerPermissions: toViewerPermissions(detail),
  };
}

const REVIEW_STATES: Readonly<Record<string, string>> = {
  approved: "approved",
  changes_requested: "changes_requested",
  commented: "commented",
  // An emergency approval is still an approval to anyone reading the conversation.
  override: "approved",
};

export function toActivity(detail: GatHubPullDetail): ProviderChangeRequestActivity {
  const comments: Array<PullRequestComment> = [
    ...detail.comments.map((comment) => ({
      id: String(comment.id),
      kind: "issue-comment" as const,
      author: actor(comment.author),
      body: comment.body,
      createdAt: iso(comment.created_at),
      ...(comment.edited_at == null ? {} : { editedAt: iso(comment.edited_at) }),
      url: null,
      path: null,
      reviewState: null,
      ...(comment.can_edit === undefined ? {} : { canEdit: comment.can_edit }),
    })),
    ...detail.reviews.map((review) => ({
      id:
        review.id === undefined
          ? `review:${review.reviewer}:${review.created_at}`
          : `review:${review.id}`,
      kind: "review" as const,
      author: actor(review.reviewer),
      body: review.body ?? "",
      createdAt: iso(review.created_at),
      url: null,
      path: null,
      reviewState: REVIEW_STATES[review.state] ?? "commented",
    })),
  ];
  return {
    author: actor(detail.author),
    comments: comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    commentCount: comments.length,
    commentsTruncated: false,
    reviewThreads: [],
    // Listed commits become diff scopes, and GatHub serves only the whole pull request's diff.
    commits: [],
  };
}

function headerOnly(file: GatHubPullDetail["files"][number]): string {
  const a = quoteGitPatchPath(`a/${file.path}`);
  const b = quoteGitPatchPath(`b/${file.path}`);
  return [
    `diff --git ${a} ${b}`,
    ...(file.status === "added" ? ["new file mode 100644"] : []),
    ...(file.status === "deleted" || file.status === "removed" ? ["deleted file mode 100644"] : []),
    `--- ${file.status === "added" ? "/dev/null" : a}`,
    `+++ ${file.status === "deleted" || file.status === "removed" ? "/dev/null" : b}`,
    "",
  ].join("\n");
}

export function toDiff(detail: GatHubPullDetail): ProviderDiffSlice {
  const omitted = (file: GatHubPullDetail["files"][number]) =>
    file.truncated === true || !file.patch;
  const omittedFileStats = fileStats(detail).filter((_, index) => omitted(detail.files[index]!));
  // A file too large to show still changed, so it keeps its header rather than vanishing.
  const patch = detail.files
    .map((file) =>
      omitted(file)
        ? headerOnly(file)
        : file.patch!.endsWith("\n")
          ? file.patch!
          : `${file.patch}\n`,
    )
    .join("");
  return {
    patch,
    truncated: detail.files_truncated || omittedFileStats.length > 0,
    nextCursor: null,
    ...(omittedFileStats.length === 0 ? {} : { omittedFileStats }),
  };
}
