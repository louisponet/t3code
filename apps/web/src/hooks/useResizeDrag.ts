import { type PointerEvent, useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";

interface ResizeSession {
  size: number;
  // The dragged edge of the element; dragging away from its center grows it.
  edge: "left" | "right" | "top" | "bottom";
  resize: (size: number) => number;
  finish: (size: number, moved: boolean) => void;
  cleanup?: (committed: boolean) => void;
}

export function useResizeDrag<T extends HTMLElement>(
  start: (event: PointerEvent<T>) => ResizeSession | null,
  resetKey?: string,
) {
  const drag = useRef<{
    session: ResizeSession;
    target: T;
    pointerId: number;
    vertical: boolean;
    start: number;
    pending: number;
    size: number;
    moved: boolean;
    frame: number | null;
  } | null>(null);

  const flush = () => {
    const active = drag.current;
    if (!active) return;
    const { edge } = active.session;
    const delta = (active.pending - active.start) * (edge === "left" || edge === "top" ? -1 : 1);
    if (Math.abs(delta) > 2) active.moved = true;
    active.size = active.session.resize(active.session.size + delta);
  };

  const finish = (commit = true) => {
    const active = drag.current;
    if (!active) return;
    if (active.frame !== null) cancelAnimationFrame(active.frame);
    if (commit) flush();
    // Release can synchronously dispatch lostpointercapture.
    drag.current = null;
    try {
      if (active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {}
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    active.session.cleanup?.(commit);
    if (commit) active.session.finish(active.size, active.moved);
  };

  // The effects must not rerun while a drag is live: their cleanup cancels it.
  const finishDrag = useEffectEvent((commit: boolean) => finish(commit));

  const previousResetKey = useRef(resetKey);
  useLayoutEffect(() => {
    if (previousResetKey.current !== resetKey) {
      finishDrag(false);
      previousResetKey.current = resetKey;
    }
  }, [resetKey]);

  useEffect(() => {
    const onBlur = () => finishDrag(true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      finishDrag(false);
    };
  }, []);

  const end = (event: PointerEvent<T>, usePosition: boolean) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) active.pending = active.vertical ? event.clientY : event.clientX;
    finish();
  };

  return {
    refresh: flush,
    onPointerDown(event: PointerEvent<T>) {
      if (event.button !== 0 || drag.current) return;
      const session = start(event);
      if (!session) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        session.cleanup?.(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const vertical = session.edge === "top" || session.edge === "bottom";
      const position = vertical ? event.clientY : event.clientX;
      drag.current = {
        session,
        target: event.currentTarget,
        pointerId: event.pointerId,
        vertical,
        start: position,
        pending: position,
        size: session.size,
        moved: false,
        frame: null,
      };
      document.body.style.cursor = vertical ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    onPointerMove(event: PointerEvent<T>) {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      active.pending = active.vertical ? event.clientY : event.clientX;
      if (Math.abs(active.pending - active.start) > 2) active.moved = true;
      if (active.frame !== null) return;
      active.frame = requestAnimationFrame(() => {
        active.frame = null;
        flush();
      });
    },
    onPointerUp: (event: PointerEvent<T>) => end(event, true),
    onPointerCancel: (event: PointerEvent<T>) => end(event, false),
    onLostPointerCapture: (event: PointerEvent<T>) => end(event, false),
  };
}
