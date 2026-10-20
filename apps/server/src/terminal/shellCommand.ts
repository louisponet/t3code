export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export function shellName(shell: string): string {
  return (shell.split(/[\\/]/).at(-1) ?? shell).toLowerCase().replace(/\.exe$/, "");
}

/**
 * Turns a shell candidate into one that runs `command` and exits with it.
 * POSIX shells get `-ic` because T3 terminals are interactive non-login
 * shells, so rc aliases and functions resolve as they do when typed there.
 */
export function shellCommandCandidate(candidate: ShellCandidate, command: string): ShellCandidate {
  switch (shellName(candidate.shell)) {
    case "pwsh":
    case "powershell":
      return { shell: candidate.shell, args: ["-NoLogo", "-Command", command] };
    case "cmd":
      // /s makes cmd strip the quotes the PTY backend puts around the command.
      return { shell: candidate.shell, args: ["/d", "/s", "/c", command] };
    default:
      return { shell: candidate.shell, args: [...(candidate.args ?? []), "-ic", command] };
  }
}
