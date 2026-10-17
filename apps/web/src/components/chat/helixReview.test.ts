// @effect-diagnostics nodeBuiltinImport:off - Executes the generated terminal command against a real disposable launcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  findOpenHelixReviewTerminal,
  helixReviewCommand,
  newHelixReviewTerminalId,
} from "./helixReview";

describe("helixReviewCommand", () => {
  it.each(["work", "review"] as const)(
    "carries quoted file locations in one argument in %s mode",
    (mode) => {
      const command = helixReviewCommand("thread-1", "environment-1", {
        filePath: "src/it's $(danger).ts",
        line: 12,
        worktreePath: "/tmp/repo",
        mode,
      });
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "helix-launch-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(directory, "hx-t3"),
          '#!/bin/sh\nprintf "%s\\n" "$@"\n',
          {
            mode: 0o755,
          },
        );
        const output = NodeChildProcess.execFileSync("sh", ["-c", command], {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          encoding: "utf8",
        });
        expect(output.trim().split("\n")).toEqual([
          "--thread",
          "thread-1",
          "--environment-id",
          "environment-1",
          "--location",
          JSON.stringify({
            filePath: "src/it's $(danger).ts",
            line: 12,
            worktreePath: "/tmp/repo",
            mode,
          }),
        ]);
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
      expect(() => helixReviewCommand("thread-1", "environment-1", { line: 0 })).toThrow();
    },
  );
  it("passes the exact thread identity through the interactive and child shells", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-helix-review-"));
    try {
      NodeFS.writeFileSync(NodePath.join(root, "hx-t3"), '#!/bin/sh\nprintf "%s\\n" "$#" "$@"\n', {
        mode: 0o700,
      });
      const threadId = "thread:delegated-task:command%3A' $(printf injected) `printf injected` ; &";
      const environmentId = "env:dev%3A' $(printf wrong-server)";
      const output = NodeChildProcess.execFileSync(
        "sh",
        ["-c", `${helixReviewCommand(threadId, environmentId)}; printf unreachable`],
        {
          encoding: "utf8",
          env: { PATH: `${root}:/usr/bin:/bin` },
        },
      );
      expect(output).toBe(
        `6\n--thread\n${threadId}\n--environment-id\n${environmentId}\n--location\n{"mode":"work"}\n`,
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives setup guidance when the destination environment has no launcher", () => {
    const result = NodeChildProcess.spawnSync(
      "sh",
      ["-c", helixReviewCommand("thread-1", "env-1")],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
        input: "\n",
      },
    );
    expect(result.status).toBe(127);
    const output = result.stdout;
    expect(output).toContain("Install the Helix T3 review integration on this machine");
    expect(output).toContain("hx-t3 setup");
    expect(output).toContain("node contrib/t3-helix-review/cli.ts install");
    expect(output).toContain("Press Enter to close this terminal.");
  });

  it("keeps a failed launcher visible until Enter acknowledges its error", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-helix-review-"));
    NodeFS.writeFileSync(
      NodePath.join(root, "hx-t3"),
      '#!/bin/sh\nprintf "%s\\n" "Pairing failed; run hx-t3 setup."\nexit 7\n',
      { mode: 0o700 },
    );
    const child = NodeChildProcess.spawn("sh", ["-c", helixReviewCommand("thread-1", "env-1")], {
      env: { PATH: `${root}:/usr/bin:/bin` },
    });
    try {
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      let output = "";
      await new Promise<void>((resolve) => {
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          if (output.includes("Press Enter to close this terminal.")) resolve();
        });
      });
      expect(output).toContain("Pairing failed; run hx-t3 setup.");
      expect(child.exitCode).toBeNull();
      child.stdin.end("\n");
      expect(await exited).toBe(7);
    } finally {
      child.kill();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses terminal control sequences", () => {
    for (const id of ["", "thread\ncommand", "thread\u001b[2J", "thread\0id"]) {
      expect(() => helixReviewCommand(id, "env-1")).toThrow("thread ID");
      expect(() => helixReviewCommand("thread-1", id)).toThrow("thread ID");
    }
  });
});

describe("HX review terminal lifecycle", () => {
  it("returns to a visible running review while ignoring old closed tabs and exited processes", () => {
    const oldId = newHelixReviewTerminalId("previous-launch");
    const currentId = newHelixReviewTerminalId("current-launch");
    expect(currentId).not.toBe(oldId);
    const sessions = [
      { target: { terminalId: oldId }, state: { status: "running" } },
      { target: { terminalId: currentId }, state: { status: "running" } },
      { target: { terminalId: "default" }, state: { status: "running" } },
    ];
    expect(findOpenHelixReviewTerminal(sessions, [currentId, "default"])).toBe(currentId);
    expect(findOpenHelixReviewTerminal(sessions, ["default"])).toBeNull();
    sessions[1]!.state.status = "exited";
    expect(findOpenHelixReviewTerminal(sessions, [currentId, "default"])).toBeNull();
  });
});
