// @effect-diagnostics nodeBuiltinImport:off - Builds a Firefox-shaped `cookies.sqlite`
// fixture with the same native bindings Firefox itself uses.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { Session } from "electron";
import * as NodeSqlite from "node:sqlite";

import * as BrowserSession from "../BrowserSession.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { BROWSER_IMPORT_SOURCES, sourcePathContext } from "./Sources.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

const cookie = {
  url: "https://rejected.example/path",
  name: "session",
  value: "value",
  domain: undefined,
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate: undefined,
  sameSite: "lax" as const,
};

const layerRejectedBeforeSession = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.die("getPartition must not be reached"),
    isPartition: () => false,
    getSession: () => Effect.die("getSession must not be reached"),
    clearCookies: () => Effect.die("clearCookies must not be reached"),
    clearCache: () => Effect.die("clearCache must not be reached"),
  }),
);

const withImporter = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-import-" });
  const layerEnvironment = Layer.succeed(HostProcess.Environment, { HOME: home });
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
  const root = helium.userDataDirectory(context);
  if (root === undefined) throw new Error("Helium has no macOS user-data directory");
  yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
  // The cookie database is what marks a source as installed, so a fixture
  // without one is reported as absent before any other check runs.
  yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "db");

  const importer = yield* BrowserImport.BrowserImport.pipe(
    Effect.provide(
      BrowserImport.layer.pipe(
        Layer.provide(layerRejectedBeforeSession),
        Layer.provide(layerEnvironment),
        Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
        Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/Applications/T3 Code.app")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  return { importer, home, root };
});

describe("BrowserImport.importCookies", () => {
  it.effect("rejects a source profile the browser never reported", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { importer, home } = yield* withImporter();

      yield* fileSystem.makeDirectory(`${home}/secrets`, { recursive: true });
      yield* fileSystem.writeFileString(`${home}/secrets/Cookies`, "not-a-db");

      const error = yield* importer
        .importCookies({
          input: {
            sourceId: "helium",
            sourceProfileDirectory: "../../../../secrets",
            targetProfileId: "default",
          },
          targets: [{ scope: "persist:t3code-preview-test", persistent: true }],
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, BrowserImport.BrowserImportFailedError);
      assert.equal(error.reason, "unknownSourceProfile");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "offers a running Chromium browser on macOS without asking to quit it",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { importer, root } = yield* withImporter();
        yield* fileSystem.symlink("host-that-does-not-exist-1234", `${root}/SingletonLock`);

        const sources = yield* importer.listSources;
        const listed = sources.find((source) => source.id === "helium");

        assert.isDefined(listed);
        assert.isUndefined(listed.unavailable);
        assert.deepEqual(
          listed.profiles.map((profile) => profile.directory),
          ["Default"],
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)("refuses to import Firefox while it holds its profile", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-import-" });
      const root = `${home}/.mozilla/firefox`;
      yield* fileSystem.makeDirectory(`${root}/work.default`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${root}/profiles.ini`,
        "[Profile0]\nName=Work\nIsRelative=1\nPath=work.default\n",
      );
      yield* fileSystem.writeFileString(`${root}/work.default/cookies.sqlite`, "db");
      // The lock Firefox holds while it runs, pointing at this live process.
      yield* fileSystem.symlink(`127.0.0.1:+${process.pid}`, `${root}/work.default/lock`);
      const importer = yield* BrowserImport.BrowserImport.pipe(
        Effect.provide(
          BrowserImport.layer.pipe(
            Layer.provide(layerRejectedBeforeSession),
            Layer.provide(Layer.succeed(HostProcess.Environment, { HOME: home })),
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/opt/t3code/t3code")),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );

      const error = yield* importer
        .importCookies({
          input: {
            sourceId: "firefox",
            sourceProfileDirectory: "work.default",
            targetProfileId: "default",
          },
          targets: [{ scope: "persist:t3code-preview-test", persistent: true }],
        })
        .pipe(Effect.flip);

      assert.equal(error.reason, "browserRunning");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("BrowserImport.importCookies targets", () => {
  it.effect("writes the source's cookies into every target", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-import-" });
      const root = `${home}/.mozilla/firefox`;
      yield* fileSystem.makeDirectory(`${root}/work.default`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${root}/profiles.ini`,
        "[Profile0]\nName=Work\nIsRelative=1\nPath=work.default\n",
      );
      const database = new NodeSqlite.DatabaseSync(`${root}/work.default/cookies.sqlite`);
      database.exec("pragma user_version = 15");
      database.exec(
        `create table moz_cookies (
           id integer primary key, host text, name text, value text, path text,
           expiry integer, isSecure integer, isHttpOnly integer, sameSite integer,
           originAttributes text not null default ''
         )`,
      );
      database.exec(
        `insert into moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite)
         values ('.grafana.example', 'session', 'value', '/', 4102444800, 1, 1, 1)`,
      );
      database.close();

      const written = new Map<string, Array<string>>();
      const sessionFor = (scope = "shared") =>
        ({
          cookies: {
            set: (details: { readonly url: string }) => {
              if (scope === "rejects") return Promise.reject(new Error("fixture rejection"));
              written.set(scope, [...(written.get(scope) ?? []), details.url]);
              return Promise.resolve();
            },
            flushStore: () => Promise.resolve(),
          },
        }) as unknown as Session;
      const layerSessions = Layer.succeed(
        BrowserSession.BrowserSession,
        BrowserSession.BrowserSession.of({
          getPartition: () => Effect.die("getPartition must not be reached"),
          isPartition: () => false,
          getSession: (scope) => Effect.succeed(sessionFor(scope)),
          clearCookies: () => Effect.die("clearCookies must not be reached"),
          clearCache: () => Effect.die("clearCache must not be reached"),
        }),
      );
      const importer = yield* BrowserImport.BrowserImport.pipe(
        Effect.provide(
          BrowserImport.layer.pipe(
            Layer.provide(layerSessions),
            Layer.provide(Layer.succeed(HostProcess.Environment, { HOME: home })),
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/opt/t3code/t3code")),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      const input = {
        sourceId: "firefox",
        sourceProfileDirectory: "work.default",
        targetProfileId: "default",
      } as const;

      const result = yield* importer.importCookies({
        input,
        targets: [
          { scope: "environment-a", persistent: true },
          { scope: "environment-b", persistent: true },
        ],
      });

      assert.deepEqual(result, { imported: 1, skipped: 0, skippedDomains: [] });
      assert.deepEqual(Object.fromEntries(written), {
        "environment-a": ["https://grafana.example/"],
        "environment-b": ["https://grafana.example/"],
      });

      // A target that loses cookies is what the user is told about.
      const partial = yield* importer.importCookies({
        input,
        targets: [
          { scope: "environment-a", persistent: true },
          { scope: "rejects", persistent: true },
        ],
      });
      assert.deepEqual(partial, {
        imported: 0,
        skipped: 1,
        skippedDomains: ["grafana.example"],
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("BrowserImport.writeCookies", () => {
  it.effect("counts a rejected cookie and its domain as skipped", () =>
    Effect.gen(function* () {
      let flushes = 0;
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: () => Promise.reject(new Error("fixture rejection")),
            flushStore: () => {
              flushes += 1;
              return Promise.resolve();
            },
          },
        },
        { cookies: [cookie], undecryptable: 0, undecryptableHosts: [] },
      );

      assert.deepEqual(result, {
        imported: 0,
        skipped: 1,
        skippedDomains: ["rejected.example"],
      });
      assert.equal(flushes, 0);
    }),
  );

  it.effect("flushes the store after writing, and reports success if the flush fails", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: () => {
              events.push("set");
              return Promise.resolve();
            },
            flushStore: () => {
              events.push("flush");
              return Promise.reject(new Error("fixture flush failure"));
            },
          },
        },
        { cookies: [cookie, cookie], undecryptable: 0, undecryptableHosts: [] },
      );

      assert.deepEqual(events, ["set", "set", "flush"]);
      assert.deepEqual(result, { imported: 2, skipped: 0, skippedDomains: [] });
    }),
  );

  it.effect("propagates interruption while writing a cookie", () =>
    Effect.gen(function* () {
      const write = BrowserImport.writeCookies(
        {
          cookies: {
            set: () => new Promise<void>(() => {}),
            flushStore: () => Promise.resolve(),
          },
        },
        { cookies: [cookie], undecryptable: 0, undecryptableHosts: [] },
      );

      const interrupted = yield* Ref.make(false);
      const fiber = yield* write.pipe(
        Effect.onInterrupt(() => Ref.set(interrupted, true)),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);

      assert.isTrue(yield* Ref.get(interrupted));
    }),
  );
});
