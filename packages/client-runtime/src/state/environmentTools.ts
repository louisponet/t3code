import {
  isUnknownUnionMember,
  type EnvironmentId,
  type EnvironmentToolId,
  type EnvironmentToolStatus,
  type EnvironmentToolStatusEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export type EnvironmentToolStatuses = ReadonlyMap<EnvironmentToolId, EnvironmentToolStatus>;

const EMPTY_STATUSES: EnvironmentToolStatuses = new Map();

/**
 * Returns `current` itself, and keeps each unchanged status, when an event changes nothing. A
 * status this build cannot read leaves its tool out, like a removed probe.
 */
export function applyEnvironmentToolStatusEvent(
  current: EnvironmentToolStatuses,
  event: EnvironmentToolStatusEvent,
): EnvironmentToolStatuses {
  if (isUnknownUnionMember(event)) return current;
  if (event.type === "snapshot") {
    const next = new Map<EnvironmentToolId, EnvironmentToolStatus>();
    for (const toolId of Object.keys(event.statuses) as EnvironmentToolId[]) {
      const status = event.statuses[toolId];
      if (status === undefined || isUnknownUnionMember(status)) continue;
      const previous = current.get(toolId);
      next.set(
        toolId,
        previous !== undefined && Equal.equals(previous, status) ? previous : status,
      );
    }
    return next.size === current.size &&
      [...next].every(([toolId, status]) => current.get(toolId) === status)
      ? current
      : next;
  }
  const previous = current.get(event.toolId);
  if (event.status === null || isUnknownUnionMember(event.status)) {
    if (previous === undefined) return current;
    const next = new Map(current);
    next.delete(event.toolId);
    return next;
  }
  if (previous !== undefined && Equal.equals(previous, event.status)) return current;
  return new Map(current).set(event.toolId, event.status);
}

export function createEnvironmentToolsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly toolId: string };
    }) => JSON.stringify([environmentId, input.toolId]),
  };
  // Folded inside the stream: a subscription atom keeps only the last value of each chunk, so a
  // fold over the atom would drop events.
  const statusEvents = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:environment-tools:status",
    tag: WS_METHODS.subscribeEnvironmentToolStatus,
    transform: (stream) =>
      stream.pipe(Stream.scan(() => EMPTY_STATUSES, applyEnvironmentToolStatusEvent)),
  });
  const statuses = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(statusEvents({ environmentId, input: {} }))),
        () => EMPTY_STATUSES,
      ),
    ).pipe(Atom.withLabel(`environment-data:environment-tools:statuses:${environmentId}`)),
  );
  return {
    statusEvents,
    statuses,
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:environment-tools:open",
      tag: WS_METHODS.environmentToolsOpen,
      scheduler,
      concurrency,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:environment-tools:stop",
      tag: WS_METHODS.environmentToolsStop,
      scheduler,
      concurrency,
    }),
    refreshStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:environment-tools:refresh-status",
      tag: WS_METHODS.environmentToolsRefreshStatus,
    }),
  };
}
