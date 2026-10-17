import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
  type PullRequestCommentInput,
  type PullRequestDiffInput,
  type PullRequestSubmitReviewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as ReviewFindingService from "./ReviewFindingService.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const link = {
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  source: "agent",
  linkedAt: "2026-10-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
};
const pullRequest = {
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url: link.url,
};

const finding = (findingId: string, overrides: Record<string, unknown> = {}) => ({
  id: TurnItemId.make(`turn-item:review-finding:thread-1:${findingId}`),
  threadId,
  runId: "run-1",
  nodeId: "node-1",
  type: "review_finding",
  findingId,
  severity: "major",
  title: `Finding ${findingId}`,
  body: "Explain it.",
  path: "src/app.ts",
  line: 10,
  endLine: 12,
  pullRequest,
  headSha: "head-1",
  findingStatus: "open",
  ...overrides,
});

const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,2 +10,4 @@",
  " keep();",
  "+added();",
  "+more();",
  " tail();",
  "",
].join("\n");

const withService = <A, E>(
  body: (input: {
    readonly service: ReviewFindingService.ReviewFindingService["Service"];
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
    readonly comments: Array<PullRequestCommentInput>;
    readonly reviews: Array<PullRequestSubmitReviewInput>;
    readonly diffs: Array<PullRequestDiffInput>;
    readonly sent: Array<ThreadManagementService.ThreadManagementSendInput>;
  }) => Effect.Effect<A, E, ReviewFindingService.ReviewFindingService>,
  options: {
    readonly items?: ReadonlyArray<unknown>;
    readonly links?: ReadonlyArray<unknown>;
    readonly headSha?: string;
    readonly detailFails?: boolean;
    readonly postFails?: boolean;
    readonly firstDiffPage?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const comments: Array<PullRequestCommentInput> = [];
    const reviews: Array<PullRequestSubmitReviewInput> = [];
    const diffs: Array<PullRequestDiffInput> = [];
    const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
    const postFailure = new PullRequestOperationError({ operation: "post", detail: "rejected" });
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId, pullRequests: options.links ?? [link] },
            runs: [
              {
                id: "run-1",
                ordinal: 1,
                status: "running",
                rootNodeId: "node-1",
                providerInstanceId,
              },
            ],
            turnItems: options.items ?? [],
          } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return {} as never;
          }),
        sendToThread: (input) =>
          Effect.sync(() => {
            sent.push(input);
            return {} as never;
          }),
      }),
      Layer.mock(PullRequestService.PullRequestService)({
        detail: () =>
          options.detailFails
            ? Effect.fail(new PullRequestOperationError({ operation: "detail", detail: "down" }))
            : Effect.succeed({
                headSha: options.headSha ?? "head-1",
                capabilities: {
                  diff: true,
                  review: { inlineComment: true, multilineComment: true },
                },
              } as never),
        diff: (input) =>
          Effect.sync(() => {
            diffs.push(input);
            return input.cursor === undefined && options.firstDiffPage !== undefined
              ? { patch: options.firstDiffPage, truncated: false, nextCursor: "page-2" }
              : { patch, truncated: false, nextCursor: null };
          }),
        comment: (input) =>
          options.postFails
            ? Effect.fail(postFailure)
            : Effect.sync(() => void comments.push(input)),
        submitReview: (input) =>
          options.postFails
            ? Effect.fail(postFailure)
            : Effect.sync(() => void reviews.push(input)),
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ReviewFindingService.ReviewFindingService;
      return yield* body({ service, dispatched, comments, reviews, diffs, sent });
    }).pipe(Effect.provide(ReviewFindingService.layer.pipe(Layer.provide(dependencies))));
  });

