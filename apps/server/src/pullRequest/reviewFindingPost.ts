import type {
  OrchestrationV2ReviewFindingContent,
  PullRequestReviewPosition,
} from "@t3tools/contracts";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import {
  REVIEW_FINDING_SEVERITY_LABELS,
  reviewFindingLocation,
} from "@t3tools/shared/reviewFinding";

type FindingText = Pick<OrchestrationV2ReviewFindingContent, "severity" | "title" | "body">;
type FindingLocation = Pick<OrchestrationV2ReviewFindingContent, "path" | "line" | "endLine">;

/** Markdown keeps its leading whitespace: indentation can open a code block. */
export function reviewFindingCommentBody(finding: FindingText): string {
  const heading =
    finding.severity === undefined
      ? `**${finding.title}**`
      : `**${REVIEW_FINDING_SEVERITY_LABELS[finding.severity]}: ${finding.title}**`;
  const body = finding.body.trimEnd();
  return body === "" ? heading : `${heading}\n\n${body}`;
}

/** A conversation comment has no anchor, so it names the line, and the commit when it moved on. */
export function reviewFindingConversationBody(
  finding: FindingText & FindingLocation & { readonly headSha: string | null },
  currentHeadSha: string | null,
): string {
  const body = reviewFindingCommentBody(finding);
  const location = reviewFindingLocation(finding);
  if (location === null) return body;
  const at =
    finding.headSha !== null && finding.headSha !== currentHeadSha
      ? ` at ${finding.headSha.slice(0, 7)}`
      : "";
  return `\`${location}\`${at}\n\n${body}`;
}

export function reviewFindingAgentMessage(
  finding: FindingLocation & { readonly findingId: string; readonly title: string },
  text: string,
): string {
  const location = reviewFindingLocation(finding);
  const where = location === null ? "" : ` (\`${location}\`)`;
  return `**Re: finding ${finding.findingId}** — ${finding.title}${where}\n\n${text}`;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface NewSideLine {
  readonly position: PullRequestReviewPosition;
  readonly hunk: number;
}

function headerPath(token: string, prefix: "a/" | "b/"): string | null {
  // git ends a name containing a space with a tab, and quotes a name with special characters.
  const name = token.endsWith("\t") ? token.slice(0, -1) : token;
  const unquoted = name.startsWith('"') ? unquoteGitPatchPath(name) : name;
  return unquoted.startsWith(prefix) ? unquoted.slice(2) : null;
}

interface FileSection {
  readonly lines: Map<number, NewSideLine>;
  /** The file's name before a rename; GitLab places a comment by both names. */
  readonly oldPath: string | null;
}

/** Every new-side line of `path` in a multi-file patch; null when the patch has no such file. */
function fileSection(patch: string, path: string): FileSection | null {
  let section: FileSection | null = null;
  let oldPath: string | null = null;
  // Inside a file's hunks a `--- ` or `+++ ` line is a source line, not a header.
  let inHunks = false;
  let hunk = 0;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (section !== null) break;
      inHunks = false;
      oldPath = null;
      continue;
    }
    if (!inHunks && line.startsWith("--- ")) {
      oldPath = headerPath(line.slice(4), "a/");
      continue;
    }
    if (!inHunks && line.startsWith("+++ ")) {
      if (headerPath(line.slice(4), "b/") === path) section = { lines: new Map(), oldPath };
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      inHunks = true;
      hunk += 1;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!inHunks || section === null) continue;
    const lines = section.lines;
    if (line.startsWith("+")) {
      lines.set(newLine, { position: { kind: "added", newLine }, hunk });
      newLine += 1;
    } else if (line.startsWith("-")) {
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      lines.set(newLine, { position: { kind: "context", oldLine, newLine, side: "right" }, hunk });
      oldLine += 1;
      newLine += 1;
    }
  }
  return section;
}

export function patchHasFile(patch: string, path: string): boolean {
  return fileSection(patch, path) !== null;
}

export interface ReviewFindingAnchor {
  readonly position: PullRequestReviewPosition;
  /** First line of a range; `position` is then its last line. */
  readonly startLine?: number;
  /** Set only when the file was renamed. */
  readonly oldPath?: string;
}

/**
 * Anchors a finding's new-side line in the pull request's patch, or null when the line is not in
 * the diff. A range keeps its first line only when both ends sit in one hunk, which is all a host
 * accepts for a multi-line comment.
 */
export function reviewFindingPosition(
  patch: string,
  path: string,
  line: number,
  endLine?: number,
): ReviewFindingAnchor | null {
  const section = fileSection(patch, path);
  const start = section?.lines.get(line);
  if (section === null || start === undefined) return null;
  const renamed = section.oldPath !== null && section.oldPath !== path ? section.oldPath : null;
  const end = endLine !== undefined && endLine > line ? section.lines.get(endLine) : undefined;
  return {
    ...(end === undefined || end.hunk !== start.hunk
      ? { position: start.position }
      : { position: end.position, startLine: line }),
    ...(renamed === null ? {} : { oldPath: renamed }),
  };
}
