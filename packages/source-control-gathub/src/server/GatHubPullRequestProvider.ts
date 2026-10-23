import { SourceControlProviderKind, type PullRequestCapabilities } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import * as GatHubApi from "./GatHubApi.ts";
import * as Json from "./gatHubPullRequestJson.ts";
import { definition } from "../client/definition.ts";

const KIND = SourceControlProviderKind.make("gathub");

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["squash"],
  search: false,
  review: {
    inlineComment: false,
    reply: false,
    resolve: false,
    verdicts: ["approve", "request-changes", "comment"],
  },
  reviewers: { request: false, listCandidates: false },
  // GatHub rewrites a description but not a title, and the page edits both through one control.
  edit: { changeRequest: false, comment: true },
};

const Viewer = Schema.Struct({ user: Schema.String });
const DETAIL_TTL = Duration.seconds(5);

type PullRef = ProviderRepositoryRef & { readonly number: number };

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const api = yield* GatHubApi.GatHubApi;

  const failure = (operation: string, detail: string) =>
    new PullRequestProviderError({ provider: KIND, operation, reason: "failed", detail });

  const send = (
    operation: string,
    input: Pick<ProviderRepositoryRef, "cwd" | "host">,
    request: { readonly path: string; readonly body?: unknown },
  ) =>
    api.request({ ...request, cwd: input.cwd, host: input.host, operation }).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: KIND,
            operation,
            reason: error.reason,
            detail: error.detail,
            cause: error,
          }),
      ),
    );

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: Pick<ProviderRepositoryRef, "cwd" | "host">,
    path: string,
    schema: S,
  ) =>
    send(operation, input, { path }).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestProviderError({
                provider: KIND,
                operation,
                reason: "failed",
                detail: "GatHub returned an unreadable response.",
                cause,
              }),
          ),
        ),
      ),
    );

  const readPull = (operation: string, input: PullRef) =>
    read(operation, input, `/api/pulls/${input.number}`, Json.GatHubPullDetail);

  /**
   * One detail read carries every patch, and opening a pull request asks for its summary,
   * conversation, diff and file stats separately, so those display reads share one answer for a
   * few seconds. Keyed by checkout too: the credential, and so what may be seen, follows it.
   * Permissions and writes read fresh.
   */
  const displayed = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", host = "", repository = "", number = ""] = key.split("\n");
      return readPull("getChangeRequest", { cwd, host, repository, number: Number(number) });
    },
    { capacity: 8, timeToLive: (exit) => (exit._tag === "Success" ? DETAIL_TTL : Duration.zero) },
  );
  const displayKey = (input: PullRef) =>
    [input.cwd, input.host, input.repository, input.number].join("\n");
  const readDisplayed = (input: PullRef) => Cache.get(displayed, displayKey(input));

  /** Every GatHub write is fenced on the head it was decided against. */
  const write = Effect.fn("GatHubPullRequestProvider.write")(function* (
    operation: string,
    input: PullRef,
    route: string,
    body: Readonly<Record<string, unknown>>,
    expectedHead?: string,
  ) {
    const head = expectedHead ?? (yield* readPull(operation, input)).head;
    yield* send(operation, input, {
      path: `/api/pulls/${input.number}${route}`,
      body: { ...body, expected_head: head },
    }).pipe(Effect.ensuring(Cache.invalidate(displayed, displayKey(input))));
  });

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    getViewer: (input) =>
      read(
        "getViewer",
        { cwd: input.cwd, host: input.host ?? "gathub.gattaca.com" },
        "/api/identity",
        Viewer,
      ).pipe(Effect.map((viewer) => viewer.user)),
    // GatHub answers every pull request the account may see in one list, without paging.
    listChangeRequests: Effect.fn("GatHubPullRequestProvider.listChangeRequests")(
      function* (input) {
        // GatHub rows name no requested reviewers, so the page would drop every one of them.
        if (input.involvement === "reviewing")
          return { items: [], truncated: false, continues: false };
        const { pulls, pulls_truncated } = yield* read(
          "listChangeRequests",
          input,
          "/api/pulls",
          Json.GatHubPulls,
        );
        const before = input.cursor?.updatedBefore;
        const seen = new Set(input.cursor?.seenAt ?? []);
        const rows = pulls
          .map((pull) => Json.toChangeRequest(pull, input.host))
          .filter(
            (pull) =>
              (input.state === "all" || pull.state === input.state) &&
              (input.involvement !== "authored" ||
                pull.author?.login.toLowerCase() === input.viewer.toLowerCase()) &&
              (before === undefined ||
                pull.updatedAt < before ||
                (pull.updatedAt === before && !seen.has(pull.number))),
          )
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const limit = Math.max(1, input.limit);
        return {
          items: rows.slice(0, limit),
          truncated: pulls_truncated || rows.length > limit,
          continues: rows.length > limit,
        };
      },
    ),
    // A pull whose detail could not be read is left out rather than failing every row's count.
    listChangeRequestStats: (input) =>
      Effect.forEach(
        input.changeRequests,
        (changeRequest) =>
          readDisplayed({ ...input, ...changeRequest }).pipe(
            Effect.map((detail) => {
              const { additions, deletions } = Json.toDetail(detail, input.host);
              return [{ ...changeRequest, additions, deletions }];
            }),
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: 4 },
      ).pipe(Effect.map((stats) => stats.flat())),
    getChangeRequest: (input) =>
      readDisplayed(input).pipe(Effect.map((detail) => Json.toDetail(detail, input.host))),
    getChangeRequestActivity: (input) => readDisplayed(input).pipe(Effect.map(Json.toActivity)),
    getViewerPermissions: (input) =>
      readPull("getViewerPermissions", input).pipe(Effect.map(Json.toViewerPermissions)),
    getDiff: Effect.fn("GatHubPullRequestProvider.getDiff")(function* (input) {
      if (input.commit !== undefined)
        return yield* failure("getDiff", "GatHub shows a pull request's diff as a whole.");
      return Json.toDiff(yield* readDisplayed(input));
    }),
    getFileStats: (input) =>
      readDisplayed(input).pipe(
        Effect.map((detail) => ({
          files: Json.fileStats(detail),
          truncated: detail.files_truncated,
        })),
      ),
    runAction: Effect.fn("GatHubPullRequestProvider.runAction")(function* (input) {
      switch (input.action) {
        case "merge": {
          const pull = yield* readPull("merge", input);
          if (pull.merged) return;
          yield* write(
            "merge",
            input,
            "/merge",
            { title: pull.merge.default_title || pull.title, message: pull.body ?? "" },
            pull.head,
          );
          return;
        }
        case "close":
        case "reopen":
          return yield* write(input.action, input, "/state", {
            state: input.action === "close" ? "closed" : "open",
          });
        case "ready":
          return yield* write("ready", input, "/draft", { draft: false });
        default:
          return yield* failure(input.action, `GatHub cannot ${input.action} a pull request.`);
      }
    }),
    comment: (input) => write("comment", input, "/comments", { body: input.body }),
    updateComment: Effect.fn("GatHubPullRequestProvider.updateComment")(function* (input) {
      if (input.kind !== "issue-comment" || !/^\d+$/u.test(input.commentId))
        return yield* failure("updateComment", "Only GatHub comments can be edited.");
      yield* write("updateComment", input, `/comments/${input.commentId}`, { body: input.body });
    }),
    submitReview: Effect.fn("GatHubPullRequestProvider.submitReview")(function* (input) {
      if (input.comments.length > 0)
        return yield* failure("submitReview", "GatHub has no line comments.");
      if (input.verdict === "comment")
        return yield* write(
          "submitReview",
          input,
          "/comments",
          { body: input.body },
          input.expectedHeadSha,
        );
      yield* write(
        "submitReview",
        input,
        "/reviews",
        { state: input.verdict === "approve" ? "approve" : "request_changes", body: input.body },
        input.expectedHeadSha,
      );
    }),
    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    setReviewerRequest: () =>
      Effect.fail(failure("setReviewerRequest", "GatHub has no reviewer requests.")),
    replyToThread: () => Effect.fail(failure("replyToThread", "GatHub has no review threads.")),
    setReaction: () => Effect.fail(failure("setReaction", "GatHub has no reactions.")),
    setThreadResolution: () =>
      Effect.fail(failure("setThreadResolution", "GatHub has no review threads.")),
  };
  return provider;
});
