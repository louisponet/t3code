import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { WebContents } from "electron";
import { beforeEach, vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({ showMessageBox: vi.fn() }));

vi.mock("electron", () => ({
  app: {},
  dialog: { showMessageBox: electron.showMessageBox },
  BrowserWindow: { fromWebContents: () => null },
  webContents: { fromFrame: () => undefined },
}));

import * as PreviewOnePassword from "./OnePassword.ts";
import type { FieldDescriptor, LoginSummary } from "./OnePassword.ts";
import { OnePasswordSession, type OpReply } from "./OnePasswordSession.ts";

const login = (id: string, ...urls: ReadonlyArray<string>): LoginSummary => ({
  id,
  title: id,
  subtitle: undefined,
  urls,
});

const field = (overrides: Partial<FieldDescriptor>): FieldDescriptor => ({
  type: "text",
  autocomplete: "",
  hint: "",
  inputMode: "",
  maxLength: -1,
  focused: false,
  ...overrides,
});

const ALL = new Set(["username", "password", "otp"] as const);

describe("matchLogins", () => {
  it("ranks the same origin, then the same host, then the same site", () => {
    const matches = PreviewOnePassword.matchLogins(
      [
        login("site", "https://google.com"),
        login("other", "https://example.com"),
        login("host", "http://accounts.google.com"),
        login("origin", "https://accounts.google.com/signin"),
      ],
      "https://accounts.google.com",
    );
    assert.deepStrictEqual(
      matches.map((match) => match.id),
      ["origin", "host", "site"],
    );
  });

  it("keeps sites under a private suffix apart", () => {
    const matches = PreviewOnePassword.matchLogins(
      [login("neighbour", "https://mallory.github.io"), login("own", "alice.github.io")],
      "https://alice.github.io",
    );
    assert.deepStrictEqual(
      matches.map((match) => match.id),
      ["own"],
    );
  });

  it("ignores URLs that are not web pages", () => {
    const matches = PreviewOnePassword.matchLogins(
      [login("app", "androidapp://com.google"), login("broken", "https://")],
      "https://google.com",
    );
    assert.deepStrictEqual(matches, []);
  });

  it("matches localhost by host only", () => {
    const matches = PreviewOnePassword.matchLogins(
      [login("dev", "http://localhost:3000"), login("ip", "http://127.0.0.1:3000")],
      "http://localhost:5173",
    );
    assert.deepStrictEqual(
      matches.map((match) => match.id),
      ["dev"],
    );
  });
});

describe("planFill", () => {
  it("fills Google's email step", () => {
    const plan = PreviewOnePassword.planFill(
      [
        field({
          type: "email",
          autocomplete: "username webauthn",
          hint: "identifier identifierId",
        }),
      ],
      ALL,
    );
    assert.deepStrictEqual(plan, [{ index: 0, field: "username" }]);
  });

  it("fills username and password together, in that order", () => {
    const plan = PreviewOnePassword.planFill(
      [field({ type: "password", autocomplete: "current-password" }), field({ hint: "login" })],
      ALL,
    );
    assert.deepStrictEqual(plan, [
      { index: 1, field: "username" },
      { index: 0, field: "password" },
    ]);
  });

  it("recognises a code field by autocomplete or hint", () => {
    assert.deepStrictEqual(
      PreviewOnePassword.planFill([field({ type: "tel", hint: "totpPin totpPin" })], ALL),
      [{ index: 0, field: "otp" }],
    );
    assert.deepStrictEqual(
      PreviewOnePassword.planFill([field({ autocomplete: "one-time-code" })], ALL),
      [{ index: 0, field: "otp" }],
    );
  });

  it("treats an unrecognised focused field by its shape", () => {
    assert.deepStrictEqual(
      PreviewOnePassword.planFill([field({ inputMode: "numeric", focused: true })], ALL),
      [{ index: 0, field: "otp" }],
    );
    assert.deepStrictEqual(PreviewOnePassword.planFill([field({ focused: true })], ALL), [
      { index: 0, field: "username" },
    ]);
  });

  it("prefers the focused field over an earlier one of the same kind", () => {
    const plan = PreviewOnePassword.planFill(
      [field({ type: "email" }), field({ type: "email", focused: true })],
      ALL,
    );
    assert.deepStrictEqual(plan, [{ index: 1, field: "username" }]);
  });

  it("leaves new-password fields and missing credentials alone", () => {
    const fields = [
      field({ type: "password", autocomplete: "new-password" }),
      field({ autocomplete: "one-time-code" }),
    ];
    assert.deepStrictEqual(PreviewOnePassword.planFill(fields, new Set(["password"])), []);
  });
});

