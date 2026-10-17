import { StrictMode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";
import { useHelixReviewController } from "./useHelixReviewController";
import { useHelixLocationDelivery } from "./useHelixLocationDelivery";

const newId = () => "11111111-1111-4111-8111-111111111111";

describe("Helix file navigation across attachments", () => {
  it("ignores disposed and superseded requests while reporting a failure from the active attachment", async () => {
    const requests: Array<{ reject: (error: Error) => void }> = [];
    const errors: string[] = [];
    const onError = (message: string) => {
      errors.push(message);
    };
    const send = () =>
      new Promise<string>((_, reject) => {
        requests.push({ reject });
      });
    function Probe({ lifecycle }: { lifecycle: string }) {
      const controllerRef = useHelixReviewController(newId);
      useHelixLocationDelivery({
        controllerRef,
        terminalId: "switch-test",
        targetJson: '{"filePath":"a.ts"}',
        requestId: 1,
        lifecycle,
        ready: true,
        canOpenFile: true,
        canOpenSnapshot: true,
        send,
        onError,
      });
      return null;
    }
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <StrictMode>
          <Probe lifecycle="first" />
        </StrictMode>,
      );
    });
    expect(requests.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      requests[0]!.reject(new Error("The HX review session closed."));
    });
    expect(errors).toEqual([]);
    const previous = requests.at(-1)!;
    await act(async () => {
      renderer!.update(
        <StrictMode>
          <Probe lifecycle="second" />
        </StrictMode>,
      );
    });
    await act(async () => {
      previous.reject(new Error("The HX review session changed."));
    });
    expect(errors).toEqual([]);
    await act(async () => {
      requests.at(-1)!.reject(new Error("Actual navigation failure"));
    });
    expect(errors).toEqual(["Actual navigation failure"]);
    await act(async () => {
      renderer!.unmount();
    });
  });
});
