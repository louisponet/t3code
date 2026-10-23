import { SourceControlProviderKind, type PullRequestCapabilities } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import {
  parseDiffFilePaths,
  parseDiffFileRevisions,
} from "@t3tools/source-control-core/server/diffFileRevisions";
import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";

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
  // GatHub keeps no viewed marks, so they live here, fenced on each file's blob in the patch.
  viewedFiles: "environment",
  review: {
    inlineComment: false,
    reply: false,
    resolve: false,
    verdicts: ["approve", "request-changes", "comment"],
  },
  reviewers: { request: false, listCandidates: false },
  // GatHub rewrites a description but not a title, and the page edits both through one control.
  edit: { changeRequest: false, comment: true },
  // GatHub cancels a run but has no rerun: dispatch starts only workflows with manual inputs.
  cancelChecks: true,
};

const Viewer = Schema.Struct({ user: Schema.String });
const Run = Schema.Struct({ can_cancel: Schema.Boolean });
const DETAIL_TTL = Duration.seconds(5);
const FAILED_READ_HOLD = Duration.seconds(10);
const SCOPE_BATCH = 8;

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

  /**
   * Only a run's own read says whether this viewer may cancel it, and that read carries the run's
   * log so far, so each still-going run is asked once and its answer held until it finishes, the
   * viewer cancels it, or the pull leaves the list. Held per checkout, since the credential, and
   * so the viewer, follows it; a run that cannot be read offers no cancel.
   */
  const runCancellable = new Map<string, Map<string, boolean>>();
  const runsKey = (input: ProviderRepositoryRef, number: number) =>
    [input.cwd, input.host, number].join("\n");
  const cancellableRuns = (input: ProviderRepositoryRef, detail: Json.GatHubPullDetail) => {
    const active = Json.activeRunIds(detail);
    const key = runsKey(input, detail.id);
    const held = runCancellable.get(key) ?? new Map<string, boolean>();
    for (const runId of held.keys()) if (!active.includes(runId)) held.delete(runId);
    if (active.length === 0) runCancellable.delete(key);
    else runCancellable.set(key, held);
    return Effect.forEach(
      active,
      (runId) => {
        const known = held.get(runId);
        if (known !== undefined) return Effect.succeed(known ? [runId] : []);
        return read("getChangeRequest", input, `/api/ci/runs/${runId}`, Run).pipe(
          Effect.tap((run) => Effect.sync(() => held.set(runId, run.can_cancel))),
          Effect.map((run) => (run.can_cancel ? [runId] : [])),
          Effect.orElseSucceed(() => []),
        );
      },
      { concurrency: 4 },
    ).pipe(Effect.map((ids) => new Set(ids.flat())));
  };

  /**
   * What each listed pull changes, held for its head: GatHub's `target_head` is the target
   * branch's current tip on every row, so it moves with every push to the target and says nothing
   * about a squash-merged pull's own files. Every directory's list in a poll waits on the same
   * read, and a failed read is held just long enough for that poll's other lists to see it too.
   */
  const changedFiles = new Map<
    string,
    { readonly head: string; readonly files: Effect.Effect<Option.Option<ReadonlyArray<string>>> }
  >();

  const filesOf = Effect.fnUntraced(function* (
    input: ProviderRepositoryRef,
    pull: Json.GatHubPull,
  ) {
    const key = `${input.host} ${pull.id}`;
    const held = changedFiles.get(key);
    if (held !== undefined && held.head === pull.head) return yield* held.files;
    // A failed read is held only briefly, so the poll's other lists share it and the next asks.
    const files = yield* Effect.cachedWithTTL(
      readPull("listChangeRequests", { ...input, number: pull.id }).pipe(
        // A rename moves a file out of one directory and into another, and touches both.
        Effect.map((detail) =>
          detail.files.flatMap((file) => [
            file.path,
            ...parseDiffFilePaths(file.patch ?? "").flatMap(({ oldPath }) =>
              oldPath === null || oldPath === file.path ? [] : [oldPath],
            ),
          ]),
        ),
        Effect.option,
      ),
      (exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value) ? Duration.infinity : FAILED_READ_HOLD,
    );
    changedFiles.set(key, { head: pull.head, files });
    return yield* files;
  });

  const depthOf = (scope: string) => scope.split("/").length;

  /**
   * The deepest directory project a pull touches, or null for the root's list, from GatHub's
   * file list alone so every project's list reaches the same answer. A pull whose files cannot
   * be read stays on the root's list, where nothing is filtered away.
   */
  const ownerOf = Effect.fnUntraced(function* (
    input: ProviderRepositoryRef,
    pull: Json.GatHubPull,
    scopes: ReadonlyArray<string>,
  ) {
    const files = yield* filesOf(input, pull);
    if (Option.isNone(files)) return null;
    const deepestFirst = scopes.toSorted((a, b) => depthOf(b) - depthOf(a) || a.localeCompare(b));
    return (
      deepestFirst.find((scope) =>
        files.value.some((path) => path === scope || path.startsWith(`${scope}/`)),
      ) ?? null
    );
  });

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
    pathScopedLists: true,
    // GatHub squashes with the description as the message, where agents leave their credits.
    mergeMessageRewrite: removeAgentCredits,
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
        const candidates = pulls
          .map((pull) => ({ pull, row: Json.toChangeRequest(pull, input.host) }))
          .filter(
            ({ row }) =>
              (input.state === "all" || row.state === input.state) &&
              (input.involvement !== "authored" ||
                row.author?.login.toLowerCase() === input.viewer.toLowerCase()) &&
              (before === undefined ||
                row.updatedAt < before ||
                (row.updatedAt === before && !seen.has(row.number))),
          )
          .toSorted((a, b) => b.row.updatedAt.localeCompare(a.row.updatedAt));
        const limit = Math.max(1, input.limit);
        // What is held for a pull goes once it leaves GatHub's list.
        const listed = new Set(pulls.map((pull) => `${input.host} ${pull.id}`));
        for (const key of changedFiles.keys())
          if (key.startsWith(`${input.host} `) && !listed.has(key)) changedFiles.delete(key);
        for (const key of runCancellable.keys()) {
          const [, host, id] = key.split("\n");
          if (host === input.host && !listed.has(`${host} ${id}`)) runCancellable.delete(key);
        }
        const scopes = input.pathScopes ?? [];
        if (scopes.length === 0) {
          const rows = candidates.map(({ row }) => row);
          return {
            items: rows.slice(0, limit),
            truncated: pulls_truncated || rows.length > limit,
            continues: rows.length > limit,
          };
        }
        // A directory's list reads each candidate's files, newest first, only until the page is
        // full; what a pull changes is held for as long as its head stays put.
        const own = input.pathScope ?? null;
        const matched: Array<(typeof candidates)[number]["row"]> = [];
        let scanned = 0;
        while (scanned < candidates.length && matched.length <= limit) {
          const batch = candidates.slice(scanned, scanned + SCOPE_BATCH);
          scanned += batch.length;
          const owned = yield* Effect.forEach(
            batch,
            ({ pull, row }) =>
              ownerOf(input, pull, scopes).pipe(
                Effect.map((owner) => (owner === own ? [row] : [])),
              ),
            { concurrency: 4 },
          );
          matched.push(...owned.flat());
        }
        const more = matched.length > limit;
        return {
          items: matched.slice(0, limit),
          truncated: pulls_truncated || more,
          continues: more,
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
    getChangeRequest: Effect.fn("GatHubPullRequestProvider.getChangeRequest")(function* (input) {
      const detail = yield* readDisplayed(input);
      return Json.toDetail(detail, input.host, yield* cancellableRuns(input, detail));
    }),
    // Polled for linked pulls, so it leaves out the run reads that only the cancel button needs.
    getChangeRequestSummary: (input) =>
      readDisplayed(input).pipe(Effect.map((detail) => Json.toDetail(detail, input.host))),
    getChangeRequestActivity: (input) => readDisplayed(input).pipe(Effect.map(Json.toActivity)),
    getViewerPermissions: (input) =>
      readPull("getViewerPermissions", input).pipe(Effect.map(Json.toViewerPermissions)),
    getChangeRequestChecks: Effect.fn("GatHubPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        // The polled checks row offers no cancel, so it skips the run reads the button needs.
        const detail = yield* readPull("getChangeRequestChecks", input);
        return { state: Json.pullState(detail), checks: Json.toChecks(detail, input.host) };
      },
    ),
    cancelCheck: Effect.fn("GatHubPullRequestProvider.cancelCheck")(function* (input) {
      if (Json.runIdOf({ id: input.runId }) === null)
        return yield* failure("cancelCheck", "GatHub run ids are numbers.");
      yield* send("cancelCheck", input, {
        path: `/api/ci/runs/${input.runId}/cancel`,
        body: {},
      }).pipe(
        Effect.ensuring(
          Effect.andThen(
            Cache.invalidate(displayed, displayKey(input)),
            Effect.sync(() =>
              runCancellable.get(runsKey(input, input.number))?.delete(input.runId),
            ),
          ),
        ),
      );
    }),
    // The patch names each file's blob; a file GatHub omits has none, so it is left unknown, and
    // a path missing from a cut-short file list may still be in the change.
    getFileRevisions: (input) =>
      readDisplayed(input).pipe(
        Effect.map((detail) => {
          const revisions = new Map(parseDiffFileRevisions(Json.toDiff(detail).patch));
          const listed = new Set(detail.files.map((file) => file.path));
          if (!detail.files_truncated)
            for (const path of input.paths) if (!listed.has(path)) revisions.set(path, "");
          return {
            revisions,
            complete:
              !detail.files_truncated && detail.files.every((file) => revisions.has(file.path)),
          };
        }),
      ),
    getDiff: Effect.fn("GatHubPullRequestProvider.getDiff")(function* (input) {
      if (input.commit !== undefined)
        return yield* failure("getDiff", "GatHub shows a pull request's diff as a whole.");
      return Json.toDiff(yield* readDisplayed(input));
    }),
    getFileStats: (input) =>
      readDisplayed(input).pipe(
        Effect.map((detail) => ({
          files: Json.fileStats(detail),
          // A file GatHub would not count makes the breakdown partial, like a cut-short list.
          truncated:
            detail.files_truncated ||
            detail.files.some((file) => file.additions === null || file.deletions === null),
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
            {
              title: pull.merge.default_title || pull.title,
              message:
                input.removeAgentCreditsOnMerge === true
                  ? removeAgentCredits(pull.body ?? "")
                  : (pull.body ?? ""),
            },
            pull.head,
          );
          return;
        }
        case "close":
        case "reopen":
          return yield* write(input.action, input, "/state", {
            state: input.action === "close" ? "closed" : "open",
          });
        // GatHub's own page only ever sends a pull back to review, never to draft.
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
