// @effect-diagnostics globalTimers:off - This client controller waits for terminal acknowledgments outside an Effect runtime.
import { isHelixPrReviewPayload, type HelixPrReviewPayload } from "./helixPrReview.ts";
export type {
  HelixPrReviewPayload,
  HelixPrReviewSnapshot,
  HelixPrSelection,
  HelixPrComment,
  HelixPrSuggestion,
} from "./helixPrReview.ts";

export type HelixReviewAction =
  | "open-file"
  | "comment"
  | "discard-last-comment"
  | "files"
  | "previous"
  | "next"
  | "ask"
  | "stage"
  | "mark-reviewed"
  | "unmark-reviewed"
  | "pr-review"
  | "pr-comment"
  | "pr-suggestion"
  | "pr-complete"
  | "send";

export interface HelixReviewState {
  readonly nonce: string;
  readonly canStage: boolean;
  readonly canMarkReviewed: boolean;
  readonly reviewed: boolean | null;
  readonly reviewedCount: number;
  readonly totalCount: number;
  readonly canReviewPr?: boolean;
  readonly canOpenFile?: boolean;
  readonly canOpenSnapshot?: boolean;
  readonly canAsk?: boolean;
  readonly canSend?: boolean;
  readonly canComment?: boolean;
  readonly pendingCommentCount?: number;
}

type StatePayload = Omit<HelixReviewState, "nonce"> & {
  readonly v: 1;
  readonly kind: "state";
};

export interface HelixReviewTarget {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly lifecycleVersion: number;
  readonly attachGeneration: number;
  readonly nonce: string;
}

type Result = {
  readonly v: 1;
  readonly kind: "result";
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
};

