import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createHelixReviewController,
  encodeHelixReviewAction,
  encodeHelixReviewDiscovery,
  parseHelixReviewMarkers,
  resolveHelixReviewReadyNonce,
  resolveHelixReviewState,
  resolveHelixPrReviewPayload,
  type HelixReviewState,
  type HelixReviewTarget,
} from "./helixReviewControl.ts";

const NONCE = "00000000-0000-4000-8000-000000000001";
const OTHER_NONCE = "00000000-0000-4000-8000-000000000002";
const ID = "00000000-0000-4000-8000-000000000003";
const STATE = {
  v: 1,
  kind: "state",
  canStage: true,
  canMarkReviewed: true,
  reviewed: false,
  reviewedCount: 1,
  totalCount: 3,
} as const;
const REVIEW_STATE: HelixReviewState = {
  nonce: NONCE,
  canStage: true,
  canMarkReviewed: true,
  reviewed: false,
  reviewedCount: 1,
  totalCount: 3,
};
const TARGET: HelixReviewTarget = {
  environmentId: "environment-1",
  threadId: "thread-1",
  terminalId: "helix-review-1",
  lifecycleVersion: 1,
  attachGeneration: 1,
  nonce: NONCE,
};

const PR_REVIEW = {
  v: 1,
  kind: "pr-review",
  requestId: ID,
  review: {
    revision: "revision-1",
    pr: {
      url: "https://github.com/team/project/pull/7",
      repo: "team/project",
      number: 7,
      headSha: "a".repeat(40),
      title: "Fix parser",
    },
    selection: {
      id: "selection",
      path: "src/parser.ts",
      side: "LEFT",
      startLine: 3,
      line: 4,
      code: "old\ntext",
    },
    comments: [
      {
        id: "comment",
        path: "src/parser.ts",
        side: "LEFT",
        startLine: 3,
        line: 4,
        code: "old\ntext",
        body: "Keep this check",
      },
    ],
    suggestions: [
      {
        id: "suggestion",
        path: "src/parser.ts",
        startLine: 8,
        line: 9,
        original: "before",
        replacement: "after",
        accepted: false,
      },
    ],
  },
} as const;

function marker(payload: unknown, nonce = NONCE, terminator = "\x07") {
  const hex = Array.from(new TextEncoder().encode(JSON.stringify(payload)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `\x1b]777;hx-review;${nonce};${hex}${terminator}`;
}

function decode(frame: string): { v: number; id: string; action: string; text?: string } {
  const hex = frame.slice("\x1b[200~# hx-review:".length + NONCE.length + 1, -"\x1b[201~".length);
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(hex.match(/../gu)!, (byte) => parseInt(byte, 16))),
  );
}

