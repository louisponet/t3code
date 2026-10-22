import {
  OrchestratorMcpFailure,
  type EnvironmentToolDefinition,
  type EnvironmentToolId,
  type EnvironmentToolStatus,
} from "@t3tools/contracts";
import { decodeEnvironmentTools } from "@t3tools/shared/environmentTools";
import * as Effect from "effect/Effect";

import * as EnvironmentTools from "../../../environmentTools/EnvironmentTools.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolsToolkit } from "./tools.ts";

const notDefined = (toolId: string) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `No tool ${toolId} is defined in this environment. t3_environment_tools_list shows them.`,
  });

function listing(
  tools: Readonly<Record<string, unknown>>,
  statuses: ReadonlyMap<EnvironmentToolId, EnvironmentToolStatus>,
  only?: string,
) {
  const decoded = decodeEnvironmentTools(tools);
  return {
    tools: decoded.tools
      .filter((tool) => only === undefined || tool.id === only)
      .map(({ id, definition }) => ({ toolId: id, definition, status: statuses.get(id) ?? null })),
    issues: decoded.issues.filter((issue) => only === undefined || issue.key === only),
  };
}

/**
 * Writes under the calling thread's lock and re-checks the caller there: the turn may have
 * ended, or the thread's modes changed, while this waited for it.
 */
const writeTools = Effect.fn("EnvironmentToolsMcp.writeTools")(function* <R>(
  check: Effect.Effect<unknown, OrchestratorMcpFailure, R>,
  patch: (
    current: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<Record<string, EnvironmentToolDefinition | null>, OrchestratorMcpFailure>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const settings = yield* Settings.ServerSettingsService;
  const environmentTools = yield* EnvironmentTools.EnvironmentTools;
  const update = Effect.gen(function* () {
    yield* check;
    const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
    const tools = yield* patch(current.tools);
    const next = yield* settings.updateSettings({ tools }).pipe(Effect.mapError(unavailable));
    return listing(next.tools, yield* environmentTools.statuses);
  });
  return yield* scope.thread === undefined
    ? update
    : executor.withLock(scope.thread.threadId, update);
});

export const layer = McpToolAccess.toLayer(EnvironmentToolsToolkit, {
  t3_environment_tools_list: McpToolAccess.reads(({ toolId }) =>
    Effect.gen(function* () {
      yield* readCaller();
      const settings = yield* Settings.ServerSettingsService;
      const environmentTools = yield* EnvironmentTools.EnvironmentTools;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return listing(current.tools, yield* environmentTools.statuses, toolId);
    }),
  ),
  t3_environment_tool_upsert: McpToolAccess.writesEnvironment(({ toolId, definition }, check) =>
    writeTools(check, () => Effect.succeed({ [toolId]: definition })),
  ),
  t3_environment_tool_remove: McpToolAccess.writesEnvironment(({ toolId }, check) =>
    writeTools(check, (current) =>
      Object.hasOwn(current, toolId)
        ? Effect.succeed({ [toolId]: null })
        : Effect.fail(notDefined(toolId)),
    ),
  ),
  t3_environment_tool_refresh_status: McpToolAccess.reads(({ toolId }) =>
    Effect.gen(function* () {
      yield* readCaller();
      const environmentTools = yield* EnvironmentTools.EnvironmentTools;
      yield* environmentTools.refreshStatus(toolId).pipe(Effect.mapError(() => notDefined(toolId)));
      return { status: (yield* environmentTools.statuses).get(toolId) ?? null };
    }),
  ),
});
