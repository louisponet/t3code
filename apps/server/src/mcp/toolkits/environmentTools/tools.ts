import {
  EnvironmentToolDefinition,
  EnvironmentToolId,
  EnvironmentToolStatus,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as EnvironmentTools from "../../../environmentTools/EnvironmentTools.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ToolStatus = Schema.NullOr(EnvironmentToolStatus).annotate({
  description:
    "The latest status badge, or null when the tool has no status probe or none is known yet.",
});

const EnvironmentToolList = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      toolId: EnvironmentToolId,
      definition: EnvironmentToolDefinition,
      status: ToolStatus,
    }),
  ),
  issues: Schema.Array(Schema.Struct({ key: Schema.String, message: Schema.String })).annotate({
    description: "Entries in settings.json that this server cannot use, and why.",
  }),
});

const shared = {
  success: EnvironmentToolList,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Settings.ServerSettingsService,
    EnvironmentTools.EnvironmentTools,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};

const EnvironmentToolsListTool = Tool.make("t3_environment_tools_list", {
  ...shared,
  description:
    "List the tools in this environment's sidebar, in settings.json order. A terminal tool runs its command (usually a TUI) in one shared terminal on this host; a browser tool opens a URL or host port in this environment's browser. status is the last probe result: probes run only while someone has T3 Code open, so call t3_environment_tool_refresh_status for a fresh one.",
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    toolId: Schema.optional(
      EnvironmentToolId.annotate({ description: "Read one tool. Defaults to every tool." }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const EnvironmentToolUpsertTool = Tool.make("t3_environment_tool_upsert", {
  ...shared,
  description:
    'Add a tool to this environment\'s sidebar, or replace the one with the same toolId, through normal settings persistence. Requires a live full-access/default calling thread. Terminal tools take {kind:"terminal",name,command,cwd?} (cwd defaults to ~); browser tools take {kind:"browser",name,target} with target {kind:"environment-port",port,path?} for a server on this host, or {kind:"url",url}. Optional status:{command,intervalSeconds?,timeoutSeconds?} runs a non-interactive shell command on this host that prints one JSON badge: {"tone":"good|info|warn|alert|muted","headline":"3 PRs waiting","detail":["…"],"items":[{"tone":"alert","text":"…"}],"total":12}; only headline is required. Every client of this environment can read definitions, so never put secrets in commands. A running terminal tool keeps its old command until the user restarts it; changing kind closes its sessions. Returns the updated list.',
  parameters: Schema.Struct({
    toolId: EnvironmentToolId.annotate({
      description:
        "Lowercase letters, digits and dashes, starting with a letter. It cannot be renamed later.",
    }),
    definition: EnvironmentToolDefinition,
  }),
}).annotate(Tool.Destructive, true);

const EnvironmentToolRemoveTool = Tool.make("t3_environment_tool_remove", {
  ...shared,
  description:
    "Remove a tool from this environment's sidebar through normal settings persistence, closing its terminal or browser tabs. Requires a live full-access/default calling thread. Returns the updated list.",
  parameters: Schema.Struct({
    toolId: Schema.NonEmptyString.annotate({
      description: "The tool's id, or the key of an entry listed under issues.",
    }),
  }),
}).annotate(Tool.Destructive, true);

const EnvironmentToolRefreshStatusTool = Tool.make("t3_environment_tool_refresh_status", {
  ...shared,
  description:
    "Run a tool's status probe on this host now, or wait for the run already in progress, and return the resulting status. A tool without a status probe returns null.",
  parameters: Schema.Struct({ toolId: EnvironmentToolId }),
  success: Schema.Struct({ status: ToolStatus }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const EnvironmentToolsToolkit = Toolkit.make(
  EnvironmentToolsListTool,
  EnvironmentToolUpsertTool,
  EnvironmentToolRemoveTool,
  EnvironmentToolRefreshStatusTool,
);
