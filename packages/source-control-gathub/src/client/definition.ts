import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
} from "@t3tools/source-control-core/client/definition";
import { gatHubPullRequestUrl, parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { isGatHubHost } from "@t3tools/shared/sourceControl";

const KIND = SourceControlProviderKind.make("gathub");

function isGatHubPullRequestUrl(url: string): boolean {
  const link = parseChangeRequestUrl(url);
  return link !== null && isGatHubHost(link.host);
}

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "GatHub",
  pickerLabel: "GatHub",
  icon: "change-request",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "repo",
  publicHost: null,
  publishDescription: "gathub.gattaca.com",
  publishHost: () => "gathub.gattaca.com",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, number }) => gatHubPullRequestUrl(host, number),
  changeRequestActions: new Set(["ready", "close", "reopen", "merge"] as const),
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: (verdict) => verdict === "request-changes",
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (url) => isGatHubPullRequestUrl(url),
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => isGatHubPullRequestUrl(url),
});
