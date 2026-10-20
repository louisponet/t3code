/**
 * Findings live as turn items in the reviewing thread; this service is the only writer. It
 * resolves the pull request a finding belongs to when it is reported, and posts it there on the
 * user's say.
 */
import {
  CommandId,
  ReviewFindingError,
  TurnItemId,
  type OrchestrationV2ReviewFindingContent,
  type OrchestrationV2ReviewFindingPullRequest,
  type OrchestrationV2ReviewFindingStatus,
  type ProviderInstanceId,
  type PullRequestRef,
  type PullRequestSubmitReviewInput,
  type ReviewFindingCommentInput,
  type ReviewFindingPostInput,
  type ReviewFindingPostResult,
  type ReviewFindingSetStatusInput,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "./PullRequestService.ts";
import {
  patchHasFile,
  reviewFindingAgentMessage,
  reviewFindingCommentBody,
  reviewFindingConversationBody,
  reviewFindingPosition,
} from "./reviewFindingPost.ts";

const MAX_DIFF_PAGES = 20;
const MAX_DETAIL_CHARS = 1_000;

/** Its message is the report tool's failure, so it tells the reporting agent what to do next. */
export class ReviewFindingReportError extends Schema.TaggedError<ReviewFindingReportError>()(
  "ReviewFindingReportError",
  {
    reason: Schema.Literals([
      "not_active",
      "no_pull_request",
      "ambiguous_pull_request",
      "pull_request_not_linked",
      "unknown_finding",
      "finding_posted",
      "record_failed",
    ]),
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const detail = this.detail ?? "";
    switch (this.reason) {
      case "not_active":
        return "Reporting findings requires an active run owned by this MCP provider session.";
      case "no_pull_request":
        return "This thread has no linked pull request. Link it with link_pull_request first.";
      case "ambiguous_pull_request":
        return "This thread has several linked pull requests. Pass pullRequest to say which one these findings are about.";
      case "pull_request_not_linked":
        return "That pull request is not linked to this thread. Link it with link_pull_request first, or omit pullRequest to use the thread's current pull request.";
      case "unknown_finding":
        return `This thread has no finding ${detail}. Omit id to report a new finding.`;
      case "finding_posted":
        return `Finding ${detail} was already posted to the pull request and can no longer be revised. Report a new finding instead.`;
      case "record_failed":
        return `Could not record the findings: ${detail}`;
    }
  }
}

export class ReviewFindingService extends Context.Service<
  ReviewFindingService,
  {
    readonly report: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly pullRequest: ThreadPullRequestKey | undefined;
      readonly findings: ReadonlyArray<
        OrchestrationV2ReviewFindingContent & { readonly id?: string }
      >;
    }) => Effect.Effect<
      {
        readonly pullRequest: OrchestrationV2ReviewFindingPullRequest;
        readonly findings: ReadonlyArray<{
          readonly id: string;
          readonly title: string;
          readonly revised: boolean;
        }>;
      },
      ReviewFindingReportError
    >;
    readonly setStatus: (
      input: ReviewFindingSetStatusInput,
    ) => Effect.Effect<void, ReviewFindingError>;
    readonly post: (
      input: ReviewFindingPostInput,
    ) => Effect.Effect<ReviewFindingPostResult, ReviewFindingError>;
    readonly comment: (input: ReviewFindingCommentInput) => Effect.Effect<void, ReviewFindingError>;
  }
>()("t3/pullRequest/ReviewFindingService") {}

/** Orchestrator rejections carry their reason in `cause`; their message only names the command. */
const detailOf = (error: Error) =>
  Array.from(
    typeof error.cause === "string" && error.cause.length > 0 ? error.cause : error.message,
  )
    .slice(0, MAX_DETAIL_CHARS)
    .join("");

