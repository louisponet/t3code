import type {
  EnvironmentId,
  EnvironmentToolDefinition,
  EnvironmentToolId,
} from "@t3tools/contracts";
import {
  decodeEnvironmentTools,
  type EnvironmentToolIssue,
} from "@t3tools/shared/environmentTools";
import * as Equal from "effect/Equal";

export interface EnvironmentToolRow {
  readonly environmentId: EnvironmentId;
  readonly toolId: EnvironmentToolId;
  readonly definition: EnvironmentToolDefinition;
  /** From the last settings an enabled environment sent before it disconnected. */
  readonly offline: boolean;
}

export interface EnvironmentToolRows {
  /** Environments in catalog order, each environment's tools in file order. */
  readonly rows: ReadonlyArray<EnvironmentToolRow>;
  /** Only connected environments with entries that did not decode. */
  readonly issues: ReadonlyMap<EnvironmentId, ReadonlyArray<EnvironmentToolIssue>>;
}

export interface EnvironmentToolsSource {
  readonly environmentId: EnvironmentId;
  readonly offline: boolean;
  readonly tools: Readonly<Record<string, unknown>>;
}

export const environmentToolRowKey = (environmentId: string, toolId: string) =>
  `${environmentId}\n${toolId}`;

/**
 * Every settings push decodes into new objects, so unchanged rows and issue lists keep their
 * previous identity here; otherwise any settings write would re-render every tool consumer.
 */
export function buildEnvironmentToolRows(
  previous: EnvironmentToolRows | null,
  sources: ReadonlyArray<EnvironmentToolsSource>,
): EnvironmentToolRows {
  const previousRows = new Map(
    previous?.rows.map((row) => [environmentToolRowKey(row.environmentId, row.toolId), row]),
  );
  const rows: Array<EnvironmentToolRow> = [];
  const issues = new Map<EnvironmentId, ReadonlyArray<EnvironmentToolIssue>>();
  for (const { environmentId, offline, tools } of sources) {
    const decoded = decodeEnvironmentTools(tools);
    for (const { id, definition } of decoded.tools) {
      const prior = previousRows.get(environmentToolRowKey(environmentId, id));
      rows.push(
        prior !== undefined &&
          prior.offline === offline &&
          Equal.equals(prior.definition, definition)
          ? prior
          : { environmentId, toolId: id, definition, offline },
      );
    }
    if (!offline && decoded.issues.length > 0) {
      const prior = previous?.issues.get(environmentId);
      issues.set(
        environmentId,
        prior !== undefined && Equal.equals(prior, decoded.issues) ? prior : decoded.issues,
      );
    }
  }
  if (previous === null) return { rows, issues };
  const sameRows =
    previous.rows.length === rows.length &&
    rows.every((row, index) => row === previous.rows[index]);
  const sameIssues =
    previous.issues.size === issues.size &&
    [...issues].every(([environmentId, list]) => previous.issues.get(environmentId) === list);
  if (sameRows && sameIssues) return previous;
  return { rows: sameRows ? previous.rows : rows, issues: sameIssues ? previous.issues : issues };
}
