import { ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "vite-plus/test";

import type { ProcessRunOutput } from "../processRunner.ts";
import { probeOutcome, probeShellCommand } from "./probe.ts";

const output = (overrides: Partial<ProcessRunOutput>): ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

describe("probeOutcome", () => {
  it("normalizes the printed badge", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ tone: "alert", text: `#${index}` }));
    const outcome = probeOutcome(
      output({
        stdout: `${JSON.stringify({ tone: "loud", headline: "x".repeat(80), items, extra: 1 })}\n`,
      }),
      30,
    );
    expect(outcome._tag).toBe("badge");
    if (outcome._tag !== "badge") return;
    expect(outcome.badge.tone).toBe("muted");
    expect(Array.from(outcome.badge.headline)).toHaveLength(60);
    expect(outcome.badge.items).toHaveLength(8);
    expect(outcome.badge.total).toBe(10);
  });

  it("explains output that is not a badge", () => {
    expect(probeOutcome(output({ stdout: "Welcome to fish!\n{}" }), 30)).toEqual({
      _tag: "unavailable",
      reason: "Output is not a status badge: expected JSON",
    });
    const missingHeadline = probeOutcome(output({ stdout: '{"tone":"good"}' }), 30);
    expect(missingHeadline._tag).toBe("unavailable");
    if (missingHeadline._tag !== "unavailable") return;
    expect(missingHeadline.reason).toMatch(/^Output is not a status badge: headline/);
  });

  it("reports the last stderr line of a failed command, without escape codes", () => {
    expect(
      probeOutcome(
        output({
          code: ChildProcessSpawner.ExitCode(1),
          stderr: "starting\n\u001b]0;gh\u0007\u001b[31mgh: rate limited\u001b[0m\u001b(B\n\n",
        }),
        30,
      ),
    ).toEqual({ _tag: "unavailable", reason: "gh: rate limited" });
    expect(probeOutcome(output({ code: ChildProcessSpawner.ExitCode(2) }), 30)).toEqual({
      _tag: "unavailable",
      reason: "The status command exited with code 2",
    });
    expect(
      probeOutcome(output({ code: ChildProcessSpawner.ExitCode(1), stderr: "e".repeat(500) }), 30),
    ).toEqual({ _tag: "unavailable", reason: `${"e".repeat(199)}…` });
  });

  it("reports a probe that never answered", () => {
    expect(probeOutcome(output({ code: null, timedOut: true }), 12)).toEqual({
      _tag: "unavailable",
      reason: "No answer within 12s",
    });
  });
});

describe("probeShellCommand", () => {
  it("runs the command through a non-interactive shell", () => {
    expect(probeShellCommand("linux", { SHELL: "/usr/bin/fish" }, "gh prs --badge")).toEqual({
      command: "/usr/bin/fish",
      args: ["-c", "gh prs --badge"],
    });
    expect(probeShellCommand("darwin", {}, "status")).toEqual({
      command: "/bin/sh",
      args: ["-c", "status"],
    });
    expect(probeShellCommand("linux", { SHELL: "/usr/bin/pwsh" }, "status")).toEqual({
      command: "/usr/bin/pwsh",
      args: ["-NoLogo", "-NonInteractive", "-Command", "status"],
    });
    expect(probeShellCommand("win32", { SHELL: "/usr/bin/bash" }, "status")).toEqual({
      command: "powershell.exe",
      args: ["-NoLogo", "-NonInteractive", "-Command", "status"],
    });
  });
});
