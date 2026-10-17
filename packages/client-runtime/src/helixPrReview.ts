export interface HelixPrSelection {
  readonly id: string;
  readonly path: string;
  readonly side: "LEFT" | "RIGHT";
  readonly startLine: number;
  readonly line: number;
  readonly code: string;
}

export interface HelixPrComment extends Omit<HelixPrSelection, "id"> {
  readonly id: string;
  readonly body: string;
  readonly replyTo?: number;
}

export interface HelixPrSuggestion {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly replacement: string;
  readonly original: string;
  readonly accepted: boolean;
  readonly error?: string;
}

export interface HelixPrReviewSnapshot {
  readonly revision: string;
  readonly pr: {
    readonly url: string;
    readonly repo: string;
    readonly number: number;
    readonly headSha: string;
    readonly title: string;
  };
  readonly selection: HelixPrSelection | null;
  readonly comments: readonly HelixPrComment[];
  readonly suggestions: readonly HelixPrSuggestion[];
  readonly error?: string;
}

export interface HelixPrReviewPayload {
  readonly v: 1;
  readonly kind: "pr-review";
  readonly requestId?: string;
  readonly review: HelixPrReviewSnapshot | null;
  readonly error?: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const string = (value: unknown): value is string => typeof value === "string";
const id = (value: unknown): value is string =>
  string(value) && value.length > 0 && value.length <= 256;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const path = (value: unknown): value is string =>
  string(value) &&
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.split(/[\\/]/u).some((part) => part === ".." || part === "") &&
  !value.includes("\0");

function range(value: Record<string, unknown>) {
  return (
    path(value.path) &&
    positive(value.startLine) &&
    positive(value.line) &&
    value.startLine <= value.line
  );
}

function selection(value: unknown): value is HelixPrSelection {
  return (
    object(value) &&
    keys(value, ["id", "path", "side", "startLine", "line", "code"]) &&
    id(value.id) &&
    range(value) &&
    (value.side === "LEFT" || value.side === "RIGHT") &&
    string(value.code)
  );
}

function comment(value: unknown): value is HelixPrComment {
  return (
    object(value) &&
    keys(value, ["id", "path", "side", "startLine", "line", "code", "body", "replyTo"]) &&
    id(value.id) &&
    range(value) &&
    (value.side === "LEFT" || value.side === "RIGHT") &&
    string(value.code) &&
    string(value.body) &&
    (value.replyTo === undefined || positive(value.replyTo))
  );
}

function suggestion(value: unknown): value is HelixPrSuggestion {
  return (
    object(value) &&
    keys(value, [
      "id",
      "path",
      "startLine",
      "line",
      "replacement",
      "original",
      "accepted",
      "error",
    ]) &&
    id(value.id) &&
    range(value) &&
    string(value.replacement) &&
    string(value.original) &&
    typeof value.accepted === "boolean" &&
    (value.error === undefined || (string(value.error) && value.accepted === false))
  );
}

export function isHelixPrReviewSnapshot(value: unknown): value is HelixPrReviewSnapshot {
  if (
    !object(value) ||
    !keys(value, ["revision", "pr", "selection", "comments", "suggestions", "error"]) ||
    !id(value.revision)
  )
    return false;
  const pr = value.pr;
  if (
    !object(pr) ||
    !keys(pr, ["url", "repo", "number", "headSha", "title"]) ||
    !string(pr.url) ||
    !string(pr.repo) ||
    !positive(pr.number) ||
    !string(pr.headSha) ||
    !/^[\da-f]{40,64}$/iu.test(pr.headSha) ||
    !string(pr.title)
  )
    return false;
  try {
    const url = new URL(pr.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/${pr.repo}/pull/${pr.number}` ||
      !/^[^/]+\/[^/]+$/u.test(pr.repo)
    )
      return false;
  } catch {
    return false;
  }
  if (value.selection !== null && !selection(value.selection)) return false;
  if (
    !Array.isArray(value.comments) ||
    !value.comments.every(comment) ||
    !Array.isArray(value.suggestions) ||
    !value.suggestions.every(suggestion)
  )
    return false;
  const ids = [...value.comments, ...value.suggestions].map((entry) => entry.id);
  return new Set(ids).size === ids.length && (value.error === undefined || string(value.error));
}

export function isHelixPrReviewPayload(value: unknown): value is HelixPrReviewPayload {
  return (
    object(value) &&
    keys(value, ["v", "kind", "requestId", "review", "error"]) &&
    value.v === 1 &&
    value.kind === "pr-review" &&
    (value.requestId === undefined ||
      (string(value.requestId) &&
        /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value.requestId))) &&
    (value.review === null || isHelixPrReviewSnapshot(value.review)) &&
    (value.error === undefined || string(value.error))
  );
}
