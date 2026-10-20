import type { BrowserNavigationTarget } from "@t3tools/contracts";

/** An environment-port target resolves to `localhost` on the environment host, never the client. */
export function browserNavigationTargetUrl(target: BrowserNavigationTarget): string {
  if (target.kind === "url") return target.url;
  const path = target.path ?? "";
  return `${target.protocol ?? "http"}://localhost:${target.port}${path === "" || path.startsWith("/") ? path : `/${path}`}`;
}
