import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { helixReviewCommand } from "./helixReview.ts";
describe("Helix launches", () => {
  it("carries quoted file locations in one argument", () => {
    const command = helixReviewCommand("thread-1", "environment-1", {
      filePath: "src/it's $(danger).ts",
      line: 12,
      worktreePath: "/tmp/repo",
    });
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "helix-launch-"));
    try {
      NodeFS.writeFileSync(NodePath.join(directory, "hx-t3"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
        mode: 0o755,
      });
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
        JSON.stringify({ filePath: "src/it's $(danger).ts", line: 12, worktreePath: "/tmp/repo" }),
      ]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
    expect(() => helixReviewCommand("thread-1", "environment-1", { line: 0 })).toThrow();
  });
  it("retains the two-argument launch", () => {
    expect(helixReviewCommand("thread-1", "environment-1")).not.toContain("--location");
  });
});