it.effect("report numbers new findings after the highest id and pins them to the PR head", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        const result = yield* service.report({
          threadId,
          providerInstanceId,
          pullRequest: undefined,
          findings: [
            { title: "New one", body: "" },
            { id: "2", title: "Revised", body: "Better words." },
            { title: "New two", body: "", path: "src/b.ts", line: 3 },
          ],
        });
        assert.deepEqual(result.findings, [
          { id: "3", title: "New one", revised: false },
          { id: "2", title: "Revised", revised: true },
          { id: "4", title: "New two", revised: false },
        ]);
        assert.deepEqual(
          dispatched.map(
            (command): string | false =>
              command.type === "review_finding.record" && command.turnItemId,
          ),
          [
            "turn-item:review-finding:thread-1:3",
            "turn-item:review-finding:thread-1:2",
            "turn-item:review-finding:thread-1:4",
          ],
        );
        assert.deepInclude(dispatched[2] as object, {
          runId: "run-1",
          nodeId: "node-1",
          findingId: "4",
          path: "src/b.ts",
          line: 3,
          pullRequest,
          headSha: "head-1",
        });
      }),
    { items: [finding("1"), finding("2"), finding("note")] },
  ),
);

it.effect("report refuses an unknown or posted id and records nothing", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        const report = (id: string) =>
          service
            .report({
              threadId,
              providerInstanceId,
              pullRequest: undefined,
              findings: [
                { title: "New", body: "" },
                { id, title: "Again", body: "" },
              ],
            })
            .pipe(Effect.flip);
        assert.equal((yield* report("1")).reason, "finding_posted");
        const unknown = yield* report("9");
        assert.equal(unknown.reason, "unknown_finding");
        assert.include(unknown.message, "Omit id");
        assert.equal(dispatched.length, 0);
      }),
    { items: [finding("1", { findingStatus: "posted" })] },
  ),
);

it.effect("report needs the caller's active run and a pull request linked to the thread", () =>
  Effect.gen(function* () {
    const reasonOf = (
      input: { readonly caller?: string; readonly pullRequest?: { number: number } },
      links?: ReadonlyArray<unknown>,
    ) =>
      withService(
        ({ service }) =>
          service
            .report({
              threadId,
              providerInstanceId: ProviderInstanceId.make(input.caller ?? "codex"),
              pullRequest:
                input.pullRequest === undefined
                  ? undefined
                  : { host: "github.com", repository: "acme/app", ...input.pullRequest },
              findings: [{ title: "New", body: "" }],
            })
            .pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
            ),
        links === undefined ? {} : { links },
      );
    assert.equal(yield* reasonOf({ caller: "claude" }), "not_active");
    assert.equal(yield* reasonOf({}, []), "no_pull_request");
    assert.equal(yield* reasonOf({ pullRequest: { number: 8 } }), "pull_request_not_linked");
    const second = { ...link, number: 8, url: "https://github.com/acme/app/pull/8" };
    assert.equal(yield* reasonOf({}, [link, second]), "ambiguous_pull_request");
  }),
);

it.effect("report ignores stack siblings that sync linked to the reviewed pull request", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        const result = yield* service.report({
          threadId,
          providerInstanceId,
          pullRequest: undefined,
          findings: [{ title: "New", body: "" }],
        });
        assert.equal(result.pullRequest.number, 7);
        const [record] = dispatched;
        assert.equal(
          record?.type === "review_finding.record" ? record.pullRequest.number : null,
          7,
        );
      }),
    {
      links: [
        link,
        {
          ...link,
          number: 8,
          url: "https://github.com/acme/app/pull/8",
          source: "stack",
          linkedAt: "2026-10-02T00:00:00.000Z",
        },
      ],
    },
  ),
);

it.effect("report still records when the pull request head cannot be read", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        yield* service.report({
          threadId,
          providerInstanceId,
          pullRequest: { host: "github.com", repository: "Acme/App", number: 7 },
          findings: [{ title: "New", body: "" }],
        });
        assert.deepInclude(dispatched[0] as object, { pullRequest, headSha: null });
      }),
    { detailFails: true },
  ),
);

