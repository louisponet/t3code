import type { ScopedThreadRef } from "@t3tools/contracts";

export {
  findOpenHelixReviewTerminal,
  helixReviewCommand,
  newHelixReviewTerminalId,
} from "@t3tools/client-runtime/helix-review";

const HELIX_REVIEW_EVENT = "t3:helix-review-open";

export function requestHelixReview(threadRef: ScopedThreadRef): void {
  window.dispatchEvent(new CustomEvent(HELIX_REVIEW_EVENT, { detail: threadRef }));
}

export function subscribeHelixReview(listener: (threadRef: ScopedThreadRef) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ScopedThreadRef>).detail);
  window.addEventListener(HELIX_REVIEW_EVENT, handler);
  return () => window.removeEventListener(HELIX_REVIEW_EVENT, handler);
}