const refOf = (
  projectId: PullRequestRef["projectId"],
  pullRequest: OrchestrationV2ReviewFindingPullRequest,
): PullRequestRef => ({
  projectId,
  host: pullRequest.host,
  repository: pullRequest.repository,
  number: pullRequest.number,
});

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  // Ids are allocated from the findings already recorded, and a status change must not land
  // between a post's host write and its record, so a thread's finding writes take turns. Threads
  // do not wait on each other's host round trips.
  const threadLocks = new Map<ThreadId, { readonly lock: Semaphore.Semaphore; pending: number }>();
  const inThreadOrder =
    (threadId: ThreadId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      // Suspended so finding, inserting and queueing on the lock is one synchronous step.
      Effect.suspend(() => {
        const held = threadLocks.get(threadId);
        const entry = held ?? { lock: Semaphore.makeUnsafe(1), pending: 0 };
        if (held === undefined) threadLocks.set(threadId, entry);
        entry.pending += 1;
        return entry.lock
          .withPermits(1)(effect)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.pending -= 1;
                if (entry.pending === 0) threadLocks.delete(threadId);
              }),
            ),
          );
      });

  const commandId = (threadId: ThreadId) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:review-finding:${threadId}:${uuid}`)),
    );

  const loadFindings = (threadId: ThreadId) =>
    threadManagement.getThreadRecords(threadId, ["runs", "turnItems"], {
      turnItemTypes: ["review_finding"],
      messageRoles: [],
    });

  const requireFinding = Effect.fn("ReviewFindingService.requireFinding")(function* (
    input: { readonly threadId: ThreadId; readonly turnItemId: TurnItemId },
    loadFailure: "record_failed" | "send_failed",
  ) {
    const records = yield* loadFindings(input.threadId).pipe(
      Effect.mapError(
        (error) => new ReviewFindingError({ reason: loadFailure, detail: detailOf(error) }),
      ),
    );
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    if (item?.type !== "review_finding") {
      return yield* new ReviewFindingError({ reason: "not_found" });
    }
    return { projectId: records.thread.projectId, item };
  });

  const recordStatus = (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly findingStatus: OrchestrationV2ReviewFindingStatus;
    readonly postedAs?: ReviewFindingPostResult["postedAs"];
  }) =>
    commandId(input.threadId).pipe(
      Effect.flatMap((id) =>
        threadManagement.dispatch({ type: "review_finding.status", commandId: id, ...input }),
      ),
      Effect.mapError(
        (error) => new ReviewFindingError({ reason: "record_failed", detail: detailOf(error) }),
      ),
      Effect.asVoid,
    );

  const report: ReviewFindingService["Service"]["report"] = Effect.fn(
    "ReviewFindingService.report",
  )(
    function* (input) {
      const records = yield* loadFindings(input.threadId).pipe(
        Effect.mapError(
          (error) =>
            new ReviewFindingReportError({ reason: "record_failed", detail: detailOf(error) }),
        ),
      );
      const run = ThreadManagementService.latestActiveRun(records);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== input.providerInstanceId
      ) {
        return yield* new ReviewFindingReportError({ reason: "not_active" });
      }
      const nodeId = run.rootNodeId;

      const links = visibleThreadPullRequests(threadPullRequestsOf(records.thread));
      const requested = input.pullRequest;
      // Stack sync links a reviewed layer's siblings too, so only a link someone made says which
      // pull request was reviewed.
      const own = links.filter((candidate) => candidate.source !== "stack");
      const link =
        requested === undefined
          ? own.length === 1
            ? own[0]!
            : null
          : (links.find((candidate) => threadPullRequestKeysEqual(candidate, requested)) ?? null);
      if (link === null) {
        return yield* new ReviewFindingReportError({
          reason:
            requested !== undefined
              ? "pull_request_not_linked"
              : own.length === 0
                ? "no_pull_request"
                : "ambiguous_pull_request",
        });
      }
      const pullRequest: OrchestrationV2ReviewFindingPullRequest = {
        host: normalizeThreadPullRequestKey(link).host,
        repository: link.repository,
        number: link.number,
        url: link.url,
      };
      // Fresh: a held detail can predate a push, pinning the findings to a head nobody reviewed.
      const headSha = yield* pullRequests
        .detail({ ...refOf(records.thread.projectId, pullRequest), allowStale: false })
        .pipe(
          Effect.map((detail) => detail.headSha ?? null),
          // Without a head the finding still records; it just cannot be posted inline later.
          Effect.catch((error) =>
            Effect.logWarning("Could not read the pull request head for review findings", {
              error: error.message,
            }).pipe(Effect.as(null)),
          ),
        );

      const existing = records.turnItems.flatMap((item) =>
        item.type === "review_finding" ? [item] : [],
      );
      let nextId =
        Math.max(0, ...existing.map((item) => Number(item.findingId)).filter(Number.isInteger)) + 1;
      const planned: Array<{
        readonly findingId: string;
        readonly turnItemId: TurnItemId;
        readonly revised: boolean;
        readonly content: OrchestrationV2ReviewFindingContent;
      }> = [];
      for (const { id, ...content } of input.findings) {
        if (id === undefined) {
          const findingId = String(nextId++);
          planned.push({
            findingId,
            turnItemId: TurnItemId.make(
              `turn-item:review-finding:${encodeURIComponent(input.threadId)}:${findingId}`,
            ),
            revised: false,
            content,
          });
          continue;
        }
        const item = existing.find((candidate) => candidate.findingId === id);
        if (item === undefined) {
          return yield* new ReviewFindingReportError({ reason: "unknown_finding", detail: id });
        }
        if (item.findingStatus === "posted") {
          return yield* new ReviewFindingReportError({ reason: "finding_posted", detail: id });
        }
        planned.push({ findingId: item.findingId, turnItemId: item.id, revised: true, content });
      }

      for (const finding of planned) {
        yield* threadManagement
          .dispatch({
            type: "review_finding.record",
            commandId: yield* commandId(input.threadId),
            threadId: input.threadId,
            runId: run.id,
            nodeId,
            turnItemId: finding.turnItemId,
            findingId: finding.findingId,
            ...finding.content,
            pullRequest,
            headSha,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ReviewFindingReportError({ reason: "record_failed", detail: detailOf(error) }),
            ),
          );
      }
      return {
        pullRequest,
        findings: planned.map((finding) => ({
          id: finding.findingId,
          title: finding.content.title,
          revised: finding.revised,
        })),
      };
    },
    (effect, input) => effect.pipe(inThreadOrder(input.threadId)),
  );

  const setStatus: ReviewFindingService["Service"]["setStatus"] = Effect.fn(
    "ReviewFindingService.setStatus",
  )(
    function* (input) {
      const { item } = yield* requireFinding(input, "record_failed");
      if (item.findingStatus === "posted") {
        return yield* new ReviewFindingError({ reason: "already_posted" });
      }
      if (item.findingStatus === input.status) return;
      yield* recordStatus({
        threadId: input.threadId,
        turnItemId: item.id,
        findingStatus: input.status,
      });
    },
    (effect, input) => effect.pipe(inThreadOrder(input.threadId)),
  );

  /** Null when the line is not in the diff; the diff arrives a page at a time. */
  const anchorIn = Effect.fn("ReviewFindingService.anchorIn")(function* (
    ref: PullRequestRef,
    path: string,
    line: number,
    endLine?: number,
  ) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DIFF_PAGES; page++) {
      const diff = yield* pullRequests.diff({
        ...ref,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const anchor = reviewFindingPosition(diff.patch, path, line, endLine);
      if (anchor !== null || patchHasFile(diff.patch, path)) return anchor;
      if (diff.nextCursor === null) return null;
      cursor = diff.nextCursor;
    }
    return null;
  });

  const post: ReviewFindingService["Service"]["post"] = Effect.fn("ReviewFindingService.post")(
    function* (input) {
      const { projectId, item } = yield* requireFinding(input, "record_failed");
      if (item.findingStatus === "posted") {
        return yield* new ReviewFindingError({ reason: "already_posted" });
      }
      if (item.findingStatus !== "open") {
        return yield* new ReviewFindingError({ reason: "not_open" });
      }
      const ref = refOf(projectId, item.pullRequest);
      const unavailable = (error: Error) =>
        new ReviewFindingError({ reason: "pull_request_unavailable", detail: detailOf(error) });
      const detail = yield* pullRequests
        .detail({ ...ref, allowStale: false })
        .pipe(Effect.mapError(unavailable));
      const review = detail.capabilities.review;

      // Lines only mean something on the head they were read at, so a moved head posts to the
      // conversation instead of anchoring on whatever code now sits there.
      let inlineReview: PullRequestSubmitReviewInput | null = null;
      if (
        detail.capabilities.diff &&
        review.inlineComment &&
        item.path !== undefined &&
        item.line !== undefined &&
        item.headSha !== null &&
        item.headSha === detail.headSha
      ) {
        const anchor = yield* anchorIn(
          ref,
          item.path,
          item.line,
          review.multilineComment === true ? item.endLine : undefined,
        ).pipe(Effect.mapError(unavailable));
        if (anchor !== null) {
          inlineReview = {
            ...ref,
            verdict: "comment",
            body: "",
            expectedHeadSha: item.headSha,
            comments: [
              {
                path: item.path,
                ...(anchor.oldPath === undefined ? {} : { oldPath: anchor.oldPath }),
                position: anchor.position,
                ...(anchor.startLine === undefined ? {} : { startLine: anchor.startLine }),
                body: reviewFindingCommentBody(item),
              },
            ],
          };
        }
      }

      const postedAs: ReviewFindingPostResult["postedAs"] =
        inlineReview === null ? "comment" : "inline";
      // A client that disconnects mid-post must not leave the comment on the host and the card
      // open, inviting a second post.
      yield* Effect.uninterruptible(
        (inlineReview === null
          ? pullRequests.comment({
              ...ref,
              body: reviewFindingConversationBody(item, detail.headSha ?? null),
            })
          : pullRequests.submitReview(inlineReview)
        ).pipe(
          Effect.mapError(
            (error) => new ReviewFindingError({ reason: "post_failed", detail: detailOf(error) }),
          ),
          Effect.andThen(
            recordStatus({
              threadId: input.threadId,
              turnItemId: item.id,
              findingStatus: "posted",
              postedAs,
            }),
          ),
        ),
      );
      return { postedAs };
    },
    (effect, input) => effect.pipe(inThreadOrder(input.threadId)),
  );

  const comment: ReviewFindingService["Service"]["comment"] = Effect.fn(
    "ReviewFindingService.comment",
  )(function* (input) {
    const { projectId, item } = yield* requireFinding(input, "send_failed");
    yield* threadManagement
      .sendToThread({
        projectId,
        commandId: CommandId.make(`review-finding-comment:${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        text: reviewFindingAgentMessage(item, input.text),
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: input.creationSource,
      })
      .pipe(
        Effect.mapError(
          (error) => new ReviewFindingError({ reason: "send_failed", detail: detailOf(error) }),
        ),
      );
  });

  return ReviewFindingService.of({ report, setStatus, post, comment });
});

export const layer = Layer.effect(ReviewFindingService, make);
