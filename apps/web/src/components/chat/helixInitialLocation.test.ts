import { describe, expect, it } from "vite-plus/test";
import { rememberHelixInitialLocation, takeHelixInitialLocation } from "./helixInitialLocation";

describe("initial Helix location ownership", () => {
  it("lets only the first attachment rely on launch navigation", () => {
    rememberHelixInitialLocation("terminal-a", '{"filePath":"a.ts"}');
    expect(takeHelixInitialLocation("terminal-a")).toBe('{"filePath":"a.ts"}');
    expect(takeHelixInitialLocation("terminal-a")).toBeUndefined();
  });
  it("keeps concurrent editors separate and requires retargeting an existing editor", () => {
    rememberHelixInitialLocation("terminal-b", '{"filePath":"b.ts"}');
    expect(takeHelixInitialLocation("reconnected-editor")).toBeUndefined();
    expect(takeHelixInitialLocation("terminal-b")).toBe('{"filePath":"b.ts"}');
  });
});
