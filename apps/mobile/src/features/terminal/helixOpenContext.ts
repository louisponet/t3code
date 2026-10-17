import { useSyncExternalStore } from "react";
import type { HelixOpenOptions } from "@t3tools/client-runtime/helix-review";

type Target = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId: string;
};
const listeners = new Set<() => void>();
let revision = 0;
export function useHelixOpenRevision() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => revision,
  );
}
const pending = new Map<string, HelixOpenOptions>();
const key = (target: Target) =>
  JSON.stringify([target.environmentId, target.threadId, target.terminalId]);
export function stageHelixOpen(target: Target, options: HelixOpenOptions) {
  pending.set(key(target), options);
  revision++;
  listeners.forEach((listener) => listener());
}
export function peekHelixOpen(target: Target) {
  return pending.get(key(target));
}
export function takeHelixOpen(target: Target) {
  const options = pending.get(key(target));
  pending.delete(key(target));
  return options;
}
