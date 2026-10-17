import { createHelixReviewController } from "@t3tools/client-runtime/helix-review-control";
import { useEffect, useRef } from "react";

export function useHelixReviewController(newId: () => string) {
  const ref = useRef<ReturnType<typeof createHelixReviewController> | null>(null);
  useEffect(() => {
    const controller = createHelixReviewController({ newId });
    ref.current = controller;
    return () => {
      controller.dispose();
      ref.current = null;
    };
  }, [newId]);
  return ref;
}
