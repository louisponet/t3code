import { type RefObject, useLayoutEffect, useState } from "react";

import { type ResizableWidthHandlers, useResizableWidth } from "./useResizableWidth";
import { observeResize } from "../lib/observeResize";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
}

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
/**
 * Floor for the column beside the panel: below this the chat column's
 * composer overflows, so the panel yields instead.
 */
const SIBLING_COLUMN_MIN_WIDTH = 360;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;

export function usePreviewPanelInlineSize(
  hostRef?: RefObject<HTMLElement | null>,
  options: {
    readonly enabled?: boolean | undefined;
    readonly widthStorageKey?: string | undefined;
    /** `"half"` splits the measured row evenly with the column beside the panel. */
    readonly defaultWidth?: number | "half" | undefined;
    readonly container?: HTMLElement | null | undefined;
    /** Remeasures the half default each time the panel opens. */
    readonly open?: boolean | undefined;
  } = {},
): PreviewPanelInlineSize {
  const half = options.defaultWidth === "half";
  // Half the row is only measured while no width is stored and the default can apply.
  const [trackHalfRowWidth, setTrackHalfRowWidth] = useState(false);
  const { maxWidth, halfRowWidth } = useViewportClampedMaxWidth(
    hostRef,
    options.enabled ?? true,
    options.container,
    trackHalfRowWidth && options.open !== false,
  );
  const { width, handlers, hasStoredWidth } = useResizableWidth({
    storageKey: options.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: half
      ? (halfRowWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH)
      : (options.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH),
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
  if (trackHalfRowWidth !== (half && !hasStoredWidth))
    setTrackHalfRowWidth(half && !hasStoredWidth);
  return { width, handlers };
}

function useViewportClampedMaxWidth(
  hostRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
  container: HTMLElement | null | undefined,
  trackHalfRowWidth: boolean,
): { maxWidth: number; halfRowWidth: number | null } {
  const [maxWidth, setMaxWidth] = useState(() =>
    getPreviewPanelMaxWidth(typeof window === "undefined" ? 1280 : window.innerWidth),
  );
  const [halfRowWidth, setHalfRowWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const row = container ?? (enabled ? hostRef?.current?.parentElement : null) ?? null;
    // Measure before first paint: the persisted width must be clamped against
    // the row on the initial render, not one observer tick later (the panel
    // would flash over-wide on every mount). Only derived values are stored, so a
    // row resize that leaves them unchanged skips re-rendering the panel's owner.
    const measure = () => {
      setMaxWidth(getPreviewPanelMaxWidth(window.innerWidth, row?.clientWidth));
    };
    measure();
    // Taken once when the default starts applying, not per resize: the row resizes every frame
    // of a sidebar drag, and the cap above already keeps the panel inside it.
    if (trackHalfRowWidth && row) setHalfRowWidth(Math.floor(row.clientWidth / 2));
    let frame = 0;
    const onResize = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", onResize);
    const stopObserving = row ? observeResize(row, measure) : undefined;
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      stopObserving?.();
    };
  }, [container, hostRef, enabled, trackHalfRowWidth]);
  return { maxWidth, halfRowWidth };
}
function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Never below the panel's own minimum: when the row cannot fit both
  // columns' minimums the sibling yields, and useResizableWidth's clamp must
  // not see max < min (it would resolve the inversion to min and, via
  // drag-end persistence, overwrite the user's stored width).
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}
