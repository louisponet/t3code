import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleUnion,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PreviewRuntime, PreviewTabId } from "./preview.ts";
import { BrowserNavigationTarget } from "./previewAutomation.ts";
import { TerminalResizeInput } from "./terminal.ts";

export const MAX_ENVIRONMENT_TOOL_ID_LENGTH = 24;
// A leading letter keeps ids from being integer-like keys, which a JS record moves ahead of the
// file's order.
export const ENVIRONMENT_TOOL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const EnvironmentToolId = Schema.String.check(
  Schema.isMaxLength(MAX_ENVIRONMENT_TOOL_ID_LENGTH),
  Schema.isPattern(ENVIRONMENT_TOOL_ID_PATTERN),
).pipe(Schema.brand("EnvironmentToolId"));
export type EnvironmentToolId = typeof EnvironmentToolId.Type;

const ENVIRONMENT_TOOL_THREAD_PREFIX = "tool:";
export const ENVIRONMENT_TOOL_TERMINAL_ID = "main";

export const environmentToolThreadId = (id: EnvironmentToolId): ThreadId =>
  ThreadId.make(`${ENVIRONMENT_TOOL_THREAD_PREFIX}${id}`);

export const isEnvironmentToolThreadId = (threadId: string): boolean =>
  threadId.startsWith(ENVIRONMENT_TOOL_THREAD_PREFIX);

const MAX_ENVIRONMENT_TOOL_NAME_LENGTH = 48;
const MAX_ENVIRONMENT_TOOL_DESCRIPTION_LENGTH = 120;
const MAX_ENVIRONMENT_TOOL_COMMAND_LENGTH = 4096;
const MAX_ENVIRONMENT_TOOL_CWD_LENGTH = 1024;
const MIN_ENVIRONMENT_TOOL_PROBE_INTERVAL_SECONDS = 10;
const MAX_ENVIRONMENT_TOOL_PROBE_INTERVAL_SECONDS = 3600;
export const DEFAULT_ENVIRONMENT_TOOL_PROBE_INTERVAL_SECONDS = 60;
const MIN_ENVIRONMENT_TOOL_PROBE_TIMEOUT_SECONDS = 1;
const MAX_ENVIRONMENT_TOOL_PROBE_TIMEOUT_SECONDS = 120;
export const DEFAULT_ENVIRONMENT_TOOL_PROBE_TIMEOUT_SECONDS = 30;

const EnvironmentToolCommand = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_ENVIRONMENT_TOOL_COMMAND_LENGTH),
);

export const EnvironmentToolStatusProbe = Schema.Struct({
  command: EnvironmentToolCommand,
  intervalSeconds: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({
        minimum: MIN_ENVIRONMENT_TOOL_PROBE_INTERVAL_SECONDS,
        maximum: MAX_ENVIRONMENT_TOOL_PROBE_INTERVAL_SECONDS,
      }),
    ),
  ),
  timeoutSeconds: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({
        minimum: MIN_ENVIRONMENT_TOOL_PROBE_TIMEOUT_SECONDS,
        maximum: MAX_ENVIRONMENT_TOOL_PROBE_TIMEOUT_SECONDS,
      }),
    ),
  ),
});
export type EnvironmentToolStatusProbe = typeof EnvironmentToolStatusProbe.Type;

const environmentToolFields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_ENVIRONMENT_TOOL_NAME_LENGTH)),
  description: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_ENVIRONMENT_TOOL_DESCRIPTION_LENGTH)),
  ),
  status: Schema.optional(EnvironmentToolStatusProbe),
};

export const TerminalEnvironmentTool = Schema.Struct({
  kind: Schema.Literal("terminal"),
  ...environmentToolFields,
  command: EnvironmentToolCommand,
  /** Defaults to `~`, the host user's home directory. */
  cwd: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_ENVIRONMENT_TOOL_CWD_LENGTH)),
  ),
});
export type TerminalEnvironmentTool = typeof TerminalEnvironmentTool.Type;

export const BrowserEnvironmentTool = Schema.Struct({
  kind: Schema.Literal("browser"),
  ...environmentToolFields,
  target: BrowserNavigationTarget,
});
export type BrowserEnvironmentTool = typeof BrowserEnvironmentTool.Type;

/**
 * A web app renders in the client's own frame, unlike a browser tool, which renders in the
 * environment's browser. The server only proxies the target's bytes to the client.
 */
export const WebEnvironmentTool = Schema.Struct({
  kind: Schema.Literal("web"),
  ...environmentToolFields,
  target: BrowserNavigationTarget,
});
export type WebEnvironmentTool = typeof WebEnvironmentTool.Type;

/** Strict on purpose: every write path must fail loudly on a kind this build does not know. */
export const EnvironmentToolDefinition = Schema.Union([
  TerminalEnvironmentTool,
  BrowserEnvironmentTool,
  WebEnvironmentTool,
]);
export type EnvironmentToolDefinition = typeof EnvironmentToolDefinition.Type;

export const EnvironmentToolKind = Schema.Literals(["terminal", "browser", "web"]);
export type EnvironmentToolKind = typeof EnvironmentToolKind.Type;

export const MAX_ENVIRONMENT_TOOL_BADGE_HEADLINE_LENGTH = 60;
export const MAX_ENVIRONMENT_TOOL_BADGE_DETAIL_LINES = 5;
export const MAX_ENVIRONMENT_TOOL_BADGE_DETAIL_LENGTH = 80;
export const MAX_ENVIRONMENT_TOOL_BADGE_ITEMS = 8;
export const MAX_ENVIRONMENT_TOOL_BADGE_ITEM_LENGTH = 100;
export const MAX_ENVIRONMENT_TOOL_BADGE_GLYPH_LENGTH = 4;
export const MAX_ENVIRONMENT_TOOL_UNAVAILABLE_REASON_LENGTH = 200;

