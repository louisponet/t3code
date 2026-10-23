import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GatHubApi from "./GatHubApi.ts";
import * as GatHubPullRequestProvider from "./GatHubPullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly identity: string | undefined;
  readonly body: unknown;
}

function fakeGatHub(
  routes: Record<string, unknown>,
  options: { readonly signedOut?: boolean } = {},
) {
  const sent: Array<SentRequest> = [];
  let credentialLookups = 0;
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const url = new URL(request.url);
    assert.strictEqual(url.origin, "http://gathub.gattaca.com");
    assert.strictEqual(request.headers.authorization, `Basic ${btoa("lopo:token")}`);
    const entry: SentRequest = {
      method: request.method,
      path: url.pathname,
      identity: request.headers["x-galileo-identity"],
      body:
        request.body._tag === "Uint8Array"
          ? decodeJson(new TextDecoder().decode(request.body.body))
          : undefined,
    };
    sent.push(entry);
    const route = routes[`${entry.method} ${entry.path}`];
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        route === undefined
          ? new Response("{}", { status: 404 })
          : new Response(encodeJson(route), { status: 200 }),
      ),
    );
  });
  const layer = GatHubApi.layer.pipe(
    Layer.provide(
      TestSourceControlHost.layer({
        git: {
          // GatHub is not the primary remote: the credential is still asked of its own URL.
          remotes: () =>
            Effect.succeed(
              Effect.succeed({
                remotes: [
                  {
                    name: "origin",
                    url: "https://github.com/acme/repo.git",
                    pushUrl: Option.none(),
                    isPrimary: true,
                  },
                  {
                    name: "gathub",
                    url: "http://lopo@gathub.gattaca.com/repo.git",
                    pushUrl: Option.none(),
                    isPrimary: false,
                  },
                ],
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe(0),
                  expiresAt: Option.none(),
                },
              }),
            ),
        },
        process: {
          // git is asked about the checkout's own remote, the one it pushes to.
          run: (input) => {
            credentialLookups++;
            // The server's runner fails a non-zero exit unless the caller expects one.
            if (options.signedOut && input.allowNonZeroExit !== true)
              return Effect.die("git's exit 128 would fail as a process error");
            return Effect.succeed(
              options.signedOut
                ? TestSourceControlHost.processOutput("", {
                    stderr: "fatal: could not read Password: terminal prompts disabled",
                    exitCode: ChildProcessSpawner.ExitCode(128),
                  })
                : TestSourceControlHost.processOutput(
                    input.command === "git" &&
                      input.stdin === "url=http://lopo@gathub.gattaca.com/repo.git\n\n"
                      ? "protocol=http\nhost=gathub.gattaca.com\nusername=lopo\npassword=token\n"
                      : "",
                  ),
            );
          },
        },
      }),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return { layer, sent, credentialLookups: () => credentialLookups };
}

const target = { cwd: "/repo", host: "gathub.gattaca.com", repository: "repo", number: 7 };
const head = "aab75917efa109434e3dd58cd8bc3d9eae00c0d6";
const pull = {
  id: 7,
  title: "Port routing",
  author: "lopo",
  source: "feature",
  target: "main",
  state: "open",
  merged: false,
  draft: false,
  head,
  created_at: "2026-10-23 17:00:23",
  updated_at: "2026-10-23 17:02:28",
  merged_at: null,
  comment_count: 1,
  can_comment: true,
  can_edit_body: true,
  can_manage: true,
  body: "Body",
  can_review: true,
  checks: [{ id: 41, name: "ci.yml", status: "failed" }],
  comments: [{ id: 3, author: "bm", body: "Looks fine", created_at: "2026-10-23 17:01:00" }],
  reviews: [
    { reviewer: "bm", state: "changes_requested", body: "Fix", created_at: "2026-10-23 17:01:30" },
  ],
  commits: [{ sha: head, subject: "Port routing", committer: { date: 1792774758 } }],
  commits_truncated: false,
  files: [
    {
      path: "a.rs",
      additions: 2,
      deletions: 1,
      patch:
        "diff --git a/a.rs b/a.rs\nindex 1111111..2222222 100644\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1,2 @@\n-x\n+y\n+z",
      truncated: false,
    },
    { path: "Cargo.lock", additions: null, deletions: null, patch: "", truncated: true },
  ],
  files_truncated: false,
  merge: { can_merge: true, default_title: "Port routing (#7)" },
  review_status: { approved_by: [], changes_requested_by: ["bm"], satisfied: false },
};

