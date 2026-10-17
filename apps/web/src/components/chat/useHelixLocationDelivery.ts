import { useEffect, useRef, type RefObject } from "react";
import { takeHelixInitialLocation } from "./helixInitialLocation";
import type { useHelixReviewController } from "./useHelixReviewController";

type Controller = ReturnType<typeof useHelixReviewController>["current"];
type Delivery = { json: string; requestId: number; lifecycle: string; controller: Controller };

export function useHelixLocationDelivery({
  controllerRef,
  terminalId,
  targetJson,
  requestId,
  lifecycle,
  ready,
  canOpenFile,
  canOpenSnapshot,
  send,
  onError,
}: {
  controllerRef: RefObject<Controller>;
  terminalId: string;
  targetJson: string;
  requestId: number;
  lifecycle: string;
  ready: boolean;
  canOpenFile: boolean | undefined;
  canOpenSnapshot: boolean | undefined;
  send: (action: "open-file", text: string) => Promise<string>;
  onError: (error: string) => void;
}) {
  const delivered = useRef<Delivery | null>(null);
  const checkedInitialLocation = useRef(false);
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !ready) return;
    const previous = delivered.current;
    if (
      previous?.json === targetJson &&
      previous.requestId === requestId &&
      previous.lifecycle === lifecycle &&
      previous.controller === controller
    )
      return;
    const delivery = { json: targetJson, requestId, lifecycle, controller };
    if (!checkedInitialLocation.current) {
      checkedInitialLocation.current = true;
      if (takeHelixInitialLocation(terminalId) === targetJson) {
        delivered.current = delivery;
        return;
      }
    }
    if (canOpenFile !== true || (JSON.parse(targetJson).revision && canOpenSnapshot !== true)) {
      onError(
        "Update the Helix T3 integration on this environment to open files and review contexts in the current editor.",
      );
      return;
    }
    delivered.current = delivery;
    void send("open-file", targetJson).catch((failure) => {
      // StrictMode can dispose an attachment while its request is in flight.
      // Its rejection belongs to that attachment, never the replacement pane.
      if (controllerRef.current !== controller || delivered.current !== delivery) return;
      delivered.current = null;
      onError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [
    controllerRef,
    terminalId,
    targetJson,
    requestId,
    lifecycle,
    ready,
    canOpenFile,
    canOpenSnapshot,
    send,
    onError,
  ]);
}
