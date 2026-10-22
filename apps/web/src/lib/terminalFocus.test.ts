import { afterEach, describe, expect, it } from "vite-plus/test";

import { getTerminalFocusOwner, isTerminalFocused } from "./terminalFocus";

class MockHTMLElement {
  isConnected = false;
  className = "";
  terminalOwner: string | null = null;
  readonly dataset: { terminalOwner?: string } = {};

  readonly classList = {
    contains: (value: string) => this.className.split(/\s+/).includes(value),
  };

  closest(selector: string): MockHTMLElement | null {
    if (!this.isConnected) {
      return null;
    }
    if (selector === "[data-terminal-owner]" && this.terminalOwner !== null) {
      return this;
    }
    return null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }

  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

describe("isTerminalFocused", () => {
  it("returns the tool owner, which still counts as terminal focus", () => {
    const toolInput = new MockHTMLElement();
    toolInput.isConnected = true;
    toolInput.terminalOwner = "tool";
    toolInput.dataset.terminalOwner = "tool";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: toolInput } as unknown as Document;

    expect(getTerminalFocusOwner()).toBe("tool");
    expect(isTerminalFocused()).toBe(true);
  });

  it("has no owner without a document", () => {
    delete (globalThis as { document?: Document }).document;

    expect(getTerminalFocusOwner()).toBeNull();
  });
});