export interface HelixReviewMarker {
  readonly nonce: string;
  readonly payload:
    | { readonly v: 1; readonly kind: "ready" | "closed" }
    | Result
    | StatePayload
    | HelixPrReviewPayload;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const ACTIONS = new Set<string>([
  "open-file",
  "comment",
  "discard-last-comment",
  "files",
  "previous",
  "next",
  "ask",
  "stage",
  "mark-reviewed",
  "unmark-reviewed",
  "pr-review",
  "pr-comment",
  "pr-suggestion",
  "pr-complete",
  "send",
]);
const MAX_TEXT = 8 * 1024;
const MAX_JSON = 16 * 1024;
const MAX_BUFFER = 128 * 1024;

export function encodeHelixReviewDiscovery(): string {
  return "\x1b[200~# hx-review:discover\x1b[201~";
}

// URI encoding is available in Hermes as well as browsers, without Buffer,
// TextEncoder, or a React Native base64 polyfill.
function utf8Hex(value: string): string {
  return encodeURIComponent(value).replace(/%([\da-f]{2})|([^%])/giu, (_, hex, char) =>
    hex ? hex.toLowerCase() : char.charCodeAt(0).toString(16).padStart(2, "0"),
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHelixReviewMarkers(buffer: string): HelixReviewMarker[] {
  const markers: HelixReviewMarker[] = [];
  // eslint-disable-next-line no-control-regex -- OSC records use ESC and BEL framing.
  const pattern = /\x1b\]777;hx-review;([\da-f-]{36});([\da-f]{2,98304})(?:\x07|\x1b\\)/giu;
  for (const match of buffer.slice(-MAX_BUFFER).matchAll(pattern)) {
    const nonce = match[1]!;
    if (!UUID.test(nonce)) continue;
    const hex = match[2]!;
    if (hex.length % 2 !== 0) continue;
    try {
      const value: unknown = JSON.parse(decodeURIComponent(hex.replace(/../gu, "%$&")));
      if (!object(value) || value.v !== 1) continue;
      if (value.kind !== "pr-review" && hex.length > MAX_JSON * 2) continue;
      if (value.kind === "ready" || value.kind === "closed") {
        if (Object.keys(value).some((key) => key !== "v" && key !== "kind")) continue;
        markers.push({ nonce, payload: { v: 1, kind: value.kind } });
      } else if (value.kind === "state") {
        if (
          typeof value.canStage !== "boolean" ||
          typeof value.canMarkReviewed !== "boolean" ||
          (value.reviewed !== null && typeof value.reviewed !== "boolean") ||
          typeof value.reviewedCount !== "number" ||
          !Number.isSafeInteger(value.reviewedCount) ||
          value.reviewedCount < 0 ||
          typeof value.totalCount !== "number" ||
          !Number.isSafeInteger(value.totalCount) ||
          value.totalCount < 0 ||
          value.reviewedCount > value.totalCount ||
          (value.canReviewPr !== undefined && typeof value.canReviewPr !== "boolean") ||
          (value.canOpenSnapshot !== undefined && typeof value.canOpenSnapshot !== "boolean") ||
          (value.canAsk !== undefined && typeof value.canAsk !== "boolean") ||
          (value.canSend !== undefined && typeof value.canSend !== "boolean") ||
          (value.canOpenFile !== undefined && typeof value.canOpenFile !== "boolean") ||
          (value.canComment !== undefined && typeof value.canComment !== "boolean") ||
          (value.pendingCommentCount !== undefined &&
            (typeof value.pendingCommentCount !== "number" ||
              !Number.isSafeInteger(value.pendingCommentCount) ||
              value.pendingCommentCount < 0)) ||
          Object.keys(value).some(
            (key) =>
              ![
                "v",
                "kind",
                "canStage",
                "canMarkReviewed",
                "reviewed",
                "reviewedCount",
                "totalCount",
                "canReviewPr",
                "canOpenFile",
                "canOpenSnapshot",
                "canAsk",
                "canSend",
                "canComment",
                "pendingCommentCount",
              ].includes(key),
          )
        )
          continue;
        markers.push({
          nonce,
          payload: {
            v: 1,
            kind: "state",
            canStage: value.canStage,
            canMarkReviewed: value.canMarkReviewed,
            reviewed: value.reviewed,
            reviewedCount: value.reviewedCount,
            totalCount: value.totalCount,
            ...(typeof value.canOpenSnapshot === "boolean"
              ? { canOpenSnapshot: value.canOpenSnapshot }
              : {}),
            ...(typeof value.canAsk === "boolean" ? { canAsk: value.canAsk } : {}),
            ...(typeof value.canSend === "boolean" ? { canSend: value.canSend } : {}),
            ...(typeof value.canOpenFile === "boolean" ? { canOpenFile: value.canOpenFile } : {}),
            ...(typeof value.canComment === "boolean" ? { canComment: value.canComment } : {}),
            ...(typeof value.pendingCommentCount === "number"
              ? { pendingCommentCount: value.pendingCommentCount }
              : {}),
            ...(typeof value.canReviewPr === "boolean" ? { canReviewPr: value.canReviewPr } : {}),
          },
        });
      } else if (isHelixPrReviewPayload(value)) {
        markers.push({ nonce, payload: value });
      } else if (value.kind === "result") {
        if (
          typeof value.id !== "string" ||
          !UUID.test(value.id) ||
          typeof value.ok !== "boolean" ||
          (value.error !== undefined && typeof value.error !== "string") ||
          Object.keys(value).some((key) => !["v", "kind", "id", "ok", "error"].includes(key))
        )
          continue;
        markers.push({
          nonce,
          payload: {
            v: 1,
            kind: "result",
            id: value.id,
            ok: value.ok,
            ...(typeof value.error === "string" ? { error: value.error } : {}),
          },
        });
      }
    } catch {
      /* Malformed or incomplete OSC output is not a review acknowledgement. */
    }
  }
  return markers;
}

export function resolveHelixReviewReadyNonce(
  markers: readonly HelixReviewMarker[],
  previousNonce: string | null = null,
): string | null {
  let nonce = previousNonce;
  for (const marker of markers) {
    if (marker.payload.kind === "ready") nonce = marker.nonce;
    else if (marker.payload.kind === "closed" && marker.nonce === nonce) nonce = null;
  }
  return nonce;
}

export function resolveHelixReviewState(
  markers: readonly HelixReviewMarker[],
  nonce: string | null,
  previousState: HelixReviewState | null = null,
): HelixReviewState | null {
  // The caller resets previousState when its terminal lifecycle or attachment
  // changes. A nonce alone identifies the editor, not a particular attachment.
  if (nonce === null) return null;
  let activeNonce: string | null = nonce;
  let state = previousState?.nonce === nonce ? previousState : null;
  for (const marker of markers) {
    if (marker.payload.kind === "ready") {
      if (marker.nonce !== activeNonce) state = null;
      activeNonce = marker.nonce;
    } else if (marker.payload.kind === "closed" && marker.nonce === activeNonce) {
      activeNonce = null;
      state = null;
    } else if (
      marker.payload.kind === "state" &&
      marker.nonce === activeNonce &&
      marker.nonce === nonce
    ) {
      const {
        canStage,
        canMarkReviewed,
        reviewed,
        reviewedCount,
        totalCount,
        canReviewPr,
        canOpenFile,
        canOpenSnapshot,
        canAsk,
        canSend,
        canComment,
        pendingCommentCount,
      } = marker.payload;
      state = {
        nonce,
        canStage,
        canMarkReviewed,
        reviewed,
        reviewedCount,
        totalCount,
        ...(canReviewPr === undefined ? {} : { canReviewPr }),
        ...(canOpenFile === undefined ? {} : { canOpenFile }),
        ...(canOpenSnapshot === undefined ? {} : { canOpenSnapshot }),
        ...(canAsk === undefined ? {} : { canAsk }),
        ...(canSend === undefined ? {} : { canSend }),
        ...(canComment === undefined ? {} : { canComment }),
        ...(pendingCommentCount === undefined ? {} : { pendingCommentCount }),
      };
    }
  }
  if (activeNonce !== nonce || state === null) return null;
  if (
    previousState &&
    previousState.nonce === state.nonce &&
    previousState.canStage === state.canStage &&
    previousState.canMarkReviewed === state.canMarkReviewed &&
    previousState.reviewed === state.reviewed &&
    previousState.reviewedCount === state.reviewedCount &&
    previousState.totalCount === state.totalCount &&
    previousState.canReviewPr === state.canReviewPr &&
    previousState.canOpenFile === state.canOpenFile &&
    previousState.canOpenSnapshot === state.canOpenSnapshot &&
    previousState.canAsk === state.canAsk &&
    previousState.canSend === state.canSend &&
    previousState.canComment === state.canComment &&
    previousState.pendingCommentCount === state.pendingCommentCount
  )
    return previousState;
  return state;
}

export function resolveHelixPrReviewPayload(
  markers: readonly HelixReviewMarker[],
  nonce: string | null,
  previous: (HelixPrReviewPayload & { readonly nonce: string }) | null = null,
): (HelixPrReviewPayload & { readonly nonce: string }) | null {
  if (nonce === null) return null;
  let active = nonce;
  let payload = previous?.nonce === nonce ? previous : null;
  for (const marker of markers) {
    if (marker.payload.kind === "ready") {
      if (marker.nonce !== active) payload = null;
      active = marker.nonce;
    } else if (marker.payload.kind === "closed" && marker.nonce === active) {
      active = "";
      payload = null;
    } else if (marker.payload.kind === "pr-review" && marker.nonce === nonce && active === nonce) {
      payload = { nonce, ...marker.payload };
    }
  }
  if (active !== nonce) return null;
  if (payload === previous) return previous;
  return previous && JSON.stringify(previous) === JSON.stringify(payload) ? previous : payload;
}

export function resolveHelixPrReview(
  markers: readonly HelixReviewMarker[],
  nonce: string | null,
  previous: (HelixPrReviewPayload & { readonly nonce: string }) | null = null,
) {
  return resolveHelixPrReviewPayload(markers, nonce, previous)?.review ?? null;
}

export function encodeHelixReviewAction(
  nonce: string,
  id: string,
  action: HelixReviewAction,
  text?: string,
): string {
  if (!UUID.test(nonce) || !UUID.test(id))
    throw new Error("Invalid HX review session or request id.");
  if (!ACTIONS.has(action)) throw new Error("Unknown HX review action.");
  if (text !== undefined) {
    if (
      ![
        "open-file",
        "comment",
        "ask",
        "send",
        "pr-comment",
        "pr-suggestion",
        "pr-complete",
      ].includes(action)
    )
      throw new Error("This HX review action does not accept text.");
    if (utf8Hex(text).length > MAX_TEXT * 2) throw new Error("HX review text exceeds 8 KiB.");
  }
  if ((action === "ask" || action === "comment") && !text?.trim())
    throw new Error("Enter a question about the selected text.");
  const hex = utf8Hex(
    JSON.stringify({ v: 1, id, action, ...(text !== undefined ? { text } : {}) }),
  );
  if (hex.length > MAX_JSON * 2) throw new Error("HX review request exceeds 16 KiB.");
  // If HX exits before the paste arrives, the shell receives a comment with no
  // line ending. User text is encoded, so it cannot escape into shell syntax.
  return `\x1b[200~# hx-review:${nonce}:${hex}\x1b[201~`;
}

function sameTarget(a: HelixReviewTarget | null, b: HelixReviewTarget | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.environmentId === b.environmentId &&
      a.threadId === b.threadId &&
      a.terminalId === b.terminalId &&
      a.lifecycleVersion === b.lifecycleVersion &&
      a.attachGeneration === b.attachGeneration &&
      a.nonce === b.nonce)
  );
}

