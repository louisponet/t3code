import type { BrowserNavigationTarget } from "@t3tools/contracts";

import { isLocalLoopbackHost, normalizeHostname } from "./hostClassification.ts";
import { normalizePreviewUrl } from "./preview.ts";

/** An environment-port target resolves to `localhost` on the environment host, never the client. */
export function browserNavigationTargetUrl(target: BrowserNavigationTarget): string {
  if (target.kind === "url") return target.url;
  const path = target.path ?? "";
  return `${target.protocol ?? "http"}://localhost:${target.port}${path === "" || path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Whether a client can load the target itself. Ports and loopback names mean the environment
 * host, and a URL preview can't open is left for the host's browser to report.
 */
export function browserTargetReachableFromClient(target: BrowserNavigationTarget): boolean {
  if (target.kind !== "url") return false;
  let host: string;
  try {
    host = normalizeHostname(new URL(normalizePreviewUrl(target.url)).hostname);
  } catch {
    return false;
  }
  return !(
    isLocalLoopbackHost(host) ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::"
  );
}
