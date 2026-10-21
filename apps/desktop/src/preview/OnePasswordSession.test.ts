// @effect-diagnostics nodeBuiltinImport:off -- Reads this process's session id to compare with the helper's.

import * as NodeChildProcess from "node:child_process";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as OnePasswordSession from "./OnePasswordSession.ts";

const LIVE_SESSION = 'sid=$(ps -o sid= -p $$ | tr -d " "); kill -0 "$sid" && echo "$sid"';

const run = (command: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(OnePasswordSession.OnePasswordSession, (session) => session.run(command, args));

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("OnePasswordSession", () => {
  it.effect("runs every command in one live session of its own", () =>
    Effect.gen(function* () {
      const first = yield* run("sh", ["-c", LIVE_SESSION]);
      const second = yield* run("sh", ["-c", LIVE_SESSION]);
      assert.strictEqual(first._tag, "Exited");
      assert.strictEqual(second._tag, "Exited");
      if (first._tag !== "Exited" || second._tag !== "Exited") return;
      assert.strictEqual(first.exitCode, 0);
      assert.strictEqual(first.stdout, second.stdout);
      const ours = NodeChildProcess.execFileSync("ps", ["-o", "sid=", "-p", String(process.pid)]);
      assert.notStrictEqual(first.stdout.trim(), String(ours).trim());
    }).pipe(Effect.provide(OnePasswordSession.layer)),
  );

  it.effect("reports exit codes, closed stdin, and missing commands", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run("sh", ["-c", "cat; exit 3"]), {
        _tag: "Exited",
        exitCode: 3,
        stdout: "",
      });
      assert.deepStrictEqual(yield* run("t3code-no-such-command", []), { _tag: "NotFound" });
    }).pipe(Effect.provide(OnePasswordSession.layer)),
  );
});
