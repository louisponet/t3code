import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { isGatHubHost } from "@t3tools/shared/sourceControl";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const TIMEOUT = Duration.seconds(30);
/**
 * Off the tailnet GatHub's address hangs rather than refusing, and the viewer read gates every
 * pull request list, other hosts' included, so the identity read gives up quickly.
 */
const IDENTITY_TIMEOUT = Duration.seconds(5);
const TOKEN_TTL = Duration.minutes(5);
const MISSING_TTL = Duration.seconds(10);

export const GatHubApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
  "failed",
]);

export class GatHubApiError extends Schema.TaggedError<GatHubApiError>()("GatHubApiError", {
  host: Schema.String,
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: GatHubApiFailure,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `GatHub ${this.operation} failed on ${this.host}: ${this.detail}`;
  }
}

class GatHubNoCredentialError extends Schema.TaggedError<GatHubNoCredentialError>()(
  "GatHubNoCredentialError",
  {},
) {}

export interface GatHubApiRequest {
  readonly host: string;
  /** Where git is asked for the credential, so a checkout's own credential helper answers. */
  readonly cwd: string;
  readonly operation: string;
  readonly path: string;
  /** GatHub writes are POSTs with a JSON body; everything else is a GET. */
  readonly body?: unknown;
}

export class GatHubApi extends Context.Service<
  GatHubApi,
  {
    readonly request: (input: GatHubApiRequest) => Effect.Effect<string, GatHubApiError>;
  }
>()("@t3tools/source-control-gathub/server/GatHubApi") {}

const Identity = Schema.Struct({ identity_key: Schema.String });
const decodeIdentity = Schema.decodeUnknownEffect(Schema.fromJsonString(Identity));

// GatHub redirects a request it did not authenticate to Google sign-in.
const reasonForStatus = (status: number): typeof GatHubApiFailure.Type =>
  status === 401 || (status >= 300 && status < 400)
    ? "unauthenticated"
    : status === 429
      ? "rate-limited"
      : status === 404
        ? "not-found"
        : "failed";

