import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  nonce: "22222222-2222-4222-8222-222222222222",
  state: {
    nonce: "22222222-2222-4222-8222-222222222222",
    canOpenFile: true,
    canStage: false,
    canMarkReviewed: false,
    reviewed: null,
    reviewedCount: 0,
    totalCount: 0,
  },
  send: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "33333333-3333-4333-8333-333333333333" }));
vi.mock("@t3tools/client-runtime/helix-review-control", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/helix-review-control")>()),
  resolveHelixReviewReadyNonce: () => fixture.nonce,
  resolveHelixReviewState: () => fixture.state,
  createHelixReviewController: () => ({
    update: vi.fn(),
    getRetry: () => null,
    dispose: vi.fn(),
    send: fixture.send,
  }),
}));

import { useHelixReviewControls } from "./useHelixReviewControls";
import { stageHelixOpen, takeHelixOpen } from "./helixOpenContext";

describe("pending mobile HX navigation", () => {
  it("opens the queued file after an unrelated action finishes without a state marker change", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let finish!: (id: string) => void;
    fixture.send.mockReset();
    fixture.send.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    fixture.send.mockResolvedValue("open-request");
    let controls!: ReturnType<typeof useHelixReviewControls>;
    const input = {
      environmentId: "busy-env",
      threadId: "busy-thread",
      terminalId: "helix-review-busy",
      lifecycleVersion: 1,
      attachGeneration: 1,
      attached: true,
      canDiscover: false,
      buffer: "",
      enabled: true,
      title: "Busy thread",
      write: async () => true,
    };
    function Probe() {
      const currentControls = useHelixReviewControls(input);
      useLayoutEffect(() => {
        controls = currentControls;
      }, [currentControls]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Probe />));
      await act(async () => controls.onAction("next"));
      expect(controls.busy).toBe(true);
      await act(async () =>
        stageHelixOpen(
          {
            environmentId: input.environmentId,
            threadId: input.threadId,
            terminalId: input.terminalId,
          },
          { filePath: "queued.ts", line: 7 },
        ),
      );
      expect(fixture.send).toHaveBeenCalledTimes(1);
      await act(async () => finish("next-request"));
      expect(fixture.send).toHaveBeenCalledTimes(2);
      expect(fixture.send.mock.calls[1]?.[1]).toBe("open-file");
      expect(JSON.parse(fixture.send.mock.calls[1]?.[2])).toEqual({
        filePath: "queued.ts",
        line: 7,
      });
    } finally {
      await act(async () => root.unmount());
      takeHelixOpen({
        environmentId: input.environmentId,
        threadId: input.threadId,
        terminalId: input.terminalId,
      });
    }
  });
});
