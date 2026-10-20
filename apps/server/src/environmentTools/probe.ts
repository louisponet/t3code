import {
  MAX_ENVIRONMENT_TOOL_UNAVAILABLE_REASON_LENGTH,
  type EnvironmentToolBadge,
} from "@t3tools/contracts";
import {
  cleanEnvironmentToolText,
  normalizeEnvironmentToolBadge,
} from "@t3tools/shared/environmentTools";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeUtil from "node:util";

import * as ProcessRunner from "../processRunner.ts";
import { shellName } from "../terminal/shellCommand.ts";

const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

export type EnvironmentToolProbeOutcome =
  | { readonly _tag: "badge"; readonly badge: EnvironmentToolBadge }
  | { readonly _tag: "unavailable"; readonly reason: string };

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const unavailable = (reason: string): EnvironmentToolProbeOutcome => ({
  _tag: "unavailable",
  reason: cleanEnvironmentToolText(reason, MAX_ENVIRONMENT_TOOL_UNAVAILABLE_REASON_LENGTH),
});

const lastNonEmptyLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => NodeUtil.stripVTControlCharacters(line).trim())
    .findLast((line) => line.length > 0);

/** Turns a finished probe run into a badge or the reason there is none. */
export function probeOutcome(
  output: ProcessRunner.ProcessRunOutput,
  timeoutSeconds: number,
): EnvironmentToolProbeOutcome {
  if (output.timedOut) return unavailable(`No answer within ${timeoutSeconds}s`);
  if (output.code !== 0) {
    return unavailable(
      lastNonEmptyLine(output.stderr) ??
        (output.code === null
          ? "The status command was stopped"
          : `The status command exited with code ${output.code}`),
    );
  }
  const parsed = decodeJson(output.stdout);
  if (Option.isNone(parsed)) return unavailable("Output is not a status badge: expected JSON");
  const badge = normalizeEnvironmentToolBadge(parsed.value);
  return "error" in badge ? unavailable(badge.error) : { _tag: "badge", badge };
}

/**
 * Non-interactive on purpose: an interactive shell's rc output would land in stdout and corrupt
 * the badge JSON. PATH is still the login-shell PATH the server hydrated at startup.
 */
export function probeShellCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  command: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const shell = platform === "win32" ? "powershell.exe" : (env.SHELL ?? "/bin/sh");
  const name = shellName(shell);
  return name === "pwsh" || name === "powershell"
    ? { command: shell, args: ["-NoLogo", "-NonInteractive", "-Command", command] }
    : { command: shell, args: ["-c", command] };
}

export const runEnvironmentToolProbe = Effect.fn("EnvironmentTools.runProbeCommand")(
  function* (input: {
    readonly command: string;
    readonly cwd: string;
    readonly timeoutSeconds: number;
  }) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const shell = probeShellCommand(
      yield* HostProcess.Platform,
      yield* HostProcess.Environment,
      input.command,
    );
    return yield* processRunner
      .run({
        ...shell,
        cwd: input.cwd,
        timeout: `${input.timeoutSeconds} seconds`,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((output) => probeOutcome(output, input.timeoutSeconds)),
        // The error carries the command; only a fixed reason leaves this module.
        Effect.orElseSucceed(() => unavailable("The status command could not run")),
      );
  },
);
