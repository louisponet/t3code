/** Keep launcher errors readable while the editor protocol has not become ready. */
export function helixStartupText(output: string): string {
  return (
    output
      // eslint-disable-next-line no-control-regex -- Terminal OSC and CSI framing.
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/gu, "")
      // eslint-disable-next-line no-control-regex -- Strip terminal display instructions.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
      // eslint-disable-next-line no-control-regex -- Preserve printable launcher guidance.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "")
      .slice(-4000)
      .trim()
  );
}

export function isHelixLaunchAwaitingClose(output: string): boolean {
  return helixStartupText(output)
    .split("\n")
    .some((line) => line.trim() === "Press Enter to close this terminal.");
}

export function helixLaunchError(output: string): string | null {
  const errors = [...helixStartupText(output).matchAll(/hx-t3: ([^\n]+)/gu)];
  return errors.at(-1)?.[1]?.trim() ?? null;
}
