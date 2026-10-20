import {
  EnvironmentToolDefinition,
  EnvironmentToolId,
  EnvironmentToolKind,
  EnvironmentToolTone,
  MAX_ENVIRONMENT_TOOL_BADGE_DETAIL_LENGTH,
  MAX_ENVIRONMENT_TOOL_BADGE_DETAIL_LINES,
  MAX_ENVIRONMENT_TOOL_BADGE_GLYPH_LENGTH,
  MAX_ENVIRONMENT_TOOL_BADGE_HEADLINE_LENGTH,
  MAX_ENVIRONMENT_TOOL_BADGE_ITEM_LENGTH,
  MAX_ENVIRONMENT_TOOL_BADGE_ITEMS,
  MAX_ENVIRONMENT_TOOL_ID_LENGTH,
  NonNegativeInt,
  type EnvironmentToolBadge,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaParser from "effect/SchemaParser";

export interface EnvironmentToolEntry {
  readonly id: EnvironmentToolId;
  readonly definition: EnvironmentToolDefinition;
}

export interface EnvironmentToolIssue {
  readonly key: string;
  readonly message: string;
}

export interface DecodedEnvironmentTools {
  readonly tools: ReadonlyArray<EnvironmentToolEntry>;
  readonly issues: ReadonlyArray<EnvironmentToolIssue>;
}

const isEnvironmentToolId = Schema.is(EnvironmentToolId);
const decodeDefinition = SchemaParser.decodeUnknownResult(EnvironmentToolDefinition);
const KNOWN_KINDS: ReadonlySet<unknown> = new Set(EnvironmentToolKind.literals);
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function firstIssueMessage(issue: SchemaIssue.Issue): string {
  const first = formatIssues(issue).issues[0];
  if (first === undefined) return "Invalid tool";
  const path = (first.path ?? []).map((segment) =>
    typeof segment === "object" ? String(segment.key) : String(segment),
  );
  return path.length === 0 ? first.message : `${path.join(".")}: ${first.message}`;
}

/** Valid tools in file order; every other entry becomes an issue instead of failing the rest. */
export function decodeEnvironmentTools(
  record: Readonly<Record<string, unknown>>,
): DecodedEnvironmentTools {
  const tools: Array<EnvironmentToolEntry> = [];
  const issues: Array<EnvironmentToolIssue> = [];
  for (const [key, raw] of Object.entries(record)) {
    if (!isEnvironmentToolId(key)) {
      issues.push({ key, message: "Tool ids use lowercase letters, digits and dashes" });
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      issues.push({ key, message: "Expected an object" });
      continue;
    }
    // Checked here because the union's own issue for a missing kind names every member.
    const kind = (raw as { kind?: unknown }).kind;
    if (!KNOWN_KINDS.has(kind)) {
      issues.push({
        key,
        message:
          typeof kind === "string"
            ? "Needs a newer T3 Code"
            : `kind: Expected ${EnvironmentToolKind.literals.map((known) => `"${known}"`).join(" or ")}`,
      });
      continue;
    }
    const decoded = decodeDefinition(raw);
    if (Result.isSuccess(decoded)) {
      tools.push({ id: key, definition: decoded.success });
    } else {
      issues.push({ key, message: firstIssueMessage(decoded.failure) });
    }
  }
  return { tools, issues };
}

const RawBadgeItem = Schema.Struct({
  tone: Schema.optional(EnvironmentToolTone),
  glyph: Schema.optional(Schema.String),
  text: Schema.String,
});

const RawBadge = Schema.Struct({
  tone: Schema.optional(EnvironmentToolTone),
  glyph: Schema.optional(Schema.String),
  headline: Schema.String,
  detail: Schema.optional(Schema.Array(Schema.String)),
  items: Schema.optional(Schema.Array(RawBadgeItem)),
  total: Schema.optional(NonNegativeInt),
});
const decodeRawBadge = SchemaParser.decodeUnknownResult(RawBadge);

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
// Line breaks inside one line read as a space.
const LINE_BREAKS = /[\t\n\v\f\r]+/g;

// Limits count UTF-16 units, as the contract's `Schema.isMaxLength` does, so an astral character
// costs two. Cutting before a high surrogate keeps its pair whole.
function sliceUnits(text: string, maxLength: number): string {
  const last = text.charCodeAt(maxLength - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? maxLength - 1 : maxLength);
}

/** One line of probe text: control characters stripped, truncated with an ellipsis. */
export function cleanEnvironmentToolText(text: string, maxLength: number): string {
  const cleaned = text.replace(LINE_BREAKS, " ").replace(CONTROL_CHARACTERS, "").trim();
  return cleaned.length <= maxLength ? cleaned : `${sliceUnits(cleaned, maxLength - 1)}…`;
}

function cleanGlyph(glyph: string | undefined): { readonly glyph?: string } {
  if (glyph === undefined) return {};
  const cleaned = sliceUnits(
    glyph.replace(CONTROL_CHARACTERS, "").trim(),
    MAX_ENVIRONMENT_TOOL_BADGE_GLYPH_LENGTH,
  );
  return cleaned === "" ? {} : { glyph: cleaned };
}

/**
 * Normalizes a status probe's parsed JSON instead of rejecting it: unknown fields are ignored, an
 * unknown tone becomes muted, control characters are stripped and long values truncated.
 */
export function normalizeEnvironmentToolBadge(
  raw: unknown,
): EnvironmentToolBadge | { readonly error: string } {
  const decoded = decodeRawBadge(raw);
  if (Result.isFailure(decoded)) {
    return { error: `Output is not a status badge: ${firstIssueMessage(decoded.failure)}` };
  }
  const badge = decoded.success;
  const items = badge.items ?? [];
  return {
    tone: badge.tone ?? "muted",
    ...cleanGlyph(badge.glyph),
    headline: cleanEnvironmentToolText(badge.headline, MAX_ENVIRONMENT_TOOL_BADGE_HEADLINE_LENGTH),
    detail: (badge.detail ?? [])
      .slice(0, MAX_ENVIRONMENT_TOOL_BADGE_DETAIL_LINES)
      .map((line) => cleanEnvironmentToolText(line, MAX_ENVIRONMENT_TOOL_BADGE_DETAIL_LENGTH)),
    items: items.slice(0, MAX_ENVIRONMENT_TOOL_BADGE_ITEMS).map((item) => ({
      tone: item.tone ?? "muted",
      ...cleanGlyph(item.glyph),
      text: cleanEnvironmentToolText(item.text, MAX_ENVIRONMENT_TOOL_BADGE_ITEM_LENGTH),
    })),
    total: badge.total ?? items.length,
  };
}

/** A new tool's id: the name as a slug, made unique against `taken`. Ids never change later. */
export function slugEnvironmentToolId(name: string, taken: ReadonlySet<string>): EnvironmentToolId {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = /^[a-z]/.test(slug) ? slug : slug === "" ? "tool" : `tool-${slug}`;
  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const id = `${base.slice(0, MAX_ENVIRONMENT_TOOL_ID_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(id)) return EnvironmentToolId.make(id);
  }
}