it.effect("post comments inline on the reported head, following the diff's pages", () =>
  withService(
    ({ service, dispatched, reviews, comments, diffs }) =>
      Effect.gen(function* () {
        const result = yield* service.post({ threadId, turnItemId: finding("1").id });
        assert.deepEqual(result, { postedAs: "inline" });
        assert.deepEqual(
          diffs.map((input) => input.cursor),
          [undefined, "page-2"],
        );
        assert.equal(comments.length, 0);
        assert.deepEqual(reviews, [
          {
            projectId,
            host: "github.com",
            repository: "acme/app",
            number: 7,
            verdict: "comment",
            body: "",
            expectedHeadSha: "head-1",
            comments: [
              {
                path: "src/app.ts",
                position: { kind: "added", newLine: 12 },
                startLine: 10,
                body: "**Major: Finding 1**\n\nExplain it.",
              },
            ],
          },
        ]);
        assert.deepInclude(dispatched[0] as object, {
          type: "review_finding.status",
          turnItemId: finding("1").id,
          findingStatus: "posted",
          postedAs: "inline",
        });
      }),
    {
      items: [finding("1")],
      firstDiffPage: patch.replaceAll("src/app.ts", "src/other.ts"),
    },
  ),
);

it.effect("post falls back to a conversation comment once the head moved", () =>
  withService(
    ({ service, reviews, comments, diffs }) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* service.post({ threadId, turnItemId: finding("1").id }), {
          postedAs: "comment",
        });
        assert.equal(diffs.length, 0);
        assert.equal(reviews.length, 0);
        assert.equal(
          comments[0]?.body,
          "`src/app.ts:10-12` at head-1\n\n**Major: Finding 1**\n\nExplain it.",
        );
      }),
    { items: [finding("1")], headSha: "head-2" },
  ),
);

it.effect("post refuses findings that are not open, and a failed post leaves them open", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        const post = (findingId: string) =>
          service.post({ threadId, turnItemId: finding(findingId).id }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          );
        assert.equal(yield* post("1"), "already_posted");
        assert.equal(yield* post("2"), "not_open");
        assert.equal(yield* post("3"), "post_failed");
        assert.equal(yield* post("9"), "not_found");
        assert.equal(dispatched.length, 0);
      }),
    {
      items: [
        finding("1", { findingStatus: "posted" }),
        finding("2", { findingStatus: "dismissed" }),
        finding("3"),
      ],
      postFails: true,
    },
  ),
);

it.effect("setStatus dismisses and restores, but never reopens a posted finding", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        yield* service.setStatus({ threadId, turnItemId: finding("2").id, status: "dismissed" });
        const posted = yield* service
          .setStatus({ threadId, turnItemId: finding("1").id, status: "open" })
          .pipe(Effect.flip);
        assert.equal(posted.reason, "already_posted");
        assert.equal(dispatched.length, 1);
        assert.deepInclude(dispatched[0] as object, {
          type: "review_finding.status",
          turnItemId: finding("2").id,
          findingStatus: "dismissed",
        });
      }),
    { items: [finding("1", { findingStatus: "posted" }), finding("2")] },
  ),
);

it.effect("comment queues a user message that quotes the finding", () =>
  withService(
    ({ service, sent }) =>
      Effect.gen(function* () {
        const messageId = MessageId.make("message-1");
        yield* service.comment({
          threadId,
          turnItemId: finding("2").id,
          messageId,
          text: "Is this reachable?",
          creationSource: "mobile",
        });
        assert.deepInclude(sent[0] as object, {
          projectId,
          threadId,
          messageId,
          text: "**Re: finding 2** — Finding 2 (`src/app.ts:10-12`)\n\nIs this reachable?",
          mode: "queue",
          createdBy: "user",
          creationSource: "mobile",
        });
      }),
    { items: [finding("2")] },
  ),
);