function sameEditor(a: HelixReviewTarget, b: HelixReviewTarget): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    a.terminalId === b.terminalId &&
    a.nonce === b.nonce
  );
}

export interface HelixReviewRetry {
  readonly target: HelixReviewTarget;
  readonly action: HelixReviewAction;
  readonly text: string | undefined;
}

interface Request extends HelixReviewRetry {
  readonly id: string;
  readonly frame: string;
  result?: Result;
}

interface Pending {
  readonly request: Request;
  readonly resolve: (requestId: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createHelixReviewController({
  newId,
  timeoutMs = 10_000,
}: {
  readonly newId: () => string;
  readonly timeoutMs?: number;
}) {
  let target: HelixReviewTarget | null = null;
  let disposed = false;
  let pending: Pending | null = null;
  // Keep only the latest uncertain request. Reusing its exact frame lets HX's
  // bounded response cache acknowledge a retry without repeating the action.
  let retained: Request | null = null;

  const finish = (attempt: Pending, error?: Error, uncertain = false) => {
    if (pending !== attempt) return;
    clearTimeout(attempt.timer);
    pending = null;
    if (!uncertain) retained = null;
    if (error) attempt.reject(error);
    else attempt.resolve(attempt.request.id);
  };

  return {
    update(nextTarget: HelixReviewTarget | null, markers: readonly HelixReviewMarker[]): void {
      if (disposed) return;
      if (!sameTarget(target, nextTarget)) {
        if (pending)
          finish(
            pending,
            new Error(
              "The HX review session changed before confirmation. Reopen and retry the same action to check delivery.",
            ),
            true,
          );
        target = nextTarget === null ? null : { ...nextTarget };
      }
      for (const marker of markers) {
        if (
          marker.payload.kind !== "result" ||
          retained === null ||
          marker.nonce !== retained.target.nonce ||
          marker.payload.id !== retained.id
        )
          continue;
        retained.result = marker.payload;
        if (pending?.request === retained) {
          finish(
            pending,
            marker.payload.ok
              ? undefined
              : new Error(marker.payload.error || "HX rejected the review action."),
          );
        } else if (!marker.payload.ok) retained = null;
      }
    },

    getRetry(): HelixReviewRetry | null {
      return pending === null ? retained : null;
    },

    async send(
      requestedTarget: HelixReviewTarget,
      action: HelixReviewAction,
      text: string | undefined,
      write: (frame: string) => Promise<boolean>,
    ): Promise<string> {
      if (disposed || target === null || !sameTarget(target, requestedTarget)) {
        throw new Error("The HX review session changed. Open the action again.");
      }
      if (pending) throw new Error("Another HX review action is still waiting for a response.");
      let request = retained;
      if (
        !request ||
        !sameEditor(request.target, requestedTarget) ||
        request.action !== action ||
        request.text !== text
      ) {
        const id = newId();
        request = {
          target: { ...requestedTarget },
          action,
          text,
          id,
          frame: encodeHelixReviewAction(requestedTarget.nonce, id, action, text),
        };
      } else request = { ...request, target: { ...requestedTarget } };
      if (request.result) {
        retained = null;
        if (!request.result.ok)
          throw new Error(request.result.error || "HX rejected the review action.");
        return request.id;
      }
      retained = request;
      const currentRequest = request;
      return new Promise<string>((resolve, reject) => {
        const attempt: Pending = {
          request: currentRequest,
          resolve,
          reject,
          timer: setTimeout(
            () =>
              finish(
                attempt,
                new Error("HX did not acknowledge the action. Retry to check the same request."),
                true,
              ),
            timeoutMs,
          ),
        };
        pending = attempt;
        // A write can complete after a timeout, target change, or retry. Only
        // this particular attempt may settle its waiting caller.
        void Promise.resolve()
          .then(() => {
            if (pending !== attempt || !sameTarget(target, currentRequest.target)) return;
            return write(currentRequest.frame);
          })
          .then(
            (written) => {
              if (written === false)
                finish(
                  attempt,
                  new Error("Could not confirm delivery to HX. Retry the same action."),
                  true,
                );
            },
            () =>
              finish(
                attempt,
                new Error("Could not confirm delivery to HX. Retry the same action."),
                true,
              ),
          );
      });
    },

    dispose(): void {
      disposed = true;
      if (pending) finish(pending, new Error("The HX review session closed."));
      target = null;
      retained = null;
    },
  };
}
