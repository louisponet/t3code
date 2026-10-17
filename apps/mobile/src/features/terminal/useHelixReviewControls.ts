import {
  createHelixReviewController,
  parseHelixReviewMarkers,
  resolveHelixReviewReadyNonce,
  resolveHelixReviewState,
  resolveHelixPrReviewPayload,
  encodeHelixReviewDiscovery,
  type HelixReviewAction,
  type HelixReviewTarget,
  type HelixReviewState,
  type HelixReviewRetry,
  type HelixPrReviewPayload,
} from "@t3tools/client-runtime/helix-review-control";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { uuidv4 } from "../../lib/uuid";
import type { HelixMode } from "@t3tools/client-runtime/helix-review";

import { peekHelixOpen, takeHelixOpen, useHelixOpenRevision } from "./helixOpenContext";

type Prompt = {
  id: string;
  action: "ask" | "send" | "comment";
  mode: HelixMode;
  target: HelixReviewTarget;
  title: string;
  text: string;
};

function sameTarget(left: HelixReviewTarget | null, right: HelixReviewTarget | null) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function useHelixReviewControls(input: {
  environmentId: string | null;
  threadId: string | null;
  terminalId: string;
  lifecycleVersion: number;
  attachGeneration: number;
  attached: boolean;
  canDiscover: boolean;
  buffer: string;
  enabled: boolean;
  title: string;
  write: (target: Omit<HelixReviewTarget, "nonce">, frame: string) => Promise<boolean>;
}) {
  const { write } = input;
  const openRevision = useHelixOpenRevision();
  const controllerRef = useRef<ReturnType<typeof createHelixReviewController> | null>(null);
  const markers = useMemo(() => parseHelixReviewMarkers(input.buffer), [input.buffer]);
  const contextKey = JSON.stringify([
    input.environmentId,
    input.threadId,
    input.terminalId,
    input.lifecycleVersion,
    input.attachGeneration,
  ]);
  const [readiness, setReadiness] = useState<{ key: string; nonce: string | null }>({
    key: contextKey,
    nonce: null,
  });
  const nonce = resolveHelixReviewReadyNonce(
    markers,
    readiness.key === contextKey ? readiness.nonce : null,
  );
  if (readiness.key !== contextKey || readiness.nonce !== nonce) {
    setReadiness({ key: contextKey, nonce });
  }
  const [reviewStateCache, setReviewStateCache] = useState<{
    key: string;
    state: HelixReviewState | null;
  }>({ key: contextKey, state: null });
  const reviewState = resolveHelixReviewState(
    markers,
    nonce,
    reviewStateCache.key === contextKey ? reviewStateCache.state : null,
  );
  if (reviewStateCache.key !== contextKey || reviewStateCache.state !== reviewState) {
    setReviewStateCache({ key: contextKey, state: reviewState });
  }
  const [prReviewCache, setPrReviewCache] = useState<{
    key: string;
    payload: (HelixPrReviewPayload & { readonly nonce: string }) | null;
  }>({ key: contextKey, payload: null });
  const prReviewPayload = resolveHelixPrReviewPayload(
    markers,
    nonce,
    prReviewCache.key === contextKey ? prReviewCache.payload : null,
  );
  if (prReviewCache.key !== contextKey || prReviewCache.payload !== prReviewPayload)
    setPrReviewCache({ key: contextKey, payload: prReviewPayload });
  const target = useMemo(
    (): HelixReviewTarget | null =>
      input.enabled && input.environmentId && input.threadId && nonce
        ? {
            environmentId: input.environmentId,
            threadId: input.threadId,
            terminalId: input.terminalId,
            lifecycleVersion: input.lifecycleVersion,
            attachGeneration: input.attachGeneration,
            nonce,
          }
        : null,
    [
      input.enabled,
      input.environmentId,
      input.threadId,
      input.terminalId,
      input.lifecycleVersion,
      input.attachGeneration,
      nonce,
    ],
  );
  const latest = useRef({
    target,
    markers,
    reviewState,
    prReviewPayload,
    write: input.write,
    contextKey,
  });
  useLayoutEffect(() => {
    latest.current = {
      target,
      markers,
      reviewState,
      prReviewPayload,
      write: input.write,
      contextKey,
    };
  }, [target, markers, reviewState, prReviewPayload, input.write, contextKey]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<HelixReviewRetry | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  // A reattach changes stream generations, but a matching HX nonce still
  // identifies the same editor. Keep its draft usable after reconnecting.
  const currentPrompt =
    prompt &&
    target &&
    prompt.target.environmentId === target.environmentId &&
    prompt.target.threadId === target.threadId &&
    prompt.target.terminalId === target.terminalId &&
    prompt.target.nonce === target.nonce
      ? { ...prompt, target }
      : prompt;
  const [messageContext, setMessageContext] = useState(contextKey);
  if (messageContext !== contextKey) {
    setMessageContext(contextKey);
    setNotice(null);
    setError(null);
  }

  useEffect(() => {
    const controller = createHelixReviewController({ newId: uuidv4 });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);
  useEffect(() => {
    const controller = controllerRef.current;
    controller?.update(target, markers);
    setRetry(controller?.getRetry() ?? null);
  }, [target, markers]);

  const discovered = useRef<string | null>(null);
  const discover = useCallback(async () => {
    if (
      !input.enabled ||
      !input.canDiscover ||
      !input.attached ||
      !input.environmentId ||
      !input.threadId
    )
      return;
    discovered.current = contextKey;
    setError(null);
    try {
      const written = await write(
        {
          environmentId: input.environmentId,
          threadId: input.threadId,
          terminalId: input.terminalId,
          lifecycleVersion: input.lifecycleVersion,
          attachGeneration: input.attachGeneration,
        },
        encodeHelixReviewDiscovery(),
      );
      if (!written) throw new Error("Could not reach HX. Retry when the connection is ready.");
    } catch {
      if (latest.current.contextKey === contextKey) {
        setError("Could not reach HX. Retry when the connection is ready.");
      }
    }
  }, [
    contextKey,
    input.enabled,
    input.canDiscover,
    input.attached,
    input.environmentId,
    input.threadId,
    input.terminalId,
    input.lifecycleVersion,
    input.attachGeneration,
    write,
  ]);
  useEffect(() => {
    if (!input.enabled) {
      discovered.current = null;
      return;
    }
    // Refresh replayed state once per attachment, after the launch write is ready.
    if (discovered.current !== contextKey) void discover();
  }, [contextKey, discover, input.enabled]);

  const submit = useCallback(
    async (captured: HelixReviewTarget, action: HelixReviewAction, text?: string) => {
      if (busyRef.current) return false;
      if (!sameTarget(captured, latest.current.target)) {
        setError(
          "This HX session changed or disconnected. Close this sheet and reopen it in the current session.",
        );
        return false;
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const controller = controllerRef.current;
        if (!controller) throw new Error("HX controls are not ready yet.");
        controller.update(latest.current.target, latest.current.markers);
        const id = await controller.send(captured, action, text, (frame) => {
          if (!sameTarget(captured, latest.current.target)) return Promise.resolve(false);
          return latest.current.write(captured, frame);
        });
        if (sameTarget(captured, latest.current.target))
          setNotice(
            action === "ask" || action === "send"
              ? "Accepted in HX. Check this thread for the reply."
              : action === "stage"
                ? "Hunk staged in HX."
                : null,
          );
        return id;
      } catch (cause) {
        if (
          latest.current.contextKey ===
          JSON.stringify([
            captured.environmentId,
            captured.threadId,
            captured.terminalId,
            captured.lifecycleVersion,
            captured.attachGeneration,
          ])
        )
          setError(
            cause instanceof Error ? cause.message : "HX could not accept this action. Try again.",
          );
        return false;
      } finally {
        setRetry(controllerRef.current?.getRetry() ?? null);
        busyRef.current = false;
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!target || busy || busyRef.current || !reviewState?.canOpenFile) return;
    const options = peekHelixOpen(target);
    if (options) {
      if (options.revision && !reviewState.canOpenSnapshot) {
        setError("This HX session needs an update to open historical comparisons.");
        return;
      }
      takeHelixOpen(target);
      void submit(target, "open-file", JSON.stringify(options));
    }
  }, [target, reviewState, submit, openRevision, busy]);

  const canRetry =
    target !== null &&
    retry !== null &&
    retry.action !== "ask" &&
    retry.action !== "send" &&
    retry.target.environmentId === target.environmentId &&
    retry.target.threadId === target.threadId &&
    retry.target.terminalId === target.terminalId &&
    retry.target.nonce === target.nonce;

  return {
    target,
    prReview: target !== null ? (prReviewPayload?.review ?? null) : null,
    runPrAction: async (
      captured: HelixReviewTarget,
      action: "pr-review" | "pr-comment" | "pr-suggestion" | "pr-complete",
      text?: string,
    ) => {
      const id = await submit(captured, action, text);
      if (!id || !sameTarget(captured, latest.current.target)) return null;
      const marker = latest.current.markers.findLast(
        (marker) =>
          marker.nonce === captured.nonce &&
          marker.payload.kind === "pr-review" &&
          marker.payload.requestId === id,
      );
      const payload = marker?.payload;
      if (payload?.kind !== "pr-review") {
        setError(
          "HX did not return a matching review snapshot. Refresh the review before continuing.",
        );
        return null;
      }
      return payload;
    },
    ready: target !== null && reviewState !== null,
    state: target !== null ? reviewState : null,
    canDiscover: input.enabled && input.canDiscover && input.attached,
    discover,
    busy,
    error,
    notice,
    canRetry,
    retryAction: canRetry ? (retry?.action ?? null) : null,
    retry: async () => {
      const captured = latest.current.target;
      const controller = controllerRef.current;
      if (!captured || !controller || busyRef.current) return false;
      controller.update(captured, latest.current.markers);
      const retained = controller.getRetry();
      setRetry(retained);
      if (
        !retained ||
        retained.action === "ask" ||
        retained.action === "send" ||
        retained.target.environmentId !== captured.environmentId ||
        retained.target.threadId !== captured.threadId ||
        retained.target.terminalId !== captured.terminalId ||
        retained.target.nonce !== captured.nonce
      )
        return false;
      return Boolean(await submit(captured, retained.action, retained.text));
    },
    prompt: currentPrompt,
    promptIsCurrent: currentPrompt !== null && sameTarget(currentPrompt.target, target),
    onAction: (action: HelixReviewAction) => {
      if (!target || busyRef.current || canRetry) return;
      const state = latest.current.reviewState;
      if (state === null) return;
      if (
        state?.mode === "review" &&
        ["stage", "comment", "discard-last-comment", "send"].includes(action)
      )
        return;
      if (
        (action === "stage" && state !== null && !state.canStage) ||
        (action === "mark-reviewed" && (!state?.canMarkReviewed || state.reviewed !== false)) ||
        (action === "unmark-reviewed" && (!state?.canMarkReviewed || state.reviewed !== true))
      )
        return;
      if (
        (action === "ask" && state?.canAsk === false) ||
        (action === "comment" && !state?.canComment)
      )
        return;
      setError(null);
      setNotice(null);
      if (action === "ask" || action === "send" || action === "comment") {
        setPrompt({
          id: uuidv4(),
          action,
          mode: state?.mode ?? "work",
          target,
          title: input.title,
          text: "",
        });
      } else {
        void submit(target, action);
      }
    },
    setPromptText: (text: string) =>
      setPrompt((current) => (current ? { ...current, text } : null)),
    closePrompt: () => setPrompt(null),
    submitPrompt: async () => {
      if (!currentPrompt) return;
      if (await submit(currentPrompt.target, currentPrompt.action, currentPrompt.text)) {
        setPrompt((current) => (current?.id === currentPrompt.id ? null : current));
      }
    },
  };
}
