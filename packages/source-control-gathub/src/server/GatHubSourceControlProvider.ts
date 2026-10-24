import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type ChangeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { GATHUB_REPOSITORY, gatHubPullRequestNumber } from "@t3tools/shared/changeRequestUrl";
import { isGatHubHost } from "@t3tools/shared/sourceControl";
import {
  providerAuth,
  type SourceControlApiDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import * as GatHubApi from "./GatHubApi.ts";
import * as Json from "./gatHubPullRequestJson.ts";

const KIND = SourceControlProviderKind.make("gathub");
const DEFAULT_HOST = "gathub.gattaca.com";

const Repository = Schema.Struct({
  user: Schema.String,
  default_branch: Schema.String,
  branches: Schema.Array(Schema.Struct({ name: Schema.String, head: Schema.String })),
});
const LinkSubject = Schema.Struct({ title: Schema.String, body: Schema.NullOr(Schema.String) });
const decodeViewer = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ user: Schema.String })),
);
const isApiError = Schema.is(GatHubApi.GatHubApiError);

const REMOTE = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+?)(?:\.git)?\/?$/iu;

function parseGatHubRemote(url: string) {
  const match = REMOTE.exec(url.trim());
  const host = match?.[1]?.toLowerCase();
  const repository = match?.[2];
  return host && repository && isGatHubHost(host) ? { host, repository } : null;
}

const decodeUpdatedAt = (updatedAt: string) => Option.some(DateTime.makeUnsafe(updatedAt));

function toChangeRequest(pull: Json.GatHubPull, host: string): ChangeRequest {
  const item = Json.toChangeRequest(pull, host);
  return {
    provider: KIND,
    number: item.number,
    title: item.title,
    url: item.url,
    baseRefName: item.baseBranch,
    headRefName: item.headBranch,
    headSha: pull.head,
    state: item.state,
    ...(item.isDraft ? { isDraft: true } : {}),
    mergedAt: item.mergedAt ?? null,
    closedAt: item.closedAt ?? null,
    updatedAt: decodeUpdatedAt(item.updatedAt),
    isCrossRepository: false,
    headRepositoryNameWithOwner: GATHUB_REPOSITORY,
  };
}

export const makeDiscovery = Effect.gen(function* () {
  const api = yield* GatHubApi.GatHubApi;
  const cwd = yield* HostProcess.WorkingDirectory;
  return {
    type: "api",
    kind: KIND,
    label: "GatHub",
    installHint:
      "GatHub uses the token git pushes with. Clone or push once over HTTP so git's credential helper stores it.",
    probeAuth: api
      .request({ host: DEFAULT_HOST, cwd, operation: "probeAuth", path: "/api/identity" })
      .pipe(
        Effect.flatMap(decodeViewer),
        Effect.map(({ user }) =>
          providerAuth({ status: "authenticated", host: DEFAULT_HOST, account: user }),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            providerAuth({
              status:
                isApiError(error) && error.reason === "unauthenticated"
                  ? "unauthenticated"
                  : "unknown",
              host: DEFAULT_HOST,
              detail: isApiError(error) ? error.detail : "GatHub returned an unreadable identity.",
            }),
          ),
        ),
      ),
  } satisfies SourceControlApiDiscoverySpec;
});

