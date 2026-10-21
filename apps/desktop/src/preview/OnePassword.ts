import type { DesktopPreviewPasswordFillResult } from "@t3tools/contracts";
import type { WebContents } from "electron";
import { BrowserWindow, dialog } from "electron";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { getDomain } from "tldts";

import { isTrustworthyOrigin } from "./Passkeys.ts";

export type FillField = "username" | "password" | "otp";

export interface LoginSummary {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | undefined;
  readonly urls: ReadonlyArray<string>;
}

/** What the page script reports about one visible, editable input. Never holds its value. */
export interface FieldDescriptor {
  readonly type: string;
  readonly autocomplete: string;
  /** Name, id, placeholder, ARIA label, and label text. */
  readonly hint: string;
  readonly inputMode: string;
  readonly maxLength: number;
  readonly focused: boolean;
}

export type Credentials = Partial<Record<FillField, string>>;

const FIELD_ORDER: ReadonlyArray<FillField> = ["username", "password", "otp"];

// A host such as `user.github.io` is its own site, so it never borrows
// credentials saved for another one under the same private suffix.
const siteOf = (hostname: string) => getDomain(hostname, { allowPrivateDomains: true });

const parseItemUrl = (href: string) => {
  const candidate = href.includes("://") ? href : `https://${href}`;
  if (!URL.canParse(candidate)) return undefined;
  const url = new URL(candidate);
  return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
};

/** 0 same origin, 1 same host, 2 same registrable domain. */
const matchRank = (href: string, page: URL) => {
  const url = parseItemUrl(href);
  if (!url) return undefined;
  if (url.origin === page.origin) return 0;
  if (url.hostname === page.hostname) return 1;
  const site = siteOf(page.hostname);
  return site !== null && siteOf(url.hostname) === site ? 2 : undefined;
};

/** Logins saved for the page's committed origin, closest match first. */
export const matchLogins = (
  items: ReadonlyArray<LoginSummary>,
  origin: string,
): ReadonlyArray<LoginSummary> => {
  const page = new URL(origin);
  return items
    .flatMap((item) => {
      const ranks = item.urls.flatMap((href) => matchRank(href, page) ?? []);
      return ranks.length === 0 ? [] : [{ item, rank: Math.min(...ranks) }];
    })
    .toSorted((a, b) => a.rank - b.rank || a.item.title.localeCompare(b.item.title))
    .map(({ item }) => item);
};

const OTP_HINT =
  /one[-_ ]?time|\botp\b|totp|2fa|mfa|two[-_ ]?(?:factor|step)|verification|security[-_ ]?code|\bpin\b|\bcode\b/iu;
const USERNAME_HINT = /user|e-?mail|login|identifier|account/iu;

const classifyField = (field: FieldDescriptor): FillField | undefined => {
  const autocomplete = field.autocomplete.toLowerCase().split(/\s+/u);
  if (autocomplete.includes("one-time-code")) return "otp";
  if (field.type === "password") {
    return autocomplete.includes("new-password") ? undefined : "password";
  }
  if (autocomplete.includes("username") || autocomplete.includes("email")) return "username";
  if (field.type === "email") return "username";
  if (OTP_HINT.test(field.hint)) return "otp";
  if (USERNAME_HINT.test(field.hint)) return "username";
  return undefined;
};

const looksNumeric = (field: FieldDescriptor) =>
  field.type === "tel" ||
  field.type === "number" ||
  field.inputMode === "numeric" ||
  (field.maxLength >= 4 && field.maxLength <= 8);

/**
 * Which input gets which credential. The focused input wins its kind; an
 * unrecognised focused input is taken as the code field when it looks numeric,
 * otherwise as the username.
 */
export const planFill = (
  fields: ReadonlyArray<FieldDescriptor>,
  available: ReadonlySet<FillField>,
): ReadonlyArray<{ readonly index: number; readonly field: FillField }> => {
  const chosen = new Map<FillField, number>();
  const focusedIndex = fields.findIndex((field) => field.focused);
  const focused = fields[focusedIndex];
  if (focused) {
    const kind = classifyField(focused) ?? (looksNumeric(focused) ? "otp" : "username");
    chosen.set(kind, focusedIndex);
  }
  fields.forEach((field, index) => {
    const kind = classifyField(field);
    if (kind && !chosen.has(kind)) chosen.set(kind, index);
  });
  return FIELD_ORDER.flatMap((field) => {
    const index = chosen.get(field);
    return index === undefined || !available.has(field) ? [] : [{ index, field }];
  });
};

