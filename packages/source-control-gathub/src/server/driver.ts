import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GatHubPullRequestProvider from "./GatHubPullRequestProvider.ts";
import * as GatHubSourceControlProvider from "./GatHubSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("gathub"),
  make: Effect.all({
    sourceControl: GatHubSourceControlProvider.make,
    discovery: GatHubSourceControlProvider.makeDiscovery,
    pullRequests: GatHubPullRequestProvider.make,
  }),
});
