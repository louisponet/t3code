import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { assert, expect, it } from "@effect/vitest";
import { EnvironmentToolId, type WebEnvironmentTool } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Real HTTP upstream fixture exercises the proxy transport.
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentTools from "./EnvironmentTools.ts";
import { issueToolAppUrl, toolAppConfigHash } from "./ToolAppAccess.ts";
import * as ToolAppProxy from "./ToolAppProxy.ts";

const TOOL_ID = EnvironmentToolId.make("dashboard");
const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
  getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(42)),
});
const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

const makeHarness = Effect.fnUntraced(function* (targetPath = "/app/index.html?theme=dark") {
  const fetch = yield* FetchHttpClient.Fetch;
  const requests: Array<{
    url: string | undefined;
    headers: NodeHttp.IncomingHttpHeaders;
    body: string;
  }> = [];
  const socketRequests: Array<NodeHttp.IncomingMessage> = [];
  const upstreamClosed = Promise.withResolvers<void>();
  const stalledUpgrade = Promise.withResolvers<void>();
  const stalledClosed = Promise.withResolvers<void>();
  const stalledRequests: Array<NodeHttp.IncomingMessage> = [];
  const upstream = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            requests.push({
              url: request.url,
              headers: request.headers,
              body: Buffer.concat(chunks).toString(),
            });
            if (request.url?.startsWith("/app/index.html")) {
              response.writeHead(200, {
                "content-type": "text/html",
                "content-security-policy": "frame-ancestors 'none'",
                "x-frame-options": "DENY",
                "set-cookie": "upstream=private",
                "clear-site-data": '"cookies", "storage"',
              });
              response.end(
                '<!doctype html><html><head><script src="main.js"></script></head><body>app</body></html>',
              );
            } else if (request.url === "/app/compressed.wasm") {
              const compressed = NodeZlib.gzipSync(wasm);
              response.writeHead(200, {
                "content-type": "application/wasm",
                "content-encoding": "gzip",
                "content-length": compressed.length,
              });
              response.end(compressed);
            } else if (request.url === "/app/nested/redirect") {
              response.writeHead(302, { location: "../index.html?next=1#view" });
              response.end();
            } else if (request.url === "/app/external") {
              response.writeHead(302, { location: "https://example.test/elsewhere" });
              response.end();
            } else if (request.url === "/app/image.svg") {
              response.writeHead(200, { "content-type": "image/svg+xml" });
              response.end(
                '<svg xmlns="http://www.w3.org/2000/svg"><script>window.ran = true</script></svg>',
              );
            } else if (request.url === "/app/empty") {
              response.writeHead(204);
              response.end();
            } else if (request.url === "/app/large.html") {
              response.writeHead(200, { "content-type": "text/html" });
              response.end("x".repeat(8 * 1024 * 1024 + 1));
            } else {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({ body: Buffer.concat(chunks).toString(), method: request.method }),
              );
            }
          });
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const request of stalledRequests) request.destroy();
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const sockets = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new NodeWS.WebSocketServer({
          server: upstream,
          handleProtocols: (protocols) => [...protocols].at(-1) ?? false,
          verifyClient(info, accept) {
            if (info.req.url === "/app/stalled") {
              stalledRequests.push(info.req);
              info.req.socket.once("end", () => info.req.socket.destroy());
              info.req.socket.once("close", () => stalledClosed.resolve());
              info.req.socket.resume();
              stalledUpgrade.resolve();
            } else accept(true);
          },
        }),
    ),
    (server) =>
      Effect.sync(() => {
        for (const client of server.clients) client.terminate();
        server.close();
      }),
  );
  sockets.on("connection", (socket, request) => {
    socketRequests.push(request);
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
    socket.on("close", () => upstreamClosed.resolve());
  });
  const address = upstream.address();
  if (address === null || typeof address === "string") return assert.fail("expected TCP server");
  const upstreamOrigin = `http://127.0.0.1:${address.port}`;
  const definition: WebEnvironmentTool = {
    kind: "web",
    name: "Dashboard",
    target: { kind: "url", url: `${upstreamOrigin}${targetPath}` },
  };
  let enabled = true;
  const environmentTools = Layer.mock(EnvironmentTools.EnvironmentTools)({
    webTargetUrl: (toolId, hash) =>
      Effect.succeed(
        enabled && toolId === TOOL_ID && hash === toolAppConfigHash(definition)
          ? definition.target.kind === "url"
            ? definition.target.url
            : null
          : null,
      ),
  });
  const services = yield* Layer.build(
    HttpRouter.serve(ToolAppProxy.layer, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" }),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(environmentTools),
      Layer.provide(secrets),
    ),
  );
  const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
  const issued = yield* issueToolAppUrl(TOOL_ID, definition).pipe(Effect.provide(secrets));
  if (issued === null) return assert.fail("expected access URL");
  const root = `${origin}${issued.relativeUrl}`;
  return {
    root,
    upstreamOrigin,
    requests,
    socketRequests,
    upstreamClosed: upstreamClosed.promise,
    stalledUpgrade: stalledUpgrade.promise,
    stalledClosed: stalledClosed.promise,
    disable: () => {
      enabled = false;
    },
    fetch,
    request: (path: string, init?: RequestInit) =>
      Effect.promise(() => fetch(`${root}${path}`, { redirect: "manual", ...init })),
  };
});