describe("credentialsFromItem", () => {
  it("reads the username, password, and current code", () => {
    assert.deepStrictEqual(
      PreviewOnePassword.credentialsFromItem({
        fields: [
          { type: "STRING", purpose: "NOTES", value: "note" },
          { type: "STRING", purpose: "USERNAME", value: "ada@example.com" },
          { type: "CONCEALED", purpose: "PASSWORD", value: "hunter2" },
          { type: "OTP", value: "otpauth://totp/x?secret=ABC", totp: "123456" },
        ],
      }),
      { username: "ada@example.com", password: "hunter2", otp: "123456" },
    );
  });
});

interface OpScript {
  readonly list?: { readonly exitCode: number; readonly stdout?: string } | "missing";
  readonly item?: string;
}

const sessionLayer = (
  run: (args: ReadonlyArray<string>) => OpReply,
  calls: Array<ReadonlyArray<string>>,
) =>
  Layer.succeed(OnePasswordSession, {
    run: (command, args) =>
      Effect.sync(() => {
        assert.strictEqual(command, "op");
        calls.push(args);
        return run(args);
      }),
  });

const layerFor = (script: OpScript, calls: Array<ReadonlyArray<string>>) =>
  PreviewOnePassword.layer.pipe(
    Layer.provide(
      sessionLayer((args): OpReply => {
        if (args[1] === "list") {
          const list = script.list ?? { exitCode: 0, stdout: "[]" };
          if (list === "missing") return { _tag: "NotFound" };
          return { _tag: "Exited", exitCode: list.exitCode, stdout: list.stdout ?? "" };
        }
        return { _tag: "Exited", exitCode: 0, stdout: script.item ?? "{}" };
      }, calls),
    ),
  );

const fakeGuest = (origin: string, fields: ReadonlyArray<FieldDescriptor>) => {
  const inserted: Array<string> = [];
  const mainFrame = { origin };
  const guest = {
    mainFrame,
    isDestroyed: () => false,
    hostWebContents: undefined,
    focus: vi.fn(),
    insertText: async (text: string) => {
      inserted.push(text);
    },
    executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: [{ code: string }]) =>
      code.includes("querySelectorAll") ? fields : true,
  };
  return { guest: guest as unknown as WebContents, inserted, mainFrame };
};

const LIST = JSON.stringify([
  {
    id: "g1",
    title: "Google",
    additional_information: "ada@example.com",
    urls: [{ href: "https://accounts.google.com" }],
  },
  { id: "x1", title: "Example", urls: [{ href: "https://example.com" }] },
]);
const ITEM = JSON.stringify({
  fields: [
    { purpose: "USERNAME", value: "ada@example.com" },
    { purpose: "PASSWORD", value: "hunter2" },
    { type: "OTP", value: "otpauth://totp/x?secret=ABC", totp: "123456" },
  ],
});

const fill = (guest: WebContents, holdAgentCommands = () => () => {}) =>
  Effect.flatMap(PreviewOnePassword.PreviewOnePassword, (service) =>
    service.fill(guest, holdAgentCommands),
  );

