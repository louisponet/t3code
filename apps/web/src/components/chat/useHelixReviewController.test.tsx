import { StrictMode, useEffect } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";
import { useHelixReviewController } from "./useHelixReviewController";

const newId = () => "11111111-1111-4111-8111-111111111111";

describe("Helix controller lifecycle", () => {
  it("can acknowledge actions after StrictMode attachment replay and disposes on unmount", async () => {
    let current: ReturnType<typeof useHelixReviewController>["current"] = null;
    function Probe() {
      const ref = useHelixReviewController(newId);
      useEffect(() => {
        current = ref.current;
      });
      return null;
    }
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <StrictMode>
          <Probe />
        </StrictMode>,
      );
    });
    const controller = current as unknown as NonNullable<
      ReturnType<typeof useHelixReviewController>["current"]
    >;
    expect(controller).not.toBeNull();
    const target = {
      environmentId: "env",
      threadId: "thread",
      terminalId: "hx",
      lifecycleVersion: 1,
      attachGeneration: 1,
      nonce: "22222222-2222-4222-8222-222222222222",
    };
    controller.update(target, []);
    await expect(
      controller.send(target, "files", undefined, async () => {
        controller.update(target, [
          { nonce: target.nonce, payload: { v: 1, kind: "result", id: newId(), ok: true } },
        ]);
        return true;
      }),
    ).resolves.toBe(newId());
    await act(async () => {
      renderer!.unmount();
    });
    await expect(controller.send(target, "files", undefined, async () => true)).rejects.toThrow(
      "session changed",
    );
  });
});
