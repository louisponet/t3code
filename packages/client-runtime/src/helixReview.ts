const HELIX_REVIEW_TERMINAL_PREFIX = "helix-review";

export function isHelixReviewTerminal(terminalId: string): boolean {
  return (
    terminalId === HELIX_REVIEW_TERMINAL_PREFIX ||
    terminalId.startsWith(`${HELIX_REVIEW_TERMINAL_PREFIX}-`)
  );
}

export function findOpenHelixReviewTerminal(
  sessions: ReadonlyArray<{
    readonly target: { readonly terminalId: string };
    readonly state: { readonly status: string };
  }>,
  visibleTerminalIds?: readonly string[],
): string | null {
  return (
    sessions.find(
      ({ target, state }) =>
        isHelixReviewTerminal(target.terminalId) &&
        state.status === "running" &&
        (visibleTerminalIds === undefined || visibleTerminalIds.includes(target.terminalId)),
    )?.target.terminalId ?? null
  );
}

export function newHelixReviewTerminalId(uniqueSuffix: string): string {
  // An old viewport's delayed close must never target a newly opened review.
  return `${HELIX_REVIEW_TERMINAL_PREFIX}-${uniqueSuffix}`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface HelixOpenOptions {
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly side?: "old" | "new";
  readonly baseline?: string;
  readonly revision?: string;
  readonly ignoreWhitespace?: boolean;
  readonly filePaths?: readonly string[];
  readonly worktreePath?: string;
}

export function helixReviewCommand(
  threadId: string,
  environmentId: string,
  options: HelixOpenOptions = {},
): string {
  if (
    !threadId ||
    !environmentId ||
    [...threadId, ...environmentId].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error("The thread ID cannot be passed to a terminal.");
  }
  for (const key of ["filePath", "baseline", "revision", "worktreePath"] as const) {
    const value = options[key];
    if (value !== undefined) {
      if (
        !value ||
        [...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error("Invalid HX location.");
    }
  }
  for (const key of ["line", "column"] as const) {
    const value = options[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || !options.filePath)
        throw new Error("Invalid HX location.");
    }
  }
  const locationArgs = Object.keys(options).length
    ? ` --location ${quoteShell(JSON.stringify(options))}`
    : "";
  const guidance =
    "Install the Helix T3 review integration on this machine, then run hx-t3 setup. " +
    "From the Helix checkout: node contrib/t3-helix-review/cli.ts install";
  // Replacing the shell makes HX exit observable, so another click can reopen it.
  return `exec sh -c ${quoteShell(`if command -v hx-t3 >/dev/null 2>&1; then hx-t3 --thread ${quoteShell(threadId)} --environment-id ${quoteShell(environmentId)}${locationArgs}; result=$?; else printf '%s\\n' ${quoteShell(guidance)}; result=127; fi; if [ "$result" -ne 0 ]; then printf '%s\\n' 'Press Enter to close this terminal.'; read -r acknowledgment; fi; exit "$result"`)}`;
}
