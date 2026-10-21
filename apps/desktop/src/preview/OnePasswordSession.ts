// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node child process.

import * as NodeChildProcess from "node:child_process";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type OpReply =
  | { readonly _tag: "Exited"; readonly exitCode: number | null; readonly stdout: string }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Lost" };

type Request = {
  readonly id: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

// Runs in the helper. stdin stays closed: `op item get` reads piped stdin as
// its item list.
const HELPER = `
const { spawn } = require("node:child_process");
process.on("message", ({ id, command, args }) => {
  let sent = false;
  const reply = (message) => {
    if (sent) return;
    sent = true;
    process.send({ id, ...message });
  };
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.on("error", (error) =>
    reply(error.code === "ENOENT" ? { _tag: "NotFound" } : { _tag: "Exited", exitCode: null, stdout: "" }),
  );
  child.on("close", (exitCode) =>
    reply({ _tag: "Exited", exitCode, stdout: Buffer.concat(chunks).toString("utf8") }),
  );
});
process.on("disconnect", () => process.exit(0));
`;

const startHelper = () => {
  const waiting = new Map<number, (reply: OpReply) => void>();
  let nextId = 0;
  const child = NodeChildProcess.spawn(process.execPath, ["-e", HELPER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.on("message", (raw) => {
    const { id, ...reply } = raw as OpReply & { readonly id: number };
    waiting.get(id)?.(reply as OpReply);
    waiting.delete(id);
  });
  const lose = () => {
    for (const resolve of waiting.values()) resolve({ _tag: "Lost" });
    waiting.clear();
  };
  child.once("error", lose);
  child.once("exit", lose);
  return {
    child,
    run: (command: string, args: ReadonlyArray<string>, resolve: (reply: OpReply) => void) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.send({ id, command, args } satisfies Request, (error) => {
        if (error) lose();
      });
      return () => waiting.delete(id);
    },
  };
};

/**
 * Runs commands as children of one long-lived helper that leads its own
 * session. 1Password approves `op` per session and resets the connection when
 * the session leader has exited, which is the norm when a desktop launcher
 * starts the app and quits. A fresh session per call would ask every time.
 */
export class OnePasswordSession extends Context.Service<
  OnePasswordSession,
  {
    readonly run: (command: string, args: ReadonlyArray<string>) => Effect.Effect<OpReply>;
  }
>()("@t3tools/desktop/preview/OnePasswordSession") {}

const make = Effect.gen(function* () {
  let helper: ReturnType<typeof startHelper> | undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => helper?.child.kill()));

  const run = (command: string, args: ReadonlyArray<string>) =>
    Effect.callback<OpReply>((resume) => {
      if (!helper?.child.connected) helper = startHelper();
      const cancel = helper.run(command, args, (reply) => resume(Effect.succeed(reply)));
      return Effect.sync(cancel);
    });

  return OnePasswordSession.of({ run });
});

export const layer = Layer.effect(OnePasswordSession, make);
