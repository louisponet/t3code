import { resolveBrowserProfiles, type BrowserCookieSyncLink } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { resolvePartitionScope } from "../BrowserSession.ts";
import * as BrowserImport from "./BrowserImport.ts";

// Off the startup path, which is already busy starting the backend.
const STARTUP_DELAY = "30 seconds";
const SYNC_INTERVAL = "15 minutes";

const syncLink = (
  browserImport: BrowserImport.BrowserImport["Service"],
  link: BrowserCookieSyncLink,
) =>
  browserImport
    .importCookies({
      input: {
        sourceId: link.sourceId,
        sourceProfileDirectory: link.sourceProfileDirectory,
        targetProfileId: link.profileId,
      },
      targets: Arr.map(link.environmentIds, (environmentId) =>
        resolvePartitionScope(environmentId, link.profileId),
      ),
    })
    .pipe(
      Effect.tap((result) =>
        Effect.logDebug("Synced browser cookies", {
          sourceId: link.sourceId,
          imported: result.imported,
          skipped: result.skipped,
        }),
      ),
      Effect.catchTags({
        BrowserImportFailedError: (error) =>
          Effect.logWarning("Browser cookie sync skipped a profile", {
            sourceId: error.sourceId,
            reason: error.reason,
          }),
      }),
      Effect.catchDefect((defect) =>
        Effect.logWarning("Browser cookie sync failed", { sourceId: link.sourceId }, defect),
      ),
    );

/**
 * Re-imports every synced profile shortly after start and then on a fixed
 * interval. Links are read from disk each round, so the settings UI needs no
 * channel to this loop. Must start after Electron is ready: writing cookies
 * opens the profile's session, which Electron refuses before then.
 */
export const start: Effect.Effect<
  void,
  never,
  BrowserImport.BrowserImport | DesktopClientSettings.DesktopClientSettings | Scope.Scope
> = Effect.gen(function* () {
  const browserImport = yield* BrowserImport.BrowserImport;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;

  const round = Effect.gen(function* () {
    const settings = yield* clientSettings.get.pipe(
      // The read already logged its failure; the next round tries again.
      Effect.catchTags({ DesktopClientSettingsReadError: () => Effect.succeedNone }),
    );
    if (Option.isNone(settings)) return;
    const profileIds = new Set(
      resolveBrowserProfiles(settings.value.browserProfiles).map((profile) => profile.id),
    );
    // One at a time, so keyring prompts never stack.
    yield* Effect.forEach(
      settings.value.browserCookieSyncs.filter((link) => profileIds.has(link.profileId)),
      (link) => syncLink(browserImport, link),
      { discard: true },
    );
  }).pipe(Effect.withSpan("desktop.browserCookieSync.round"));

  // `spaced` waits after each round finishes, so rounds never overlap.
  yield* Effect.sleep(STARTUP_DELAY).pipe(
    Effect.andThen(Effect.repeat(round, Schedule.spaced(SYNC_INTERVAL))),
    Effect.forkScoped,
  );
});
