import { describe, expect, it } from "vite-plus/test";

import { browserNavigationTargetUrl } from "./browserNavigationTarget.ts";

describe("browserNavigationTargetUrl", () => {
  it("returns a url target as given", () => {
    expect(
      browserNavigationTargetUrl({ kind: "url", url: "https://grafana.example.com/d/1" }),
    ).toBe("https://grafana.example.com/d/1");
  });

  it("resolves an environment port to localhost on the host", () => {
    expect(browserNavigationTargetUrl({ kind: "environment-port", port: 3000 })).toBe(
      "http://localhost:3000",
    );
    expect(
      browserNavigationTargetUrl({
        kind: "environment-port",
        port: 8443,
        protocol: "https",
        path: "settings?tab=account",
      }),
    ).toBe("https://localhost:8443/settings?tab=account");
    expect(browserNavigationTargetUrl({ kind: "environment-port", port: 5173, path: "/a" })).toBe(
      "http://localhost:5173/a",
    );
  });
});
