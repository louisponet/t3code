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
  /** Whether the environment can proxy web tools; older servers cannot. */
  readonly webApps: boolean;
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
  for (const { environmentId, offline, webApps, tools } of sources) {
    const decoded = decodeEnvironmentTools(tools);
    const sourceIssues: Array<EnvironmentToolIssue> = [...decoded.issues];
    for (const { id, definition } of decoded.tools) {
      if (definition.kind === "web" && !webApps) {
        sourceIssues.push({ key: id, message: "Needs a newer T3 Code" });
        continue;
      }
      const prior = previousRows.get(environmentToolRowKey(environmentId, id));
      rows.push(
        prior !== undefined &&
          prior.offline === offline &&
          Equal.equals(prior.definition, definition)
          ? prior
          : { environmentId, toolId: id, definition, offline },
      );
    }
    if (!offline && sourceIssues.length > 0) {
      const prior = previous?.issues.get(environmentId);
      issues.set(
        environmentId,
        prior !== undefined && Equal.equals(prior, sourceIssues) ? prior : sourceIssues,
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