describe("GatHubPullRequestProvider", () => {
  it.effect("reads a pull request whose oversized file has neither counts nor a patch", () => {
    const fake = fakeGatHub({ "GET /api/pulls/7": pull });
    return Effect.gen(function* () {
      const provider = yield* GatHubPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(target);
      assert.strictEqual(detail.url, "http://gathub.gattaca.com/#pulls?id=7");
      assert.strictEqual(detail.updatedAt, "2026-10-23T17:02:28Z");
      // Cargo.lock's lines are unknown, so the totals are too.
      assert.deepStrictEqual([detail.additions, detail.deletions, detail.changedFiles], [0, 0, 2]);
      assert.strictEqual(detail.reviewDecision, "changes-requested");
      assert.strictEqual(detail.checksState, "failing");
      assert.strictEqual(detail.checks[0]?.url, "http://gathub.gattaca.com/#actions?run=41");
      assert.deepStrictEqual(detail.mergeCapabilities, {
        merge: false,
        squash: true,
        rebase: false,
      });
      assert.deepStrictEqual(detail.viewerPermissions.actions, ["close", "merge"]);

      // A viewed mark holds while a file's blob does; an omitted file's blob is unknown.
      const revisions = yield* provider.getFileRevisions!({
        ...target,
        paths: ["a.rs", "Cargo.lock", "gone.rs"],
      });
      assert.deepStrictEqual(
        [...revisions.revisions],
        [
          ["a.rs", "2222222"],
          ["gone.rs", ""],
        ],
      );
      assert.isFalse(revisions.complete);

      const diff = yield* provider.getDiff(target);
      // The file too large to show keeps its header, so the change still lists it.
      assert.deepStrictEqual(
        diff.patch.split("\n").filter((line) => line.startsWith("diff ")),
        ["diff --git a/a.rs b/a.rs", "diff --git a/Cargo.lock b/Cargo.lock"],
      );
      assert.isTrue(diff.patch.includes("+z\n"));
      assert.isTrue(diff.truncated);
      assert.deepStrictEqual(diff.omittedFileStats, [
        { path: "Cargo.lock", additions: 0, deletions: 0 },
      ]);

      const stats = yield* provider.getFileStats!(target);
      assert.isTrue(stats.truncated);

      const activity = yield* provider.getChangeRequestActivity(target);
      assert.deepStrictEqual(activity.commits, []);
      assert.strictEqual(fake.sent.length, 1);
      assert.deepStrictEqual(
        activity.comments.map((comment) => [comment.kind, comment.reviewState, comment.createdAt]),
        [
          ["issue-comment", null, "2026-10-23T17:01:00Z"],
          ["review", "changes_requested", "2026-10-23T17:01:30Z"],
        ],
      );
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("keeps a file's path as written, so its blob still fences the viewed mark", () => {
    const spaced = {
      path: "a.rs ",
      additions: 1,
      deletions: 0,
      patch:
        'diff --git "a/a.rs " "b/a.rs "\nindex 1111111..3333333 100644\n--- "a/a.rs "\n+++ "b/a.rs "\n@@ -1 +1 @@\n-x\n+y',
      truncated: false,
    };
    const fake = fakeGatHub({ "GET /api/pulls/7": { ...pull, files: [spaced] } });
    return Effect.gen(function* () {
      const provider = yield* GatHubPullRequestProvider.make;
      const revisions = yield* provider.getFileRevisions!({ ...target, paths: ["a.rs "] });
      assert.deepStrictEqual([...revisions.revisions], [["a.rs ", "3333333"]]);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("keeps a path missing from a cut-short file list unknown, not removed", () => {
    const fake = fakeGatHub({
      "GET /api/pulls/7": { ...pull, files: [pull.files[0]], files_truncated: true },
    });
    return Effect.gen(function* () {
      const provider = yield* GatHubPullRequestProvider.make;
      const revisions = yield* provider.getFileRevisions!({ ...target, paths: ["a.rs", "b.rs"] });
      assert.deepStrictEqual([...revisions.revisions], [["a.rs", "2222222"]]);
      assert.isFalse(revisions.complete);
      // The listed files' lines are not the whole change's.
      const detail = yield* provider.getChangeRequest(target);
      assert.deepStrictEqual([detail.additions, detail.deletions], [0, 0]);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect(
    "reports a checkout git holds no GatHub credential for as signed out, asking once",
    () => {
      const fake = fakeGatHub({}, { signedOut: true });
      return Effect.gen(function* () {
        const provider = yield* GatHubPullRequestProvider.make;
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = yield* Effect.flip(provider.getViewer({ cwd: "/repo", host: target.host }));
          assert.strictEqual(error.reason, "unauthenticated");
        }
        assert.strictEqual(fake.credentialLookups(), 1);
        assert.strictEqual(fake.sent.length, 0);
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("fences each write on a head and names the account it acts as", () => {
    const fake = fakeGatHub({
      "GET /api/pulls/7": pull,
      "GET /api/identity": { user: "lopo", identity_key: "key-1" },
      "POST /api/pulls/7/state": {},
      "POST /api/pulls/7/reviews": {},
    });
    return Effect.gen(function* () {
      const provider = yield* GatHubPullRequestProvider.make;
      yield* provider.runAction({ ...target, action: "close" });
      yield* provider.submitReview({
        ...target,
        expectedHeadSha: "reviewed-head",
        verdict: "request-changes",
        body: "Fix",
        comments: [],
      });
      assert.deepStrictEqual(
        fake.sent
          .filter((request) => request.method === "POST")
          .map(({ path, identity, body }) => ({ path, identity, body })),
        [
          {
            path: "/api/pulls/7/state",
            identity: "key-1",
            body: { state: "closed", expected_head: head },
          },
          {
            path: "/api/pulls/7/reviews",
            identity: "key-1",
            body: { state: "request_changes", body: "Fix", expected_head: "reviewed-head" },
          },
        ],
      );
    }).pipe(Effect.provide(fake.layer));
  });
});
