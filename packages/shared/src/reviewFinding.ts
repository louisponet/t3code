import type {
  OrchestrationV2ReviewFindingContent,
  OrchestrationV2ReviewFindingSeverity,
} from "@t3tools/contracts";

export const REVIEW_FINDING_SEVERITY_LABELS: Record<OrchestrationV2ReviewFindingSeverity, string> =
  {
    critical: "Critical",
    major: "Major",
    minor: "Minor",
    nit: "Nit",
  };

export function reviewFindingLocation(
  finding: Pick<OrchestrationV2ReviewFindingContent, "path" | "line" | "endLine">,
): string | null {
  if (finding.path === undefined) return null;
  if (finding.line === undefined) return finding.path;
  return finding.endLine === undefined || finding.endLine <= finding.line
    ? `${finding.path}:${finding.line}`
    : `${finding.path}:${finding.line}-${finding.endLine}`;
}
