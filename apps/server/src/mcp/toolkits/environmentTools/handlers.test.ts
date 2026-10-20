import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EnvironmentToolId,
  EnvironmentToolNotFoundError,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentToolStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as EnvironmentTools from "../../../environmentTools/EnvironmentTools.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread:environment-tools");
const caller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:tools"),
  requestNamespace: "provider:environment-tools",
  thread: {
    threadId,
    providerSessionId: "provider:environment-tools",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "environment-tools", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "environment-tools", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const call = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

// Effect returns a declared tool failure as `isError` with its encoded payload as JSON text.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const lazygit = { kind: "terminal", name: "lazygit", command: "lazygit", cwd: "~/code" };
const prs = {
  kind: "terminal",
  name: "PRs",
  command: "gtc prs",
  status: { command: "gtc prs --badge" },
};
const grafana = {
  kind: "browser",
  name: "Grafana",
  target: { kind: "environment-port", port: 3000, path: "/d/home" },
};
const prsStatus: EnvironmentToolStatus = {
  state: "ready",
  badge: { tone: "warn", headline: "3 PRs waiting", detail: [], items: [], total: 3 },
  since: "2026-10-20T10:00:00.000Z",
};

const layer = (statuses: Ref.Ref<ReadonlyMap<EnvironmentToolId, EnvironmentToolStatus>>) =>
  McpHttpServer.layerEnvironmentToolsToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(liveThreadsLayer),
    Layer.provide(
      Layer.mock(EnvironmentTools.EnvironmentTools)({
        statuses: Ref.get(statuses),
        refreshStatus: (toolId) =>
          toolId === "prs"
            ? Ref.set(statuses, new Map([[toolId, prsStatus]]))
            : Effect.fail(new EnvironmentToolNotFoundError({ toolId })),
      }),
    ),
    Layer.provideMerge(
      Settings.layerTest({ tools: { lazygit, "Bad Key": { kind: "terminal" }, prs } }),
    ),
  );

it.effect("edits tools through settings and lists them in file order with issues", () =>
  Effect.gen(function* () {
    const listed = yield* call("t3_environment_tools_list", {});
    expect(listed.structuredContent).toEqual({
      tools: [
        { toolId: "lazygit", definition: lazygit, status: null },
        { toolId: "prs", definition: prs, status: { state: "pending" } },
      ],
      issues: [{ key: "Bad Key", message: "Tool ids use lowercase letters, digits and dashes" }],
    });

    const upserted = yield* call("t3_environment_tool_upsert", {
      toolId: "grafana",
      definition: grafana,
    });
    expect(upserted.isError).toBe(false);
    expect(upserted.structuredContent).toMatchObject({
      tools: [{ toolId: "lazygit" }, { toolId: "prs" }, { toolId: "grafana", definition: grafana }],
    });

    const removed = yield* call("t3_environment_tool_remove", { toolId: "Bad Key" });
    expect(removed.structuredContent).toMatchObject({ issues: [] });
    yield* call("t3_environment_tool_remove", { toolId: "lazygit" });
    const settings = yield* Settings.ServerSettingsService;
    expect(Object.keys((yield* settings.getSettings).tools)).toEqual(["prs", "grafana"]);

    const missing = yield* call("t3_environment_tool_remove", { toolId: "lazygit" });
    expect(declaredFailure(missing)).toMatchObject({ code: "invalid_request" });
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Ref.make<ReadonlyMap<EnvironmentToolId, EnvironmentToolStatus>>(
          new Map([[EnvironmentToolId.make("prs"), { state: "pending" }]]),
        ).pipe(Effect.map(layer)),
      ),
    ),
  ),
);

it.effect("returns the status a refresh produced", () =>
  Effect.gen(function* () {
    const refreshed = yield* call("t3_environment_tool_refresh_status", { toolId: "prs" });
    expect(refreshed.structuredContent).toEqual({ status: prsStatus });
    const undefinedTool = yield* call("t3_environment_tool_refresh_status", { toolId: "nope" });
    expect(declaredFailure(undefinedTool)).toMatchObject({ code: "invalid_request" });
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Ref.make<ReadonlyMap<EnvironmentToolId, EnvironmentToolStatus>>(new Map()).pipe(
          Effect.map(layer),
        ),
      ),
    ),
  ),
);