const controllers: ReturnType<typeof createHelixReviewController>[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  let ids = 0;
  const controller = createHelixReviewController({
    newId: () => `10000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    timeoutMs: 1000,
  });
  controllers.push(controller);
  controller.update(TARGET, []);
  const write = vi.fn(async (_frame: string) => true);
  const acknowledge = (frame: string, ok = true, error?: string) =>
    controller.update(
      TARGET,
      parseHelixReviewMarkers(
        marker({
          v: 1,
          kind: "result",
          id: decode(frame).id,
          ok,
          ...(error === undefined ? {} : { error }),
        }),
      ),
    );
  return { controller, write, acknowledge };
}

describe("HX review control protocol", () => {
  it("receives a correlated PR preview larger than ordinary control responses", () => {
    const preview = {
      ...PR_REVIEW,
      review: {
        ...PR_REVIEW.review,
        suggestions: [{ ...PR_REVIEW.review.suggestions[0], replacement: "x".repeat(20_000) }],
      },
    };
    const parsed = parseHelixReviewMarkers(marker(preview));
    expect(parsed).toEqual([{ nonce: NONCE, payload: preview }]);
    expect(resolveHelixPrReviewPayload(parsed, NONCE)?.requestId).toBe(ID);
    expect(
      parseHelixReviewMarkers(
        marker({ ...preview, review: { ...preview.review, error: "x".repeat(49_152) } }),
      ),
    ).toEqual([]);
  });

  it("keeps PR drafts scoped to their editor and retains them across output rollover", () => {
    const parsed = parseHelixReviewMarkers(marker(PR_REVIEW));
    const cached = resolveHelixPrReviewPayload(parsed, NONCE);
    expect(resolveHelixPrReviewPayload([], NONCE, cached)).toBe(cached);
    expect(resolveHelixPrReviewPayload(parsed, NONCE, cached)).toBe(cached);
    expect(resolveHelixPrReviewPayload([], OTHER_NONCE, cached)).toBeNull();
    expect(
      resolveHelixPrReviewPayload(
        parseHelixReviewMarkers(marker({ v: 1, kind: "closed" })),
        NONCE,
        cached,
      ),
    ).toBeNull();
    const replaced = parseHelixReviewMarkers(
      marker({ v: 1, kind: "ready" }, OTHER_NONCE) + marker(PR_REVIEW),
    );
    expect(resolveHelixPrReviewPayload(replaced, NONCE, cached)).toBeNull();
    expect(
      resolveHelixPrReviewPayload(
        parseHelixReviewMarkers(
          marker({
            v: 1,
            kind: "pr-review",
            requestId: ID,
            review: null,
            error: "PR head changed",
          }),
        ),
        NONCE,
        cached,
      )?.review,
    ).toBeNull();
  });

  it("rejects malformed PR anchors, duplicate IDs, mismatched repository URLs and revisions", () => {
    const invalid = [
      { ...PR_REVIEW, requestId: "wrong" },
      { ...PR_REVIEW, review: { ...PR_REVIEW.review, revision: "" } },
      {
        ...PR_REVIEW,
        review: {
          ...PR_REVIEW.review,
          pr: { ...PR_REVIEW.review.pr, url: "https://github.com/other/project/pull/7" },
        },
      },
      {
        ...PR_REVIEW,
        review: { ...PR_REVIEW.review, selection: { ...PR_REVIEW.review.selection, startLine: 5 } },
      },
      {
        ...PR_REVIEW,
        review: {
          ...PR_REVIEW.review,
          comments: [{ ...PR_REVIEW.review.comments[0], path: "../outside" }],
        },
      },
      {
        ...PR_REVIEW,
        review: {
          ...PR_REVIEW.review,
          suggestions: [{ ...PR_REVIEW.review.suggestions[0], id: "comment" }],
        },
      },
    ];
    for (const value of invalid) expect(parseHelixReviewMarkers(marker(value))).toEqual([]);
  });

  it("encodes PR draft mutations as inert text and returns the acknowledged request ID", async () => {
    const { controller, write, acknowledge } = fixture();
    const text = JSON.stringify({
      revision: "r",
      selectionId: "selection",
      body: "λ\n$(not-a-command)",
    });
    const sending = controller.send(TARGET, "pr-comment", text, write);
    await vi.advanceTimersByTimeAsync(0);
    const frame = write.mock.calls[0]![0];
    expect(decode(frame).text).toBe(text);
    acknowledge(frame);
    await expect(sending).resolves.toBe(decode(frame).id);
  });

  it("discovers an opt-in editor with a single-line shell comment paste", () => {
    expect(encodeHelixReviewDiscovery()).toBe("\x1b[200~# hx-review:discover\x1b[201~");
    expect(encodeHelixReviewDiscovery()).not.toMatch(/[\r\n]/u);
  });

  it("round trips Unicode, quotes, shell syntax, and newlines inside an inert single-line paste", () => {
    const text = "Why remove λ 🦀?\n'\"; $(touch /tmp/unwanted)\r\n@other";
    const frame = encodeHelixReviewAction(NONCE, ID, "ask", text);
    // eslint-disable-next-line no-control-regex -- Verify exact bracketed-paste framing.
    expect(frame).toMatch(/^\x1b\[200~# hx-review:[\da-f-]+:[\da-f]+\x1b\[201~$/u);
    expect(frame).not.toMatch(/[\r\n]/u);
    expect(decode(frame)).toEqual({ v: 1, id: ID, action: "ask", text });
    expect(decode(encodeHelixReviewAction(NONCE, ID, "send"))).toEqual({
      v: 1,
      id: ID,
      action: "send",
    });
  });

  it("validates action, identifiers, UTF-8 text size, and serialized request size before writing", () => {
    expect(() => encodeHelixReviewAction("bad", ID, "next")).toThrow(/session/u);
    expect(() => encodeHelixReviewAction(NONCE, "bad", "next")).toThrow(/request id/u);
    expect(() => encodeHelixReviewAction(NONCE, ID, "unknown" as "next")).toThrow(/Unknown/u);
    expect(() => encodeHelixReviewAction(NONCE, ID, "ask", " \n ")).toThrow(/question/u);
    expect(() => encodeHelixReviewAction(NONCE, ID, "next", "text")).toThrow(
      /does not accept text/u,
    );
    expect(() => encodeHelixReviewAction(NONCE, ID, "ask", "🦀".repeat(2048))).not.toThrow();
    expect(() => encodeHelixReviewAction(NONCE, ID, "ask", "🦀".repeat(2049))).toThrow(/8 KiB/u);
    expect(() => encodeHelixReviewAction(NONCE, ID, "send", "\0".repeat(8192))).toThrow(/16 KiB/u);
  });

  it("parses strict hex UTF-8 OSC markers with BEL and ST among normal terminal output", () => {
    const output =
      "shell\n" +
      marker({ v: 1, kind: "ready" }) +
      "editor" +
      marker(
        { v: 1, kind: "result", id: ID, ok: false, error: "Select λ first" },
        NONCE,
        "\x1b\\",
      ) +
      marker({ v: 1, kind: "closed" });
    expect(parseHelixReviewMarkers(output)).toEqual([
      { nonce: NONCE, payload: { v: 1, kind: "ready" } },
      {
        nonce: NONCE,
        payload: { v: 1, kind: "result", id: ID, ok: false, error: "Select λ first" },
      },
      { nonce: NONCE, payload: { v: 1, kind: "closed" } },
    ]);
  });

  it("ignores malformed, incomplete, oversized, and stale output outside the scan window", () => {
    const invalid =
      [
        { v: 2, kind: "ready" },
        { v: 1, kind: "unknown" },
        { v: 1, kind: "ready", ok: true },
        { v: 1, kind: "result", id: ID, ok: "yes" },
        { v: 1, kind: "result", id: "", ok: true },
        { v: 1, kind: "result", id: ID, ok: true, error: 42 },
        { v: 1, kind: "result", id: ID, ok: true, unexpected: true },
        { v: 1, kind: "result", id: ID, ok: false, error: "x".repeat(16 * 1024) },
      ]
        .map((value) => marker(value))
        .join("") +
      `\x1b]777;hx-review;${NONCE};ff\x07` +
      `\x1b]777;hx-review;${NONCE};abc\x07` +
      marker({ v: 1, kind: "ready" }, "x".repeat(36)) +
      marker({ v: 1, kind: "ready" }).slice(0, -1);
    expect(parseHelixReviewMarkers(invalid)).toEqual([]);
    expect(
      parseHelixReviewMarkers(marker({ v: 1, kind: "ready" }) + "x".repeat(128 * 1024)),
    ).toEqual([]);
  });

  it("retains readiness across rolling output and handles close, newer editors, and resume", () => {
    const parse = (kind: "ready" | "closed", nonce = NONCE) =>
      parseHelixReviewMarkers(marker({ v: 1, kind }, nonce));
    expect(resolveHelixReviewReadyNonce([], NONCE)).toBe(NONCE);
    expect(resolveHelixReviewReadyNonce(parse("closed"), NONCE)).toBeNull();
    expect(resolveHelixReviewReadyNonce([...parse("closed"), ...parse("ready")], NONCE)).toBe(
      NONCE,
    );
    expect(
      resolveHelixReviewReadyNonce([...parse("ready", OTHER_NONCE), ...parse("closed")], NONCE),
    ).toBe(OTHER_NONCE);
  });

  it.each([true, false, null])(
    "parses the exact current-file review state with reviewed=%s",
    (reviewed) => {
      const payload = { ...STATE, reviewed };
      const parsed = parseHelixReviewMarkers(marker(payload));
      expect(parsed).toEqual([{ nonce: NONCE, payload }]);
      expect(resolveHelixReviewReadyNonce(parsed, NONCE)).toBe(NONCE);
      expect(resolveHelixReviewState(parsed, NONCE)).toEqual({ ...REVIEW_STATE, reviewed });
    },
  );

  it("rejects malformed state fields and unsafe, fractional, or inconsistent counts", () => {
    const invalid: unknown[] = [
      { ...STATE, canStage: "true" },
      { ...STATE, canMarkReviewed: 1 },
      { ...STATE, reviewed: "false" },
      { ...STATE, reviewedCount: -1 },
      { ...STATE, totalCount: -1 },
      { ...STATE, reviewedCount: 0.5 },
      { ...STATE, totalCount: 1.5 },
      { ...STATE, reviewedCount: "1" },
      { ...STATE, totalCount: null },
      {
        ...STATE,
        reviewedCount: Number.MAX_SAFE_INTEGER + 1,
        totalCount: Number.MAX_SAFE_INTEGER + 1,
      },
      { ...STATE, totalCount: Number.MAX_SAFE_INTEGER + 1 },
      { ...STATE, reviewedCount: 4 },
      { ...STATE, extra: true },
      { ...STATE, nonce: NONCE },
    ];
    for (const key of Object.keys(STATE)) {
      invalid.push(Object.fromEntries(Object.entries(STATE).filter(([name]) => name !== key)));
    }
    for (const payload of invalid) expect(parseHelixReviewMarkers(marker(payload))).toEqual([]);
    expect(
      parseHelixReviewMarkers(marker({ ...STATE, reviewedCount: 0, totalCount: 0 })),
    ).toHaveLength(1);
    expect(
      parseHelixReviewMarkers(
        marker({
          ...STATE,
          reviewedCount: Number.MAX_SAFE_INTEGER,
          totalCount: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).toHaveLength(1);
  });

  it("retains only same-nonce state through rolling output and repeated ready markers", () => {
    expect(resolveHelixReviewState([], NONCE, REVIEW_STATE)).toEqual(REVIEW_STATE);
    const ready = parseHelixReviewMarkers(marker({ v: 1, kind: "ready" }));
    expect(resolveHelixReviewState(ready, NONCE, REVIEW_STATE)).toEqual(REVIEW_STATE);
    expect(resolveHelixReviewState([], OTHER_NONCE, REVIEW_STATE)).toBeNull();
    expect(resolveHelixReviewState([], null, REVIEW_STATE)).toBeNull();
    expect(resolveHelixReviewState(ready, NONCE)).toBeNull();
    const replay = parseHelixReviewMarkers(marker({ v: 1, kind: "ready" }) + marker(STATE));
    const state = resolveHelixReviewState(replay, NONCE);
    expect(resolveHelixReviewState(replay, NONCE, state)).toBe(state);
    expect(
      resolveHelixReviewState(
        parseHelixReviewMarkers(marker({ ...STATE, reviewed: true })),
        NONCE,
        state,
      ),
    ).not.toBe(state);
  });

  it("clears state on close, replacement, and resume without accepting stale state after close", () => {
    const closed = marker({ v: 1, kind: "closed" });
    const ready = marker({ v: 1, kind: "ready" });
    expect(
      resolveHelixReviewState(parseHelixReviewMarkers(marker(STATE) + closed), NONCE, REVIEW_STATE),
    ).toBeNull();
    expect(
      resolveHelixReviewState(parseHelixReviewMarkers(closed + marker(STATE)), NONCE, REVIEW_STATE),
    ).toBeNull();
    expect(
      resolveHelixReviewState(
        parseHelixReviewMarkers(marker(STATE) + closed + ready),
        NONCE,
        REVIEW_STATE,
      ),
    ).toBeNull();
    const resumed = parseHelixReviewMarkers(closed + ready + marker({ ...STATE, reviewed: true }));
    expect(resolveHelixReviewState(resumed, NONCE, REVIEW_STATE)?.reviewed).toBe(true);
    const replacement = parseHelixReviewMarkers(
      marker(STATE) + marker({ v: 1, kind: "ready" }, OTHER_NONCE),
    );
    expect(resolveHelixReviewState(replacement, OTHER_NONCE, REVIEW_STATE)).toBeNull();
    expect(
      resolveHelixReviewState(
        parseHelixReviewMarkers(marker({ v: 1, kind: "closed" }, OTHER_NONCE)),
        NONCE,
        REVIEW_STATE,
      ),
    ).toEqual(REVIEW_STATE);
  });

  it.each(["mark-reviewed", "unmark-reviewed"] as const)(
    "encodes %s as a distinct action without accepting text",
    (action) => {
      expect(decode(encodeHelixReviewAction(NONCE, ID, action)).action).toBe(action);
      expect(() => encodeHelixReviewAction(NONCE, ID, action, "text")).toThrow(
        /does not accept text/u,
      );
    },
  );
});

describe("HX review action controller", () => {
  it("reuses a mark-reviewed UUID on uncertain retry so the editor cannot step twice", async () => {
    const { controller, acknowledge } = fixture();
    const accepted = new Set<string>();
    let advances = 0;
    const write = vi.fn(async (frame: string) => {
      const request = decode(frame);
      expect(request.action).toBe("mark-reviewed");
      if (!accepted.has(request.id)) {
        accepted.add(request.id);
        advances++;
      }
      // The final mark has already taken effect: the toolbar's current-state
      // action is now Unmark, so retry must expose the original Mark separately.
      controller.update(
        TARGET,
        parseHelixReviewMarkers(marker({ ...STATE, reviewed: true, reviewedCount: 3 })),
      );
      if (write.mock.calls.length > 1) acknowledge(frame);
      return true;
    });
    expect(controller.getRetry()).toBeNull();
    const first = controller.send(TARGET, "mark-reviewed", undefined, write);
    expect(controller.getRetry()).toBeNull();
    const timedOut = expect(first).rejects.toThrow(/did not acknowledge/u);
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;
    const previous = controller.getRetry();
    expect(previous).toEqual(
      expect.objectContaining({ target: TARGET, action: "mark-reviewed", text: undefined }),
    );
    expect(controller.getRetry()).toBe(previous);
    const retry = controller.send(TARGET, previous!.action, previous!.text, write);
    await retry;
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0]).toBe(write.mock.calls[0]![0]);
    expect(advances).toBe(1);
    expect(controller.getRetry()).toBeNull();
  });

  it("waits for the matching nonce and request acknowledgement and rejects concurrent actions", async () => {
    const { controller, write, acknowledge } = fixture();
    const sent = controller.send(TARGET, "ask", "Why remove this?", write);
    await vi.advanceTimersByTimeAsync(0);
    const frame = write.mock.calls[0]![0];
    controller.update(
      TARGET,
      parseHelixReviewMarkers(
        marker({ v: 1, kind: "result", id: decode(frame).id, ok: true }, OTHER_NONCE) +
          marker({ v: 1, kind: "result", id: ID, ok: true }),
      ),
    );
    await expect(controller.send(TARGET, "next", undefined, write)).rejects.toThrow(
      /still waiting/u,
    );
    acknowledge(frame);
    await sent;
    expect(write).toHaveBeenCalledTimes(1);
    const next = controller.send(TARGET, "ask", "Why remove this?", write);
    await vi.advanceTimersByTimeAsync(0);
    expect(decode(write.mock.calls[1]![0]).id).not.toBe(decode(frame).id);
    acknowledge(write.mock.calls[1]![0]);
    await next;
  });

  it.each([
    { environmentId: "other" },
    { threadId: "other" },
    { terminalId: "other" },
    { lifecycleVersion: 2 },
    { attachGeneration: 2 },
    { nonce: OTHER_NONCE },
  ])("rejects stale bound targets before a write: %j", async (change) => {
    const { controller, write } = fixture();
    await expect(
      controller.send({ ...TARGET, ...change }, "stage", undefined, write),
    ).rejects.toThrow(/session changed/u);
    expect(write).not.toHaveBeenCalled();
  });

  it("invalidates pending writes on a session change or disposal", async () => {
    const { controller, write } = fixture();
    const sent = controller.send(TARGET, "send", "Continue", write);
    const rejected = expect(sent).rejects.toThrow(/session changed/u);
    controller.update({ ...TARGET, threadId: "other" }, []);
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(write).not.toHaveBeenCalled();
    controller.update(TARGET, []);
    const pending = controller.send(TARGET, "next", undefined, write);
    const closed = expect(pending).rejects.toThrow(/session closed/u);
    controller.dispose();
    await closed;
    await expect(controller.send(TARGET, "next", undefined, write)).rejects.toThrow(
      /session changed/u,
    );
  });

  it("reports explicit HX rejection and allows a corrected retry with a fresh id", async () => {
    const { controller, write, acknowledge } = fixture();
    const sent = controller.send(TARGET, "stage", undefined, write);
    const rejected = expect(sent).rejects.toThrow("close the HX picker");
    await vi.advanceTimersByTimeAsync(0);
    acknowledge(write.mock.calls[0]![0], false, "close the HX picker");
    await rejected;
    const retry = controller.send(TARGET, "stage", undefined, write);
    await vi.advanceTimersByTimeAsync(0);
    expect(decode(write.mock.calls[1]![0]).id).not.toBe(decode(write.mock.calls[0]![0]).id);
    acknowledge(write.mock.calls[1]![0]);
    await retry;
  });

  it("retries timed out requests using exactly the same frame and handles acknowledgements before write resolves", async () => {
    const { controller, write, acknowledge } = fixture();
    const sent = controller.send(TARGET, "send", "Continue", write);
    const timedOut = expect(sent).rejects.toThrow(/did not acknowledge/u);
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;
    const frame = write.mock.calls[0]![0];
    const retry = controller.send(TARGET, "send", "Continue", async (value) => {
      expect(value).toBe(frame);
      acknowledge(value);
      return false;
    });
    await retry;
  });

  it("consumes late success after timeout without resending, then permits an intentional new action", async () => {
    const { controller, write, acknowledge } = fixture();
    const sent = controller.send(TARGET, "next", undefined, write);
    const timedOut = expect(sent).rejects.toThrow(/did not acknowledge/u);
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;
    acknowledge(write.mock.calls[0]![0]);
    expect(controller.getRetry()?.action).toBe("next");
    await controller.send(TARGET, "next", undefined, write);
    expect(controller.getRetry()).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
    const next = controller.send(TARGET, "next", undefined, write);
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    acknowledge(write.mock.calls[1]![0]);
    await next;
  });

  it("does not offer retry after a late known rejection and permits a fresh attempt", async () => {
    const { controller, write, acknowledge } = fixture();
    const first = controller.send(TARGET, "mark-reviewed", undefined, write);
    const timedOut = expect(first).rejects.toThrow(/did not acknowledge/u);
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;
    expect(controller.getRetry()?.action).toBe("mark-reviewed");
    acknowledge(write.mock.calls[0]![0], false, "Not a committed change");
    expect(controller.getRetry()).toBeNull();
    const fresh = controller.send(TARGET, "mark-reviewed", undefined, write);
    await vi.advanceTimersByTimeAsync(0);
    expect(decode(write.mock.calls[1]![0]).id).not.toBe(decode(write.mock.calls[0]![0]).id);
    acknowledge(write.mock.calls[1]![0]);
    await fresh;
  });

  it.each([false, new Error("disconnected")])(
    "retains an uncertain frame after write failure: %j",
    async (failure) => {
      const { controller, write, acknowledge } = fixture();
      const failingWrite = vi.fn(async (_frame: string) => {
        if (failure instanceof Error) throw failure;
        return failure;
      });
      await expect(controller.send(TARGET, "ask", "Why?", failingWrite)).rejects.toThrow(
        /confirm delivery/u,
      );
      const retry = controller.send(TARGET, "ask", "Why?", write);
      await vi.advanceTimersByTimeAsync(0);
      expect(write.mock.calls[0]![0]).toBe(failingWrite.mock.calls[0]![0]);
      acknowledge(write.mock.calls[0]![0]);
      await retry;
    },
  );

  it("ignores a delayed write failure from an earlier attempt while its retry is pending", async () => {
    const { controller, write, acknowledge } = fixture();
    let finishOldWrite!: (written: boolean) => void;
    const sent = controller.send(
      TARGET,
      "send",
      undefined,
      () =>
        new Promise<boolean>((done) => {
          finishOldWrite = done;
        }),
    );
    const timedOut = expect(sent).rejects.toThrow(/did not acknowledge/u);
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;
    const retry = controller.send(TARGET, "send", undefined, write);
    await vi.advanceTimersByTimeAsync(0);
    finishOldWrite(false);
    await vi.advanceTimersByTimeAsync(0);
    acknowledge(write.mock.calls[0]![0]);
    await retry;
  });

  it("preserves an unconfirmed id across disconnect and reattach while rejecting an old sheet", async () => {
    const { controller, write } = fixture();
    const sent = controller.send(TARGET, "send", "Continue", write);
    const disconnected = expect(sent).rejects.toThrow(/before confirmation/u);
    await vi.advanceTimersByTimeAsync(0);
    const frame = write.mock.calls[0]![0];
    controller.update(null, []);
    await disconnected;
    const reattached = { ...TARGET, attachGeneration: 2, lifecycleVersion: 0 };
    controller.update(reattached, []);
    await expect(controller.send(TARGET, "send", "Continue", write)).rejects.toThrow(
      /session changed/u,
    );
    const retry = controller.send(reattached, "send", "Continue", write);
    await vi.advanceTimersByTimeAsync(0);
    expect(write.mock.calls[1]![0]).toBe(frame);
    controller.update(
      reattached,
      parseHelixReviewMarkers(marker({ v: 1, kind: "result", id: decode(frame).id, ok: true })),
    );
    await retry;
  });

  it("consumes a late acknowledgement received during disconnection without resending", async () => {
    const { controller, write } = fixture();
    const sent = controller.send(TARGET, "ask", "Why?", write);
    const disconnected = expect(sent).rejects.toThrow(/before confirmation/u);
    await vi.advanceTimersByTimeAsync(0);
    const frame = write.mock.calls[0]![0];
    controller.update(null, []);
    await disconnected;
    const results = parseHelixReviewMarkers(
      marker({ v: 1, kind: "result", id: decode(frame).id, ok: true }),
    );
    controller.update(null, results);
    const reattached = { ...TARGET, attachGeneration: 2 };
    controller.update(reattached, results);
    await controller.send(reattached, "ask", "Why?", write);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("drops an uncertain request when a different action replaces it and ignores repeated old markers", async () => {
    const { controller, write, acknowledge } = fixture();
    const sent = controller.send(TARGET, "next", undefined, write);
    const timedOut = expect(sent).rejects.toThrow(/did not acknowledge/u);
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;
    const old = write.mock.calls[0]![0];
    const different = controller.send(TARGET, "files", undefined, write);
    await vi.advanceTimersByTimeAsync(0);
    acknowledge(old);
    await expect(controller.send(TARGET, "next", undefined, write)).rejects.toThrow(
      /still waiting/u,
    );
    acknowledge(write.mock.calls[1]![0]);
    await different;
    const next = controller.send(TARGET, "next", undefined, write);
    await vi.advanceTimersByTimeAsync(0);
    expect(decode(write.mock.calls[2]![0]).id).not.toBe(decode(old).id);
    acknowledge(write.mock.calls[2]![0]);
    await next;
  });
});

describe("Helix file navigation and ordinary feedback", () => {
  it("carries file locations and pending comments through the guarded protocol", () => {
    const options = JSON.stringify({ filePath: "src/a 'quoted'.ts", line: 17 });
    expect(encodeHelixReviewAction(NONCE, ID, "open-file", options)).not.toContain(options);
    expect(() => encodeHelixReviewAction(NONCE, ID, "comment", "")).toThrow();
    expect(() => encodeHelixReviewAction(NONCE, ID, "comment", "Keep this pending")).not.toThrow();
  });
  it("reads capabilities and rejects invalid pending counts", () => {
    const marker = (state: unknown) =>
      `\x1b]777;hx-review;${NONCE};${Buffer.from(JSON.stringify(state)).toString("hex")}\x07`;
    const payload = {
      ...STATE,
      canOpenFile: true,
      canOpenSnapshot: true,
      canAsk: false,
      canSend: false,
      canComment: false,
      pendingCommentCount: 2,
    };
    expect(parseHelixReviewMarkers(marker(payload))[0]?.payload).toEqual(payload);
    expect(
      resolveHelixReviewState(parseHelixReviewMarkers(marker(payload)), NONCE, REVIEW_STATE),
    ).toMatchObject({
      canOpenFile: true,
      canOpenSnapshot: true,
      canAsk: false,
      canSend: false,
      canComment: false,
      pendingCommentCount: 2,
    });
    expect(parseHelixReviewMarkers(marker({ ...payload, pendingCommentCount: -1 }))).toEqual([]);
    expect(parseHelixReviewMarkers(marker(STATE))).toHaveLength(1);
  });
});
