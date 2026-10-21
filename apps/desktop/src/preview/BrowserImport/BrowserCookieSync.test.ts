import { assert, describe, it } from "@effect/vitest";
import { ClientSettingsSchema, type BrowserImportSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { resolvePartitionScope, type BrowserSessionPartitionNamespace } from "../BrowserSession.ts";
import * as BrowserCookieSync from "./BrowserCookieSync.ts";
import * as BrowserImport from "./BrowserImport.ts";

const decodeSettings = Schema.decodeUnknownSync(ClientSettingsSchema);

const link = (profileId: string, sourceId: BrowserImportSourceId) => ({
  profileId,
  sourceId,
  sourceProfileDirectory: "Default",
  environmentIds: ["environment-a", "environment-b"],
});

const settingsWith = (
  profileIds: ReadonlyArray<string>,
  links: ReadonlyArray<ReturnType<typeof link>>,
) =>
  decodeSettings({
    browserProfiles: profileIds.map((id) => ({ id, name: id, kind: "persistent" })),
    browserCookieSyncs: links,
  });

interface ImportCall {
  readonly profileId: string;
  readonly targets: ReadonlyArray<{
    readonly scope: string;
    readonly persistent: boolean;
    readonly namespace?: BrowserSessionPartitionNamespace;
  }>;
}

describe("BrowserCookieSync", () => {
  it.effect("re-imports every link each round, reading the links fresh each time", () =>
    Effect.gen(function* () {
      const calls = yield* Queue.unbounded<ImportCall>();
      // Firefox stands in for a source that is blocked every round.
      const browserImport = BrowserImport.BrowserImport.of({
        listSources: Effect.succeed([]),
        importCookies: ({ input, targets }) =>
          Queue.offer(calls, { profileId: input.targetProfileId, targets }).pipe(
            Effect.andThen(
              input.sourceId === "firefox"
                ? Effect.fail(
                    new BrowserImport.BrowserImportFailedError({
                      sourceId: input.sourceId,
                      reason: "browserRunning",
                    }),
                  )
                : Effect.succeed({ imported: 1, skipped: 0, skippedDomains: [] }),
            ),
          ),
      });
      const takeProfileIds = (count: number) =>
        Effect.forEach(Array.from({ length: count }), () =>
          Queue.take(calls).pipe(Effect.map((call) => call.profileId)),
        );

      yield* Effect.gen(function* () {
        const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* BrowserCookieSync.start;

        yield* TestClock.adjust("30 seconds");
        const blocked = yield* Queue.take(calls);
        const synced = yield* Queue.take(calls);
        assert.equal(blocked.profileId, "work");
        assert.equal(synced.profileId, "personal");
        assert.deepEqual(synced.targets, [
          resolvePartitionScope("environment-a", "personal"),
          resolvePartitionScope("environment-b", "personal"),
        ]);

        yield* clientSettings.set(
          settingsWith(
            ["personal", "research"],
            [link("personal", "brave"), link("research", "chrome"), link("removed", "edge")],
          ),
        );
        yield* TestClock.adjust("15 minutes");
        assert.deepEqual(yield* takeProfileIds(2), ["personal", "research"]);

        // The next round starts with `personal`, so the round before it
        // skipped the link whose profile is gone.
        yield* TestClock.adjust("15 minutes");
        assert.deepEqual(yield* takeProfileIds(2), ["personal", "research"]);
      }).pipe(
        Effect.provide(
          DesktopClientSettings.layerTest(
            Option.some(
              settingsWith(
                ["work", "personal"],
                [link("work", "firefox"), link("personal", "brave")],
              ),
            ),
          ),
        ),
        Effect.provideService(BrowserImport.BrowserImport, browserImport),
      );
    }).pipe(Effect.scoped),
  );
});
