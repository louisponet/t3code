import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for finding records"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "review-findings" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const turnItemId = TurnItemId.make("turn-item:review-finding:1");
const pullRequest = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 7,
  url: "https://github.com/pingdotgg/t3code/pull/7",
};

const startReviewRun = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}`),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Review",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`start:${name}`),
      threadId,
      messageId: MessageId.make(`message:${name}`),
      text: "Review the pull request",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
    const finding = Effect.map(
      projections.getThreadRecords(threadId, ["turnItems"], { turnItemTypes: ["review_finding"] }),
      ({ turnItems }) => {
        const item = turnItems.find((candidate) => candidate.id === turnItemId);
        assert.equal(item?.type, "review_finding");
        return item as Extract<typeof item, { readonly type: "review_finding" }>;
      },
    );
    const record = (
      commandId: string,
      content: Partial<Extract<OrchestrationV2ServerCommand, { type: "review_finding.record" }>>,
    ) =>
      ({
        type: "review_finding.record",
        commandId: CommandId.make(commandId),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        turnItemId,
        findingId: "1",
        title: "Missing null check",
        body: "",
        pullRequest,
        headSha: "abc123",
        ...content,
      }) satisfies OrchestrationV2ServerCommand;
    const status = (
      commandId: string,
      findingStatus: "open" | "dismissed" | "posted",
      postedAs?: "inline" | "comment",
    ) =>
      ({
        type: "review_finding.status",
        commandId: CommandId.make(commandId),
        threadId,
        turnItemId,
        findingStatus,
        ...(postedAs === undefined ? {} : { postedAs }),
      }) satisfies OrchestrationV2ServerCommand;
    const rejection = (command: OrchestrationV2ServerCommand) =>
      orchestrator.dispatch(command).pipe(
        Effect.flip,
        Effect.map((error) =>
          error._tag === "OrchestratorDispatchError" ? String(error.cause) : error._tag,
        ),
      );
    return { orchestrator, run, finding, record, status, rejection };
  });

it.effect("records a finding in the run and revises its content in place", () =>
  Effect.gen(function* () {
    const { orchestrator, run, finding, record, status } = yield* startReviewRun("revise");
    yield* orchestrator.dispatch(
      record("record-1", { severity: "major", path: "src/a.ts", line: 10, endLine: 12 }),
    );
    const created = yield* finding;
    assert.include(created, {
      runId: run.id,
      nodeId: run.rootNodeId,
      status: "completed",
      findingId: "1",
      severity: "major",
      title: "Missing null check",
      path: "src/a.ts",
      line: 10,
      endLine: 12,
      headSha: "abc123",
      findingStatus: "open",
    });
    assert.deepEqual(created.pullRequest, pullRequest);

    yield* orchestrator.dispatch(status("dismiss", "dismissed"));
    yield* orchestrator.dispatch(
      record("record-2", { title: "Unchecked null", body: "Guard `x`.", path: "src/b.ts" }),
    );
    const revised = yield* finding;
    assert.include(revised, {
      ordinal: created.ordinal,
      title: "Unchecked null",
      body: "Guard `x`.",
      path: "src/b.ts",
      findingStatus: "dismissed",
    });
    assert.notProperty(revised, "severity");
    assert.notProperty(revised, "line");
    assert.notProperty(revised, "endLine");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("moves a finding between open and dismissed, and locks it once posted", () =>
  Effect.gen(function* () {
    const { orchestrator, finding, record, status, rejection } = yield* startReviewRun("status");
    yield* orchestrator.dispatch(record("record", {}));

    yield* orchestrator.dispatch(status("dismiss", "dismissed"));
    assert.equal((yield* finding).findingStatus, "dismissed");
    assert.include(yield* rejection(status("post-dismissed", "posted", "inline")), "dismissed");
    const repeated = yield* orchestrator.dispatch(status("dismiss-again", "dismissed"));
    assert.lengthOf(repeated.storedEvents, 0);
    yield* orchestrator.dispatch(status("restore", "open"));
    assert.equal((yield* finding).findingStatus, "open");

    assert.include(yield* rejection(status("post-without-kind", "posted")), "postedAs");
    yield* orchestrator.dispatch(status("post", "posted", "inline"));
    assert.include(yield* finding, { findingStatus: "posted", postedAs: "inline" });

    assert.include(yield* rejection(record("revise-posted", { title: "Late" })), "already posted");
    assert.include(yield* rejection(status("dismiss-posted", "dismissed")), "already posted");
    assert.include(yield* rejection(status("repost", "posted", "comment")), "already posted");
    assert.include(yield* finding, { title: "Missing null check", postedAs: "inline" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a new finding from a node that is not the run's root", () =>
  Effect.gen(function* () {
    const { record, rejection } = yield* startReviewRun("non-root");
    assert.include(
      yield* rejection(record("record", { nodeId: NodeId.make("node:tool-call") })),
      "is not the root of run",
    );
  }).pipe(Effect.provide(layerTest)),
);
