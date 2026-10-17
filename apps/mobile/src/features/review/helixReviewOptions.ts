import type { HelixOpenOptions } from "@t3tools/client-runtime/helix-review";

export function helixSourceReviewOptions(source: {
  readonly kind: "working-tree" | "branch-range";
  readonly helixBaseline?: string;
}): HelixOpenOptions | null {
  if (source.kind === "working-tree") return { baseline: "HEAD" };
  // The display branch can be ahead of this checkout. Only the server's
  // resolved merge base reproduces Changes, including uncommitted edits.
  return source.helixBaseline ? { baseline: source.helixBaseline } : null;
}
