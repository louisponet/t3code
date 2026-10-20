import type { EnvironmentId, EnvironmentToolStatus, EnvironmentToolTone } from "@t3tools/contracts";

import type { EnvironmentToolRow } from "../../state/environmentTools.logic";

export interface SidebarToolGroup {
  readonly environmentId: EnvironmentId;
  /** Null when every tool belongs to one environment, so no heading is needed. */
  readonly label: string | null;
  readonly rows: ReadonlyArray<EnvironmentToolRow>;
}

export function groupSidebarTools(
  rows: ReadonlyArray<EnvironmentToolRow>,
  labelById: ReadonlyMap<EnvironmentId, string>,
): ReadonlyArray<SidebarToolGroup> {
  const groups: Array<{ environmentId: EnvironmentId; rows: Array<EnvironmentToolRow> }> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last?.environmentId === row.environmentId) last.rows.push(row);
    else groups.push({ environmentId: row.environmentId, rows: [row] });
  }
  const labelled = groups.length > 1;
  return groups.map((group) => ({
    ...group,
    label: labelled ? (labelById.get(group.environmentId) ?? group.environmentId) : null,
  }));
}

const TONE_SEVERITY: Record<EnvironmentToolTone, number> = {
  good: 0,
  muted: 1,
  info: 2,
  warn: 3,
  alert: 4,
};

/** The most severe tone that is not good; an unavailable probe counts as muted. */
export function worstToolTone(
  statuses: Iterable<EnvironmentToolStatus | undefined>,
): EnvironmentToolTone | null {
  let worst: EnvironmentToolTone | null = null;
  for (const status of statuses) {
    const tone =
      status?.state === "ready"
        ? status.badge.tone
        : status?.state === "unavailable"
          ? "muted"
          : null;
    if (tone !== null && TONE_SEVERITY[tone] > TONE_SEVERITY[worst ?? "good"]) worst = tone;
  }
  return worst;
}
