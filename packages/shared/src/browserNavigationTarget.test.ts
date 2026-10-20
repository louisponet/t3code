import { describe, expect, it } from "vite-plus/test";

import {
  browserNavigationTargetUrl,
  browserTargetReachableFromClient,
} from "./browserNavigationTarget.ts";

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

describe("browserTargetReachableFromClient", () => {
  it("lets a client load a public URL itself", () => {
    expect(browserTargetReachableFromClient({ kind: "url", url: "overseer.example.com/ui" })).toBe(
      true,
    );
  });

  it("leaves the host's own addresses and unopenable URLs to the host", () => {
    for (const url of [
      "http://localhost:3000",
      "http://localhost.:3000",
      "http://localhost..:3000",
      "http://[::]:3000",
      "http://grafana.localhost:3000",
      "http://127.0.0.2:8080",
      "http://[::1]:3000",
      "ftp://example.com",
      "http://[",
    ]) {
      expect(browserTargetReachableFromClient({ kind: "url", url })).toBe(false);
    }
    expect(browserTargetReachableFromClient({ kind: "environment-port", port: 3000 })).toBe(false);
  });
});