const OpLoginList = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    additional_information: Schema.optional(Schema.String),
    urls: Schema.optional(Schema.Array(Schema.Struct({ href: Schema.String }))),
  }),
);
const decodeLoginList = Schema.decodeUnknownEffect(Schema.fromJsonString(OpLoginList));

const OpItem = Schema.Struct({
  fields: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        purpose: Schema.optional(Schema.String),
        value: Schema.optional(Schema.String),
        totp: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OpItem));

export const credentialsFromItem = (item: typeof OpItem.Type): Credentials => {
  const fields = item.fields ?? [];
  const username = fields.find((field) => field.purpose === "USERNAME")?.value;
  const password = fields.find((field) => field.purpose === "PASSWORD")?.value;
  const otp = fields.find((field) => field.type === "OTP" && field.totp)?.totp;
  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(otp ? { otp } : {}),
  };
};

/** Carries no `op` output: stdout may hold secrets, and stderr is not needed to act. */
export class OnePasswordCliError extends Schema.TaggedError<OnePasswordCliError>()(
  "OnePasswordCliError",
  {
    reason: Schema.Literals(["not-installed", "locked", "failed"]),
    exitCode: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `1Password CLI ${this.reason}${this.exitCode === undefined ? "" : ` (exit ${this.exitCode})`}.`;
  }
}

const FILL_WORLD_ID = 1003;
const FIELDS_KEY = "__t3codeOnePasswordFields";
const OP_TIMEOUT = "2 minutes";
// Multi-step sign-ins (Google asks for the email, password, and code on
// separate pages) reuse the login picked a moment ago instead of asking again.
const REMEMBERED_CHOICE_MS = 5 * 60 * 1000;

/**
 * Runs in an isolated world, so the page cannot tamper with detection. The
 * inputs stay in that world for {@link focusFieldScript}; only descriptors leave.
 */
const collectFieldsScript = (origin: string) => `(() => {
  if (location.origin !== ${JSON.stringify(origin)}) return null;
  const TYPES = new Set(["text", "email", "tel", "number", "password", "search", "url"]);
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && Number(style.opacity) > 0.05;
  };
  const inputs = [...document.querySelectorAll("input")].filter(
    (el) => TYPES.has(el.type) && !el.disabled && !el.readOnly && visible(el),
  );
  globalThis[${JSON.stringify(FIELDS_KEY)}] = inputs;
  return inputs.map((el) => ({
    type: el.type,
    autocomplete: el.getAttribute("autocomplete") ?? "",
    hint: [el.name, el.id, el.placeholder, el.getAttribute("aria-label") ?? "",
      ...[...(el.labels ?? [])].map((label) => label.textContent ?? "")].join(" ").slice(0, 300),
    inputMode: el.inputMode,
    maxLength: el.maxLength,
    focused: el === document.activeElement,
  }));
})()`;

const focusFieldScript = (origin: string, index: number) => `(() => {
  const el = globalThis[${JSON.stringify(FIELDS_KEY)}]?.[${index}];
  if (!el || !el.isConnected || location.origin !== ${JSON.stringify(origin)}) return false;
  el.focus();
  el.select();
  return document.activeElement === el;
})()`;

const chooseLogin = async (
  guest: WebContents,
  origin: string,
  logins: ReadonlyArray<LoginSummary>,
) => {
  const options: Electron.MessageBoxOptions = {
    type: "none",
    message: "Fill from 1Password",
    detail: origin,
    buttons: [
      ...logins.map((login) =>
        login.subtitle ? `${login.title} (${login.subtitle})` : login.title,
      ),
      "Cancel",
    ],
    cancelId: logins.length,
    defaultId: 0,
    noLink: true,
  };
  const parent = guest.hostWebContents
    ? BrowserWindow.fromWebContents(guest.hostWebContents)
    : null;
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return logins[response];
};

export class PreviewOnePassword extends Context.Service<
  PreviewOnePassword,
  {
    /** Human-triggered only: callers must not expose this to agents or preview automation. */
    readonly fill: (guest: WebContents) => Effect.Effect<DesktopPreviewPasswordFillResult>;
  }
