import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import {
  injectToolAppBootstrap,
  isToolAppEscapeMessage,
  TOOL_APP_ESCAPE_MESSAGE_TYPE,
} from "./toolApp.ts";

describe("tool app keyboard bootstrap", () => {
  it("preserves the doctype and installs before the app's own scripts", () => {
    const html =
      '<!doctype html><html><head><script src="app.js"></script></head><body></body></html>';
    const injected = injectToolAppBootstrap(html);
    expect(injected.startsWith("<!doctype html><html><head><script>")).toBe(true);
    expect(injected.indexOf("window.addEventListener")).toBeLessThan(
      injected.indexOf('src="app.js"'),
    );
    expect(injected.endsWith('<script src="app.js"></script></head><body></body></html>')).toBe(
      true,
    );
  });

  it("leaves app keys alone and consumes the palette shortcut across keyboard layouts", () => {
    const posted: Array<unknown> = [];
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const script = injectToolAppBootstrap("").match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (script === undefined) throw new Error("Missing keyboard bootstrap");
    NodeVM.runInNewContext(script, {
      window: {
        addEventListener: (type: string, handle: typeof listener, capture: boolean) => {
          expect(type).toBe("keydown");
          expect(capture).toBe(true);
          listener = handle;
        },
        parent: { postMessage: (message: unknown) => posted.push(message) },
      },
    });
    if (listener === undefined) throw new Error("Missing keyboard listener");
    let consumed = 0;
    const event = {
      key: "k",
      code: "KeyK",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => consumed++,
      stopImmediatePropagation: () => consumed++,
    };
    listener(event);
    listener({ ...event, ctrlKey: true });
    listener({ ...event, ctrlKey: true, shiftKey: true, altKey: true });
    expect(consumed).toBe(0);
    expect(posted).toEqual([]);
    listener({ ...event, ctrlKey: true, shiftKey: true });
    listener({ ...event, metaKey: true, shiftKey: true, key: "л" });
    expect(consumed).toBe(4);
    expect(posted).toEqual([
      { type: TOOL_APP_ESCAPE_MESSAGE_TYPE },
      { type: TOOL_APP_ESCAPE_MESSAGE_TYPE },
    ]);
    expect(posted.every(isToolAppEscapeMessage)).toBe(true);
    expect([null, "escape", { type: "other" }].some(isToolAppEscapeMessage)).toBe(false);
  });
});