function credentialField(output: string, field: "username" | "password"): string | null {
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith(`${field}=`)) return line.slice(field.length + 1).trim() || null;
  }
  return null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const { process, git } = yield* SourceControlHost.SourceControlHost;

  /**
   * The checkout's remote on this host, whichever name it has, is what git looks up when it
   * pushes there: its username, its path, and any credential written into it pick the answer.
   */
  const credentialQuery = (host: string, cwd: string) =>
    git.remotes(cwd).pipe(
      Effect.flatten,
      Effect.map(({ remotes }) => {
        const url = remotes
          .toSorted((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
          // A write goes to the push URL, whose credential may differ from the fetch URL's.
          .flatMap((remote) => [...Option.toArray(remote.pushUrl), remote.url])
          .map((remoteUrl) => URL.parse(remoteUrl))
          .find((url) => url?.protocol === "http:" && url.hostname.toLowerCase() === host);
        return url ? `url=${url.href}\n\n` : `protocol=http\nhost=${host}\n\n`;
      }),
      Effect.orElseSucceed(() => `protocol=http\nhost=${host}\n\n`),
    );

  /**
   * GatHub has no CLI; the token is the one git pushes with. Git's credential protocol hands it
   * over stdin/stdout, so it never reaches an argument list or a log, and with prompts off a
   * missing credential fails instead of waiting on a terminal nobody is at.
   */
  const lookup = Effect.fn("GatHubApi.credential")(function* (key: string) {
    const [host = "", cwd = ""] = key.split("\n");
    const output = yield* process.run({
      operation: "GatHubApi.credential",
      command: "git",
      args: ["credential", "fill"],
      cwd,
      stdin: yield* credentialQuery(host, cwd),
      env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" },
      // With prompts off, git answers a credential it does not have by exiting 128.
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    });
    const username = credentialField(output.stdout, "username");
    const password = credentialField(output.stdout, "password");
    if (username === null || password === null) return yield* new GatHubNoCredentialError();
    return { username, password: Redacted.make(password) };
  });
  const credentials = yield* Cache.makeWith(lookup, {
    capacity: 16,
    // Only "git has none" is worth remembering; a git that failed to run may run next time.
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists((error) => error._tag === "GatHubNoCredentialError"),
            )
          ? MISSING_TTL
          : Duration.zero,
  });

  const request = Effect.fn("GatHubApi.request")(function* (
    input: GatHubApiRequest,
  ): Effect.fn.Return<string, GatHubApiError> {
    const host = input.host.trim().toLowerCase();
    const fail = (
      fields: Pick<GatHubApiError, "status" | "reason" | "detail"> & { cause?: unknown },
    ) =>
      new GatHubApiError({
        host,
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    // The host comes from a remote URL, so a token never leaves for a host GatHub does not own.
    if (!isGatHubHost(host))
      return yield* fail({ status: null, reason: "failed", detail: `${host} is not GatHub.` });
    yield* Effect.annotateCurrentSpan({
      "gathub.host": host,
      "gathub.operation": input.operation,
      "http.request.method": input.body === undefined ? "GET" : "POST",
    });
    const cacheKey = `${host}\n${input.cwd}`;
    const credential = yield* Cache.get(credentials, cacheKey).pipe(
      Effect.mapError((cause) =>
        cause._tag === "GatHubNoCredentialError"
          ? fail({
              status: null,
              reason: "unauthenticated",
              detail: `Git has no credential for ${host}. Clone or push once with a GatHub token so git stores it.`,
              cause,
            })
          : fail({
              status: null,
              reason: "failed",
              detail: `git could not hand over the credential for ${host}.`,
              cause,
            }),
      ),
    );
    const send = (path: string, body: unknown, identityKey: string | null) => {
      const base = HttpClientRequest.make(body === undefined ? "GET" : "POST")(
        `http://${host}${path}`,
      ).pipe(
        HttpClientRequest.basicAuth(credential.username, Redacted.value(credential.password)),
        HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
        identityKey === null
          ? (request) => request
          : HttpClientRequest.setHeader("x-galileo-identity", identityKey),
      );
      return httpClient
        .execute(body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
        .pipe(
          // The client's own span would record the query string.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          // fetch would follow a redirect with the credential still attached; GatHub only
          // redirects a request it did not authenticate, toward Google sign-in.
          Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
          Effect.flatMap((response) =>
            Effect.map(response.text, (text) => ({ status: response.status, text })),
          ),
          Effect.timeout(path === "/api/identity" ? IDENTITY_TIMEOUT : TIMEOUT),
          Effect.mapError((cause) =>
            fail({ status: null, reason: "failed", detail: `Could not reach ${host}.`, cause }),
          ),
        );
    };
    const answer = Effect.fnUntraced(function* (response: {
      readonly status: number;
      readonly text: string;
    }) {
      if (response.status >= 200 && response.status < 300) return response.text;
      // The credential store may hold a newer token than the one that was refused.
      if (reasonForStatus(response.status) === "unauthenticated")
        yield* Cache.invalidate(credentials, cacheKey);
      return yield* fail({
        status: response.status,
        reason: reasonForStatus(response.status),
        detail:
          response.status === 409
            ? "The pull request changed on GatHub. Refresh and try again."
            : `GatHub answered HTTP ${response.status}.`,
      });
    });
    // GatHub refuses a POST that does not carry the sending account's identity key.
    const identityKey =
      input.body === undefined
        ? null
        : yield* send("/api/identity", undefined, null).pipe(
            Effect.flatMap(answer),
            Effect.flatMap((text) =>
              decodeIdentity(text).pipe(
                Effect.mapError((cause) =>
                  fail({
                    status: null,
                    reason: "failed",
                    detail: "GatHub returned an unreadable identity.",
                    cause,
                  }),
                ),
              ),
            ),
            Effect.map((identity) => identity.identity_key),
          );
    const response = yield* send(input.path, input.body, identityKey);
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status });
    return yield* answer(response);
  });

  return GatHubApi.of({ request });
});

export const layer = Layer.effect(GatHubApi, make);