>()("@t3tools/desktop/preview/OnePassword/PreviewOnePassword") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pending = new WeakSet<WebContents>();
  const remembered = new WeakMap<
    WebContents,
    { readonly origin: string; readonly id: string; readonly at: number }
  >();

  const runOp = (args: ReadonlyArray<string>, onFailure: "locked" | "failed") =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("op", args, { stdin: "ignore", stderr: "ignore", extendEnv: true }),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return yield* new OnePasswordCliError({ reason: onFailure, exitCode });
        }
        return stdout;
      }),
    ).pipe(
      Effect.timeout(OP_TIMEOUT),
      Effect.mapError((error) =>
        error._tag === "OnePasswordCliError"
          ? error
          : new OnePasswordCliError({
              reason:
                error._tag === "PlatformError" && error.reason._tag === "NotFound"
                  ? "not-installed"
                  : "failed",
            }),
      ),
    );

  const listLogins = runOp(
    ["item", "list", "--categories", "Login", "--format", "json"],
    "locked",
  ).pipe(
    Effect.flatMap((stdout) =>
      decodeLoginList(stdout).pipe(
        Effect.mapError(() => new OnePasswordCliError({ reason: "failed" })),
      ),
    ),
    Effect.map((items) =>
      items.map((item): LoginSummary => ({
        id: item.id,
        title: item.title,
        subtitle: item.additional_information || undefined,
        urls: (item.urls ?? []).map((url) => url.href),
      })),
    ),
  );

  // Decode failures drop their cause: a schema issue can quote the item's values.
  const getCredentials = (id: string) =>
    runOp(["item", "get", id, "--format", "json", "--reveal"], "failed").pipe(
      Effect.flatMap((stdout) =>
        decodeItem(stdout).pipe(
          Effect.mapError(() => new OnePasswordCliError({ reason: "failed" })),
        ),
      ),
      Effect.map(credentialsFromItem),
    );

  const pickLogin = (
    guest: WebContents,
    origin: string,
    logins: ReadonlyArray<LoginSummary>,
    now: number,
  ) => {
    const previous = remembered.get(guest);
    const reuse =
      previous && previous.origin === origin && now - previous.at < REMEMBERED_CHOICE_MS
        ? logins.find((login) => login.id === previous.id)
        : undefined;
    if (reuse || logins.length === 1) return Effect.succeed(reuse ?? logins[0]);
    return Effect.promise(() => chooseLogin(guest, origin, logins)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
  };

  const sameDocument = (guest: WebContents, origin: string) =>
    !guest.isDestroyed() && guest.mainFrame.origin === origin;

  const fillFields = Effect.fn("PreviewOnePassword.fillFields")(function* (
    guest: WebContents,
    origin: string,
    credentials: Credentials,
  ) {
    const fields = yield* Effect.promise(
      () =>
        guest.executeJavaScriptInIsolatedWorld(FILL_WORLD_ID, [
          { code: collectFieldsScript(origin) },
        ]) as Promise<ReadonlyArray<FieldDescriptor> | null>,
    );
    if (fields === null) return "cancelled" as const;
    const available = new Set(FIELD_ORDER.filter((field) => credentials[field]));
    const plan = planFill(fields, available);
    if (plan.length === 0) return "no-fields" as const;
    for (const step of plan) {
      const value = credentials[step.field];
      if (!value || !sameDocument(guest, origin)) return "cancelled" as const;
      const focused = yield* Effect.promise(
        () =>
          guest.executeJavaScriptInIsolatedWorld(FILL_WORLD_ID, [
            { code: focusFieldScript(origin, step.index) },
          ]) as Promise<boolean>,
      );
      // insertText is trusted input to the guest's own widget, so frameworks
      // that ignore synthetic events still see it, and it never reaches the app.
      if (focused) yield* Effect.promise(() => guest.insertText(value));
    }
    guest.focus();
    return "filled" as const;
  });

  const fill = Effect.fn("PreviewOnePassword.fill")(function* (guest: WebContents) {
    if (pending.has(guest) || guest.isDestroyed()) return "cancelled" as const;
    // Read before any await: the page cannot claim an origin, and a navigation
    // during the lookup must not redirect the fill.
    const origin = guest.mainFrame.origin;
    if (!isTrustworthyOrigin(origin)) return "insecure-page" as const;
    pending.add(guest);
    return yield* Effect.gen(function* () {
      const logins = matchLogins(yield* listLogins, origin);
      if (logins.length === 0) return "no-match" as const;
      const now = yield* Clock.currentTimeMillis;
      const login = yield* pickLogin(guest, origin, logins, now);
      if (!login) return "cancelled" as const;
      const credentials = yield* getCredentials(login.id);
      if (!sameDocument(guest, origin)) return "cancelled" as const;
      remembered.set(guest, { origin, id: login.id, at: now });
      return yield* fillFields(guest, origin, credentials);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("1Password fill failed", {
          reason: error.reason,
          exitCode: error.exitCode,
        }).pipe(Effect.as(error.reason)),
      ),
      Effect.catchDefect(() => Effect.succeed("failed" as const)),
      Effect.ensuring(Effect.sync(() => pending.delete(guest))),
    );
  });

  return PreviewOnePassword.of({ fill });
}).pipe(Effect.withSpan("PreviewOnePassword.make"));

export const layer = Layer.effect(PreviewOnePassword, make);
