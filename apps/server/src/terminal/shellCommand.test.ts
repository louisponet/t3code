import { describe, expect, it } from "vite-plus/test";

import { shellCommandCandidate } from "./shellCommand.ts";

describe("shellCommandCandidate", () => {
  it("runs POSIX shells as interactive non-login shells, keeping their own flags", () => {
    expect(shellCommandCandidate({ shell: "/bin/bash" }, "lazygit")).toEqual({
      shell: "/bin/bash",
      args: ["-ic", "lazygit"],
    });
    expect(
      shellCommandCandidate({ shell: "/bin/zsh", args: ["-o", "nopromptsp"] }, "btop -p 1"),
    ).toEqual({ shell: "/bin/zsh", args: ["-o", "nopromptsp", "-ic", "btop -p 1"] });
  });

  it("uses -Command for PowerShell on any platform", () => {
    for (const shell of [
      "pwsh.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "/usr/bin/pwsh",
    ]) {
      expect(shellCommandCandidate({ shell, args: ["-NoLogo"] }, "lazygit")).toEqual({
        shell,
        args: ["-NoLogo", "-Command", "lazygit"],
      });
    }
  });

  it("runs cmd with AutoRun disabled and quote stripping", () => {
    expect(shellCommandCandidate({ shell: "C:\\Windows\\System32\\CMD.EXE" }, "gtc tui")).toEqual({
      shell: "C:\\Windows\\System32\\CMD.EXE",
      args: ["/d", "/s", "/c", "gtc tui"],
    });
  });
});