it.effect("forwards HTML, relative fetches and WASM without T3 credentials", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const page = yield* harness.request("", {
      headers: {
        cookie: "t3_session=private",
        authorization: "Bearer private",
        dpop: "private",
        referer: harness.root,
        origin: "null",
      },
    });
    const html = yield* Effect.promise(() => page.text());
    expect(html).toContain('src="main.js"');
    expect(html.indexOf("t3-tool-app:escape")).toBeLessThan(html.indexOf('src="main.js"'));
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("clear-site-data")).toBeNull();
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-downloads",
    );
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("access-control-allow-origin")).toBe("*");
    expect(harness.requests[0]?.url).toBe("/app/index.html?theme=dark");
    expect(harness.requests[0]?.headers).toMatchObject({ origin: harness.upstreamOrigin });
    for (const header of ["cookie", "authorization", "dpop", "referer"]) {
      expect(harness.requests[0]?.headers[header]).toBeUndefined();
    }
    const asset = yield* harness.request("compressed.wasm");
    expect(asset.headers.get("content-type")).toBe("application/wasm");
    expect(asset.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(yield* Effect.promise(() => asset.arrayBuffer()))).toEqual(wasm);
    const posted = yield* harness.request("api?query=1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"value":1}',
    });
    expect(yield* Effect.promise(() => posted.json())).toEqual({
      body: '{"value":1}',
      method: "PATCH",
    });
    expect(harness.requests[2]?.url).toBe("/app/api?query=1");
    expect(harness.requests[2]?.headers["content-type"]).toBe("application/json");
  }).pipe(Effect.scoped),
);

it.effect(
  "rewrites relative redirects without following them, and isolates non-HTML documents",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const redirected = yield* harness.request("nested/redirect");
      expect(redirected.status).toBe(302);
      expect(redirected.headers.get("location")).toBe(
        `${new URL(harness.root).pathname}?next=1#view`,
      );
      yield* Effect.promise(() => redirected.text());
      expect(harness.requests).toHaveLength(1);
      const external = yield* harness.request("external");
      expect(external.headers.get("location")).toBe("https://example.test/elsewhere");
      expect(external.headers.get("referrer-policy")).toBe("no-referrer");
      yield* Effect.promise(() => external.text());
      const svg = yield* harness.request("image.svg");
      expect(svg.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
      yield* Effect.promise(() => svg.text());
      const empty = yield* harness.request("empty");
      expect(empty.status).toBe(204);
      expect(yield* Effect.promise(() => empty.text())).toBe("");
    }).pipe(Effect.scoped),
);

it.effect("handles opaque-origin preflights locally and rejects stale or forged access", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const preflight = yield* harness.request("api", {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type,x-app",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("PATCH");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type,x-app");
    expect(harness.requests).toEqual([]);
    const missingSlash = yield* Effect.promise(() =>
      harness.fetch(harness.root.slice(0, -1), { redirect: "manual" }),
    );
    expect(missingSlash.status).toBe(307);
    expect(missingSlash.headers.get("location")).toBe(new URL(harness.root).pathname);
    const forged = yield* Effect.promise(() =>
      harness.fetch(harness.root.replace(/\/([^/]+)\/$/, "/forged/")),
    );
    expect(forged.status).toBe(404);
    harness.disable();
    const stale = yield* harness.request("api");
    expect(stale.status).toBe(404);
    expect(harness.requests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("bounds HTML buffering even when the upstream does not declare a length", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const response = yield* harness.request("large.html");
    expect(response.status).toBe(502);
    expect(yield* Effect.promise(() => response.text())).toBe(
      "The tool's address could not be reached.",
    );
  }).pipe(Effect.scoped),
);

it.effect("relays WebSocket text and binary frames and closes upstream with the client", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const received = Promise.withResolvers<Array<{ binary: boolean; data: string }>>();
    const messages: Array<{ binary: boolean; data: string }> = [];
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new NodeWS.WebSocket(
          `${harness.root}socket?channel=1`.replace(/^http/, "ws"),
          ["other-protocol", "tool-protocol"],
          {
            headers: {
              cookie: "t3_session=private",
              authorization: "Bearer private",
              referer: harness.root,
              origin: "null",
            },
          },
        );
        socket.on("error", received.reject);
        socket.on("open", () => {
          socket.send("text message");
          socket.send(new Uint8Array([1, 2, 3]));
        });
        socket.on("message", (data, binary) => {
          messages.push({ binary, data: data.toString() });
          if (messages.length === 2) received.resolve(messages);
        });
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    expect(yield* Effect.promise(() => received.promise)).toEqual([
      { binary: false, data: "text message" },
      { binary: true, data: "\u0001\u0002\u0003" },
    ]);
    expect(socket.protocol).toBe("tool-protocol");
    expect(harness.socketRequests[0]?.url).toBe("/app/socket?channel=1");
    expect(harness.socketRequests[0]?.headers.origin).toBe(harness.upstreamOrigin);
    expect(harness.socketRequests[0]?.headers["sec-websocket-protocol"]).toBe(
      "other-protocol,tool-protocol",
    );
    for (const header of ["cookie", "authorization", "referer"]) {
      expect(harness.socketRequests[0]?.headers[header]).toBeUndefined();
    }
    socket.close();
    yield* Effect.promise(() => harness.upstreamClosed);
  }).pipe(Effect.scoped),
);

it.effect("times out stalled upstream WebSocket handshakes without an unhandled error", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const rejected = Promise.withResolvers<Error>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new NodeWS.WebSocket(`${harness.root}stalled`.replace(/^http/, "ws"));
        socket.on("error", rejected.resolve);
        return socket;
      }),
      (socket) => Effect.sync(() => socket.terminate()),
    );
    yield* Effect.promise(() => harness.stalledUpgrade);
    yield* TestClock.adjust("10 seconds");
    expect((yield* Effect.promise(() => rejected.promise)).message).toContain(
      "Unexpected server response: 500",
    );
    yield* Effect.promise(() => harness.stalledClosed);
  }).pipe(Effect.scoped),
);