export const make = Effect.gen(function* () {
  const api = yield* GatHubApi.GatHubApi;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: KIND,
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const resolveHost = Effect.fn("GatHubSourceControlProvider.resolveHost")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    },
  ) {
    const remoteUrl =
      input.context?.remoteUrl ??
      (yield* host.git.resolvePrimaryRemoteName(input.cwd).pipe(
        Effect.flatMap((remote) => host.git.readConfigValue(input.cwd, `remote.${remote}.url`)),
        Effect.mapError((cause) =>
          error(operation, input.cwd, "Could not read the GatHub remote.", cause),
        ),
      ));
    const remote = remoteUrl ? parseGatHubRemote(remoteUrl) : null;
    if (remote === null)
      return yield* error(operation, input.cwd, "No GatHub repository remote was found.");
    return remote.host;
  });

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    cwd: string,
    request: { readonly host: string; readonly path: string; readonly body?: unknown },
    schema: S,
  ) =>
    api.request({ ...request, cwd, operation }).pipe(
      Effect.mapError((cause) => error(operation, cwd, cause.detail, cause)),
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            error(operation, cwd, "GatHub returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const getPull = Effect.fn("GatHubSourceControlProvider.getPull")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const url = URL.parse(input.reference.trim());
    const fromUrl = url !== null && isGatHubHost(url.hostname) ? url : null;
    const pullHost = yield* resolveHost("getChangeRequest", input);
    // Checkout fetches the branch from this checkout's remote, so a pull request on another
    // host would check out whatever branch here happens to share its name.
    if (fromUrl !== null && fromUrl.hostname.toLowerCase() !== pullHost)
      return yield* error(
        "getChangeRequest",
        input.cwd,
        `This checkout's GatHub is ${pullHost}, not ${fromUrl.hostname}.`,
      );
    const number = fromUrl
      ? gatHubPullRequestNumber(fromUrl)
      : Number(/^#?([1-9]\d*)$/u.exec(input.reference.trim())?.[1] ?? Number.NaN);
    if (number === null || !Number.isSafeInteger(number))
      return yield* error(
        "getChangeRequest",
        input.cwd,
        "A GatHub pull request is a number or a GatHub pull request URL.",
      );
    const pull = yield* read(
      "getChangeRequest",
      input.cwd,
      { host: pullHost, path: `/api/pulls/${number}` },
      Json.GatHubPull,
    );
    return toChangeRequest(pull, pullHost);
  });

  const getRepository = (operation: string, input: Parameters<typeof resolveHost>[1]) =>
    resolveHost(operation, input).pipe(
      Effect.flatMap((repositoryHost) =>
        read(operation, input.cwd, { host: repositoryHost, path: "/api/repository" }, Repository),
      ),
    );

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    repositoryNameFromRemoteUrl: (url) => parseGatHubRemote(url)?.repository ?? null,
    // Names a thread after a GatHub pull request pasted into it. A title is a nicety, so the read
    // gives up quickly.
    resolveLink: ({ cwd, url }) => {
      const number = isGatHubHost(url.hostname) ? gatHubPullRequestNumber(url) : null;
      if (number === null) return undefined;
      return read(
        "resolveLink",
        cwd,
        { host: url.hostname.toLowerCase(), path: `/api/pulls/${number}` },
        LinkSubject,
      ).pipe(
        Effect.timeout("3 seconds"),
        Effect.mapError((cause) =>
          error("resolveLink", cwd, "The linked pull request could not be read.", cause),
        ),
        Effect.map((pull) => ({ title: pull.title, body: pull.body })),
      );
    },
    getChangeRequest: getPull,
    listChangeRequests: Effect.fn("GatHubSourceControlProvider.listChangeRequests")(
      function* (input) {
        const pullHost = yield* resolveHost("listChangeRequests", input);
        const branch = SourceControlProvider.sourceBranch(input);
        const { pulls } = yield* read(
          "listChangeRequests",
          input.cwd,
          { host: pullHost, path: "/api/pulls" },
          Json.GatHubPulls,
        );
        return pulls
          .filter(
            (pull) =>
              pull.source === branch &&
              (input.state === "all" || Json.pullState(pull) === input.state),
          )
          .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(0, input.limit ?? 20)
          .map((pull) => toChangeRequest(pull, pullHost));
      },
    ),
    createChangeRequest: Effect.fn("GatHubSourceControlProvider.createChangeRequest")(
      function* (input) {
        const pullHost = yield* resolveHost("createChangeRequest", input);
        const repository = yield* read(
          "createChangeRequest",
          input.cwd,
          { host: pullHost, path: "/api/repository" },
          Repository,
        );
        const target = input.target?.refName ?? input.baseRefName;
        if (target !== repository.default_branch)
          return yield* error(
            "createChangeRequest",
            input.cwd,
            `GatHub pull requests merge into ${repository.default_branch}, not ${target}.`,
          );
        const source = SourceControlProvider.sourceBranch(input);
        const branch = repository.branches.find((candidate) => candidate.name === source);
        if (branch === undefined)
          return yield* error(
            "createChangeRequest",
            input.cwd,
            `Push ${source} to GatHub before opening a pull request for it.`,
          );
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError((cause) =>
              error(
                "createChangeRequest",
                input.cwd,
                "Could not read the pull request description.",
                cause,
              ),
            ),
          );
        yield* api
          .request({
            host: pullHost,
            cwd: input.cwd,
            operation: "createChangeRequest",
            path: "/api/pulls/create",
            body: { source, title: input.title, body, draft: false, expected_head: branch.head },
          })
          .pipe(
            Effect.mapError((cause) =>
              error("createChangeRequest", input.cwd, cause.detail, cause),
            ),
          );
      },
    ),
    // Cloning asks from the destination's parent, which is not a GatHub checkout.
    getRepositoryCloneUrls: Effect.fn("GatHubSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const named = parseGatHubRemote(input.repository);
        const repository = named?.repository ?? input.repository.trim().replace(/\.git$/u, "");
        if (repository !== GATHUB_REPOSITORY)
          return yield* error(
            "getRepositoryCloneUrls",
            input.cwd,
            `GatHub serves one repository, ${GATHUB_REPOSITORY}.`,
          );
        const cloneHost =
          named?.host ??
          (input.context ? parseGatHubRemote(input.context.remoteUrl)?.host : undefined) ??
          DEFAULT_HOST;
        const url = `http://${cloneHost}/${GATHUB_REPOSITORY}.git`;
        return { nameWithOwner: GATHUB_REPOSITORY, url, sshUrl: url };
      },
    ),
    createRepository: (input) =>
      Effect.fail(
        error(
          "createRepository",
          input.cwd,
          "GatHub serves one repository and cannot create more.",
        ),
      ),
    getDefaultBranch: (input) =>
      getRepository("getDefaultBranch", input).pipe(
        Effect.map((repository) => repository.default_branch),
      ),
    // Every GatHub pull request comes from a branch of the one repository, so checkout is a fetch.
    checkoutChangeRequest: Effect.fn("GatHubSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const pull = yield* getPull(input);
        const git = host.git;
        yield* Effect.gen(function* () {
          const remoteName =
            input.context?.remoteName ?? (yield* git.resolvePrimaryRemoteName(input.cwd));
          const branch = pull.headRefName;
          const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: branch };
          const branches = yield* git.listLocalBranchNames(input.cwd);
          if (input.force !== true && !branches.includes(branch))
            yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch: branch });
          else yield* git.fetchRemoteTrackingBranch(remoteBranch);
          if (input.force === true)
            yield* git.execute({
              operation: "GatHubSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              args: ["checkout", "-B", branch, `refs/remotes/${remoteName}/${branch}`, "--"],
            });
          yield* git.setBranchUpstream({ ...remoteBranch, branch });
          yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: branch }));
        }).pipe(
          Effect.mapError((cause) =>
            error(
              "checkoutChangeRequest",
              input.cwd,
              "Could not check out the GatHub pull request.",
              cause,
            ),
          ),
        );
      },
    ),
  });
});
