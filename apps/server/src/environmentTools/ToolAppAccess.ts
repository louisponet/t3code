import { EnvironmentToolId, type WebEnvironmentTool } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto has no synchronous hash for config fingerprints.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";

export const TOOL_APP_ROUTE_PREFIX = "/api/tool-app";

const SIGNING_SECRET_NAME = "tool-app-signing-key";
const TOOL_APP_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const ToolAppClaimsSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("tool-app"),
  toolId: EnvironmentToolId,
  configHash: Schema.String,
  expiresAt: Schema.Number,
});
type ToolAppClaims = typeof ToolAppClaimsSchema.Type;

const ToolAppClaimsJson = Schema.fromJsonString(ToolAppClaimsSchema);
const decodeToolAppClaims = Schema.decodeUnknownOption(ToolAppClaimsJson);
const encodeToolAppClaims = Schema.encodeSync(ToolAppClaimsJson);

export const toolAppConfigHash = (definition: WebEnvironmentTool): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(definition.target)).digest("base64url");

const signingSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the tool app signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
});

export const issueToolAppUrl = Effect.fn("ToolAppAccess.issueToolAppUrl")(function* (
  toolId: EnvironmentToolId,
  definition: WebEnvironmentTool,
) {
  const secret = yield* signingSecret;
  if (secret === null) return null;
  const expiresAt = (yield* Clock.currentTimeMillis) + TOOL_APP_TOKEN_TTL_MS;
  const claims: ToolAppClaims = {
    version: 1,
    kind: "tool-app",
    toolId,
    configHash: toolAppConfigHash(definition),
    expiresAt,
  };
  const encodedPayload = base64UrlEncode(encodeToolAppClaims(claims));
  const token = `${encodedPayload}.${signPayload(encodedPayload, secret)}`;
  return { relativeUrl: `${TOOL_APP_ROUTE_PREFIX}/${token}/`, expiresAt };
});

export const validateToolAppToken = Effect.fn("ToolAppAccess.validateToolAppToken")(function* (
  token: string,
) {
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return null;
  const secret = yield* signingSecret;
  if (secret === null) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) return null;
  let claims: ToolAppClaims | null;
  try {
    claims = Option.getOrNull(decodeToolAppClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
  if (claims === null || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return claims;
});
