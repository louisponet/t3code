import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { injectToolAppBootstrap } from "@t3tools/shared/toolApp";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentTools from "./EnvironmentTools.ts";
import { TOOL_APP_ROUTE_PREFIX, validateToolAppToken } from "./ToolAppAccess.ts";

class ToolAppHtmlTooLargeError extends Schema.TaggedError<ToolAppHtmlTooLargeError>()(
  "ToolAppHtmlTooLargeError",
  {},
) {}

const PROXY_RESPONSE_HEADERS = {
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};
const MAX_INJECTED_HTML_BYTES = 8 * 1024 * 1024;

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "referer",
  "proxy-authorization",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "content-length",
  // The client gets identity bytes; the outer compression middleware re-encodes.
  "accept-encoding",
]);

// Framing and isolation headers are the proxy's to set, never the upstream's:
// its own would refuse the frame or the frame's subresource loads.
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "trailer",
  "upgrade",
  "set-cookie",
  "clear-site-data",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
]);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const forwardHeaders = (request: HttpServerRequest.HttpServerRequest, origin: string) => {
  const headers: Record<string, string> = {};
  const connectionHeaders = new Set(
    request.headers.connection?.split(",").map((name) => name.trim().toLowerCase()),
  );
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || connectionHeaders.has(name) || value === undefined)
      continue;
    headers[name] = value;
  }
  if (request.headers.origin !== undefined) headers.origin = origin;
  return headers;
};

/**
 * Maps a path below the proxy root onto the tool's target. The target names
 * the app's root: a path ending in a file (index.html) serves that file at
 * the root and its siblings below it; any other path is the root directory.
 */
function appDirectory(target: URL): string {
  const pathname = target.pathname;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const isFile = lastSegment.includes(".");
  return isFile
    ? pathname.slice(0, pathname.lastIndexOf("/") + 1)
    : pathname.endsWith("/")
      ? pathname
      : `${pathname}/`;
}

function toolAppUpstreamUrl(target: URL, rest: string, search: string): string {
  const directory = appDirectory(target);
  const path =
    rest === "" && target.pathname !== directory.slice(0, -1)
      ? target.pathname
      : `${directory}${rest}`;
  const query = search === "" && rest === "" ? target.search : search;
  return `${target.origin}${path}${query}`;
}

function rewriteLocation(
  location: string,
  target: URL,
  upstreamUrl: string,
  proxyRoot: string,
): string {
  const resolved = URL.parse(location, upstreamUrl);
  if (resolved === null || resolved.origin !== target.origin) return location;
  const directory = appDirectory(target);
  if (resolved.pathname === target.pathname) {
    return `${proxyRoot}/${resolved.search}${resolved.hash}`;
  }
  if (!resolved.pathname.startsWith(directory)) return location;
  return `${proxyRoot}/${resolved.pathname.slice(directory.length)}${resolved.search}${resolved.hash}`;
}

const proxyWebSocket = Effect.fn("ToolAppProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  origin: string,
) {
  const protocols = request.headers["sec-websocket-protocol"]
    ?.split(",")
    .map((value) => value.trim());
  // Closing a connecting socket can emit after the Effect reader removes its error listener.
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() =>
      new NodeSocket.NodeWS.WebSocket(upstreamUrl, protocols, {
        headers: forwardHeaders(request, origin),
      }).on("error", () => {}),
    ),
    (socket) => Effect.sync(() => socket.close()),
  );
  const upstream = yield* Socket.fromWebSocket(Effect.succeed(socket), {
    openTimeout: "10 seconds",
  });
  const upstreamReader = yield* upstream.reader;
  // Node's upgrader selects from the raw offered header, so offer only the upstream's choice.
  const headers = NodeHttpServerRequest.toIncomingMessage(request).headers;
  if (socket.protocol) headers["sec-websocket-protocol"] = socket.protocol;
  else delete headers["sec-websocket-protocol"];
  const client = yield* request.upgrade;
  const clientReader = yield* client.reader;
  const writeToClient = yield* client.writer;
  const writeToUpstream = yield* upstream.writer;
  yield* Effect.raceFirst(
    pumpFrames(upstreamReader, writeToClient),
    pumpFrames(clientReader, writeToUpstream),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
}, Effect.scoped);