export const EnvironmentToolTone = Schema.Literals(["good", "info", "warn", "alert", "muted"]).pipe(
  // A tone from a newer probe or server still renders, just without emphasis.
  Schema.catchDecoding(() => Effect.succeedSome("muted" as const)),
);
export type EnvironmentToolTone = typeof EnvironmentToolTone.Type;

export const EnvironmentToolBadgeItem = Schema.Struct({
  tone: EnvironmentToolTone,
  glyph: Schema.optional(Schema.String),
  text: Schema.String,
});
export type EnvironmentToolBadgeItem = typeof EnvironmentToolBadgeItem.Type;

export const EnvironmentToolBadge = Schema.Struct({
  tone: EnvironmentToolTone,
  glyph: Schema.optional(Schema.String),
  headline: Schema.String,
  detail: Schema.Array(Schema.String),
  items: Schema.Array(EnvironmentToolBadgeItem),
  /** Item count before truncation, so a client can show "+N more". */
  total: NonNegativeInt,
});
export type EnvironmentToolBadge = typeof EnvironmentToolBadge.Type;

const environmentToolStatusMembers = [
  Schema.Struct({ state: Schema.Literal("pending") }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    badge: EnvironmentToolBadge,
    /** When the value last changed, not when the probe last ran. */
    since: IsoDateTime,
  }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: Schema.String.check(Schema.isMaxLength(MAX_ENVIRONMENT_TOOL_UNAVAILABLE_REASON_LENGTH)),
    lastBadge: Schema.optional(EnvironmentToolBadge),
    since: IsoDateTime,
  }),
] as const;

export const EnvironmentToolStatus = ForwardCompatibleUnion(environmentToolStatusMembers, "state");
/** The known states. Decoding can also yield an `UnknownUnionMember` that readers drop. */
export type EnvironmentToolStatus = (typeof environmentToolStatusMembers)[number]["Type"];

export const EnvironmentToolStatusEvent = ForwardCompatibleUnion(
  [
    Schema.Struct({
      type: Schema.Literal("snapshot"),
      statuses: Schema.Record(EnvironmentToolId, EnvironmentToolStatus),
    }),
    Schema.Struct({
      type: Schema.Literal("status"),
      toolId: EnvironmentToolId,
      /** `null` when the tool or its probe was removed. */
      status: Schema.NullOr(EnvironmentToolStatus),
    }),
  ],
  "type",
);
export type EnvironmentToolStatusEvent = typeof EnvironmentToolStatusEvent.Type;

export const EnvironmentToolOpenInput = Schema.Struct({
  toolId: EnvironmentToolId,
  /** The kind the caller renders; the server rejects a call that no longer matches. */
  kind: EnvironmentToolKind,
  cols: Schema.optional(TerminalResizeInput.fields.cols),
  rows: Schema.optional(TerminalResizeInput.fields.rows),
  restart: Schema.optional(Schema.Boolean),
  /** Where a browser tool's tab renders; the server's browser when omitted. */
  runtime: Schema.optional(PreviewRuntime),
});
export type EnvironmentToolOpenInput = typeof EnvironmentToolOpenInput.Type;

export const EnvironmentToolOpenResult = ForwardCompatibleUnion(
  [
    Schema.Struct({
      kind: Schema.Literal("terminal"),
      threadId: ThreadId,
      terminalId: TrimmedNonEmptyString,
    }),
    Schema.Struct({
      kind: Schema.Literal("browser"),
      threadId: ThreadId,
      tabId: PreviewTabId,
    }),
    Schema.Struct({
      kind: Schema.Literal("web"),
      /** Signed proxy path on this environment's origin; resolve it against its HTTP base. */
      relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
      expiresAt: Schema.Number,
    }),
  ],
  "kind",
);
export type EnvironmentToolOpenResult = typeof EnvironmentToolOpenResult.Type;

export const EnvironmentToolStopInput = Schema.Struct({
  toolId: EnvironmentToolId,
  kind: EnvironmentToolKind,
});
export type EnvironmentToolStopInput = typeof EnvironmentToolStopInput.Type;

export const EnvironmentToolRefreshStatusInput = Schema.Struct({
  toolId: EnvironmentToolId,
});
export type EnvironmentToolRefreshStatusInput = typeof EnvironmentToolRefreshStatusInput.Type;

export class EnvironmentToolNotFoundError extends Schema.TaggedError<EnvironmentToolNotFoundError>()(
  "EnvironmentToolNotFoundError",
  { toolId: EnvironmentToolId },
) {
  override get message(): string {
    return `Tool ${this.toolId} is not defined in this environment.`;
  }
}

export class EnvironmentToolKindMismatchError extends Schema.TaggedError<EnvironmentToolKindMismatchError>()(
  "EnvironmentToolKindMismatchError",
  {
    toolId: EnvironmentToolId,
    expected: EnvironmentToolKind,
    actual: EnvironmentToolKind,
  },
) {
  override get message(): string {
    return `Tool ${this.toolId} is now a ${this.actual} tool, not a ${this.expected} tool.`;
  }
}

export class EnvironmentToolUnavailableError extends Schema.TaggedError<EnvironmentToolUnavailableError>()(
  "EnvironmentToolUnavailableError",
  {
    toolId: EnvironmentToolId,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Tool ${this.toolId} is unavailable: ${this.reason}`;
  }
}

export const EnvironmentToolError = Schema.Union([
  EnvironmentToolNotFoundError,
  EnvironmentToolKindMismatchError,
  EnvironmentToolUnavailableError,
]);
export type EnvironmentToolError = typeof EnvironmentToolError.Type;
