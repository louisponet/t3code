import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentToolsAtoms } from "@t3tools/client-runtime/state/environmentTools";
import type { EnvironmentId, EnvironmentToolId, EnvironmentToolStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  buildEnvironmentToolRows,
  type EnvironmentToolRow,
  type EnvironmentToolRows,
  type EnvironmentToolsSource,
} from "./environmentTools.logic";
import { environmentPresentations, environmentSummaries } from "./presentation";

export type { EnvironmentToolRow, EnvironmentToolRows } from "./environmentTools.logic";

export const environmentToolsEnvironment = createEnvironmentToolsAtoms(connectionAtomRuntime);

/** Enabled environments that advertise tools, including offline ones whose settings are cached. */
export const environmentToolRowsAtom = Atom.make((get): EnvironmentToolRows => {
  const sources: Array<EnvironmentToolsSource> = [];
  for (const environment of get(environmentSummaries.environmentsAtom)) {
    if (!environment.isEnabled) continue;
    const serverConfig = get(
      environmentPresentations.presentationAtom(environment.environmentId),
    )?.serverConfig;
    if (serverConfig?.environment.capabilities.environmentTools !== true) continue;
    sources.push({
      environmentId: environment.environmentId,
      offline: environment.connectionState !== "connected",
      tools: serverConfig.settings.tools,
    });
  }
  return buildEnvironmentToolRows(Option.getOrNull(get.self<EnvironmentToolRows>()), sources);
}).pipe(Atom.withLabel("environment-tool-rows"));

/** Connected environments that can define tools, in catalog order. */
export const environmentToolsEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.connectedEnvironmentIdsAtom).filter(
    (environmentId) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.environmentTools === true,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((id, index) => id === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("environment-tools-environment-ids"));

export function useEnvironmentToolsEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(environmentToolsEnvironmentIdsAtom);
}

const environmentToolRowAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((toolId: EnvironmentToolId) =>
    Atom.make(
      (get) =>
        get(environmentToolRowsAtom).rows.find(
          (row) => row.environmentId === environmentId && row.toolId === toolId,
        ) ?? null,
    ).pipe(Atom.withLabel(`environment-tool:${environmentId}:${toolId}`)),
  ),
);

/**
 * The tool as its own environment defines it, never a same-id tool from another environment.
 * While that environment is not connected the row is `offline` and holds its last known
 * definition. Null when the environment lacks tools support or does not define the tool.
 */
export function useEnvironmentToolRow(
  environmentId: EnvironmentId,
  toolId: EnvironmentToolId,
): EnvironmentToolRow | null {
  return useAtomValue(environmentToolRowAtom(environmentId)(toolId));
}

const environmentToolStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((toolId: EnvironmentToolId) =>
    Atom.make((get) => get(environmentToolsEnvironment.statuses(environmentId)).get(toolId)).pipe(
      Atom.withLabel(`environment-tool-status:${environmentId}:${toolId}`),
    ),
  ),
);

/**
 * Subscribes to the environment's status stream, so call it only for an environment that
 * advertises tools. Re-renders only when this tool's status changes.
 */
export function useEnvironmentToolStatus(
  environmentId: EnvironmentId,
  toolId: EnvironmentToolId,
): EnvironmentToolStatus | undefined {
  return useAtomValue(environmentToolStatusAtom(environmentId)(toolId));
}