const pumpFrames = Effect.fnUntraced(function* ({ pull }: Socket.Reader, sink: Socket.Writer) {
  while (true) {
    yield* sink.writeAll(yield* pull);
  }
});

const proxyHttp = Effect.fn("ToolAppProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  target: URL,
  upstreamUrl: string,
  proxyRoot: string,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request, target.origin)),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* httpClient
    .execute(upstreamRequest)
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  const headers: Record<string, string> = {};
  const connectionHeaders = new Set(
    response.headers.connection?.split(",").map((name) => name.trim().toLowerCase()),
  );
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || connectionHeaders.has(name) || value === undefined)
      continue;
    headers[name] = value;
  }
  Object.assign(headers, PROXY_RESPONSE_HEADERS);
  const location = headers.location;
  if (location !== undefined)
    headers.location = rewriteLocation(location, target, upstreamUrl, proxyRoot);

  const contentType = headers["content-type"];
  const isHtml = contentType?.toLowerCase().startsWith("text/html") === true;
  if (isHtml && method === "GET") {
    const html = injectToolAppBootstrap(
      yield* Stream.limitBytes<HttpClientError.HttpClientError | ToolAppHtmlTooLargeError, never>(
        response.stream,
        ByteSize.bytes(MAX_INJECTED_HTML_BYTES),
        () => Stream.fail(new ToolAppHtmlTooLargeError()),
      ).pipe(Stream.decodeText(), Stream.mkString),
    );
    return HttpServerResponse.text(html, {
      status: response.status,
      headers,
      contentType: "text/html; charset=utf-8",
    });
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(contentType ? { contentType } : {}),
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const remainder = url.value.pathname.slice(`${TOOL_APP_ROUTE_PREFIX}/`.length);
  const separatorIndex = remainder.indexOf("/");
  const token = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex);
  const rest = separatorIndex === -1 ? "" : remainder.slice(separatorIndex + 1);
  if (token === "") {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const claims = yield* validateToolAppToken(token);
  if (claims === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const environmentTools = yield* EnvironmentTools.EnvironmentTools;
  const targetUrl = yield* environmentTools.webTargetUrl(claims.toolId, claims.configHash);
  const target = targetUrl === null ? null : URL.parse(targetUrl);
  if (target === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  if (separatorIndex === -1) {
    return HttpServerResponse.empty({
      status: 307,
      headers: { ...PROXY_RESPONSE_HEADERS, location: `${url.value.pathname}/${url.value.search}` },
    });
  }
  // An opaque origin's preflight carries nothing the upstream needs to answer.
  if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
    return HttpServerResponse.empty({
      status: 204,
      headers: {
        ...PROXY_RESPONSE_HEADERS,
        "access-control-allow-methods": request.headers["access-control-request-method"],
        ...(request.headers["access-control-request-headers"]
          ? { "access-control-allow-headers": request.headers["access-control-request-headers"] }
          : {}),
      },
    });
  }
  const upstreamUrl = toolAppUpstreamUrl(target, rest, url.value.search);
  if (isWebSocketUpgrade(request)) {
    return yield* proxyWebSocket(request, upstreamUrl.replace(/^http/, "ws"), target.origin);
  }
  return yield* proxyHttp(request, target, upstreamUrl, `${TOOL_APP_ROUTE_PREFIX}/${token}`).pipe(
    Effect.catchCause(() =>
      Effect.logWarning("Failed to reach the web tool's address.", { toolId: claims.toolId }).pipe(
        Effect.as(
          HttpServerResponse.text("The tool's address could not be reached.", {
            status: 502,
            headers: PROXY_RESPONSE_HEADERS,
          }),
        ),
      ),
    ),
  );
});

export const layer = HttpRouter.add("*", `${TOOL_APP_ROUTE_PREFIX}/*`, handler);
