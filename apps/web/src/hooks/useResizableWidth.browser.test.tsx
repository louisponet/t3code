import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "./useResizableWidth";

function Panel({
  edge = "left",
  maxWidth = 800,
  storageKey = "test-panel-width",
  defaultWidth = 400,
}: {
  edge?: "left" | "right";
  maxWidth?: number;
  storageKey?: string;
  defaultWidth?: number;
}) {
  const { width, handlers } = useResizableWidth({
    storageKey,
    defaultWidth,
    minWidth: 200,
    maxWidth,
    edge,
  });
  return (
    <aside data-testid="host">
      <output>{width}</output>
      <div data-testid="handle" {...handlers} />
    </aside>
  );
}

async function renderPanel() {
  await using stack = new AsyncDisposableStack();
  let captured = false;
  let frame: FrameRequestCallback | undefined;
  const cancelAnimationFrame = vi.fn();
  stack.use(
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 42;
    }),
  );
  stack.use(vi.spyOn(window, "cancelAnimationFrame").mockImplementation(cancelAnimationFrame));
  const setItem = stack.use(vi.spyOn(Storage.prototype, "setItem"));
  localStorage.clear();
  stack.defer(() => localStorage.clear());
  let screen: Screen = stack.use(await render(<Panel />));
  const container = () => screen.container;
  const host = () => container().querySelector<HTMLElement>("[data-testid=host]")!;

  function handle() {
    const element = container().querySelector<HTMLElement>("[data-testid=handle]")!;
    // Synthetic pointers have no active pointer for the browser to capture.
    element.setPointerCapture = () => {
      captured = true;
    };
    element.hasPointerCapture = () => captured;
    element.releasePointerCapture = () => {
      captured = false;
    };
    return element;
  }

  const environment = stack.move();
  return {
    setItem,
    cancelAnimationFrame,
    get captured() {
      return captured;
    },
    frame: () => frame?.(0),
    host,
    shownWidth: () => Number(container().querySelector("output")!.textContent),
    liveWidth: () => host().style.getPropertyValue(RESIZABLE_WIDTH_PROPERTY),
    pointer(
      type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "lostpointercapture",
      clientX = 100,
    ) {
      handle().dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          clientX,
        }),
      );
    },
    rerender: (element: ReactNode = <Panel />) => screen.rerender(element),
    unmount: () => screen.unmount(),
    async mountFresh(element: ReactNode = <Panel />) {
      screen = environment.use(await render(element));
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("panel width default", () => {
  it("follows the default until a width is saved", async () => {
    await using panel = await renderPanel();
    const { pointer, shownWidth } = panel;
    await panel.rerender(<Panel defaultWidth={500} />);
    expect(shownWidth()).toBe(500);
    await act(() => {
      pointer("pointerdown");
      pointer("pointerup", 50);
    });
    expect(shownWidth()).toBe(550);
    await panel.rerender(<Panel defaultWidth={300} />);
    expect(shownWidth()).toBe(550);
  });
});