describe("PreviewOnePassword.fill", () => {
  beforeEach(() => {
    electron.showMessageBox.mockReset();
  });

  it.effect("fills the matching login into the detected fields while agents are held", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const { guest, inserted } = fakeGuest("https://accounts.google.com", [
      field({ type: "password", autocomplete: "current-password" }),
      field({ type: "tel", hint: "totpPin" }),
    ]);
    const events: Array<string> = [];
    let held = false;
    const insertText = guest.insertText.bind(guest);
    Object.assign(guest, {
      insertText: (text: string) => {
        events.push(held ? "insert held" : "insert free");
        return insertText(text);
      },
    });
    const hold = () => {
      held = true;
      events.push("hold");
      return () => {
        held = false;
        events.push("release");
      };
    };
    return fill(guest, hold).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.strictEqual(result, "filled");
          assert.deepStrictEqual(events, ["hold", "insert held", "insert held", "release"]);
          assert.deepStrictEqual(inserted, ["hunter2", "123456"]);
          assert.deepStrictEqual(calls[1], ["item", "get", "g1", "--format", "json", "--reveal"]);
          assert.strictEqual(electron.showMessageBox.mock.calls.length, 0);
        }),
      ),
      Effect.provide(layerFor({ list: { exitCode: 0, stdout: LIST }, item: ITEM }, calls)),
    );
  });

  it.effect("asks each time several logins match, preselecting the last choice", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const list = JSON.stringify([
      { id: "a", title: "Work", urls: [{ href: "https://google.com" }] },
      { id: "b", title: "Personal", urls: [{ href: "https://google.com" }] },
    ]);
    // Sorted by title: Personal, Work.
    electron.showMessageBox.mockResolvedValue({ response: 1 });
    const { guest } = fakeGuest("https://accounts.google.com", [field({ type: "email" })]);
    const defaultIds = () =>
      electron.showMessageBox.mock.calls.map(
        (args: ReadonlyArray<unknown>) => (args.at(-1) as { defaultId: number }).defaultId,
      );
    return Effect.gen(function* () {
      assert.strictEqual(yield* fill(guest), "filled");
      assert.strictEqual(yield* fill(guest), "filled");
      assert.deepStrictEqual(defaultIds(), [0, 1]);
      assert.deepStrictEqual(
        calls.filter((args) => args[1] === "get").map((args) => args[2]),
        ["a", "a"],
      );
    }).pipe(Effect.provide(layerFor({ list: { exitCode: 0, stdout: list }, item: ITEM }, calls)));
  });

  it.effect("says when the login has nothing for the page's fields", () => {
    const { guest, inserted } = fakeGuest("https://accounts.google.com", [
      field({ type: "password", autocomplete: "current-password" }),
    ]);
    const item = JSON.stringify({ fields: [{ purpose: "USERNAME", value: "ada@example.com" }] });
    return fill(guest).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.strictEqual(result, "missing-credentials");
          assert.deepStrictEqual(inserted, []);
        }),
      ),
      Effect.provide(layerFor({ list: { exitCode: 0, stdout: LIST }, item }, [])),
    );
  });

  it.effect("reports a locked CLI without reading any item", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const { guest, inserted } = fakeGuest("https://example.com", [field({ type: "email" })]);
    return fill(guest).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.strictEqual(result, "locked");
          assert.strictEqual(calls.length, 1);
          assert.deepStrictEqual(inserted, []);
        }),
      ),
      Effect.provide(layerFor({ list: { exitCode: 1 } }, calls)),
    );
  });

  it.effect("reports a missing CLI", () => {
    const { guest } = fakeGuest("https://example.com", []);
    return fill(guest).pipe(
      Effect.tap((result) => Effect.sync(() => assert.strictEqual(result, "not-installed"))),
      Effect.provide(layerFor({ list: "missing" }, [])),
    );
  });

  it.effect("refuses pages that are not secure without running op", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const { guest } = fakeGuest("http://example.com", [field({ type: "email" })]);
    return fill(guest).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.strictEqual(result, "insecure-page");
          assert.deepStrictEqual(calls, []);
        }),
      ),
      Effect.provide(layerFor({}, calls)),
    );
  });

  it.effect("does not fill a page that navigated during the lookup", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const { guest, inserted, mainFrame } = fakeGuest("https://accounts.google.com", [
      field({ type: "email" }),
    ]);
    const layer = PreviewOnePassword.layer.pipe(
      Layer.provide(
        sessionLayer((args): OpReply => {
          if (args[1] === "get") mainFrame.origin = "https://evil.example";
          return { _tag: "Exited", exitCode: 0, stdout: args[1] === "list" ? LIST : ITEM };
        }, calls),
      ),
    );
    return fill(guest).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.strictEqual(result, "cancelled");
          assert.deepStrictEqual(inserted, []);
        }),
      ),
      Effect.provide(layer),
    );
  });
});
