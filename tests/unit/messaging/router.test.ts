import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newKdfParams } from "../../../src/lib/crypto/kdf";
import { createPageHandlers } from "../../../src/lib/messaging/page-handlers";
import {
  MAX_MESSAGE_CHARS,
  MessagingError,
  parsePageRequest,
  sendToSw,
} from "../../../src/lib/messaging/protocol";
import {
  classifySender,
  createRouter,
  toRuntimeListener,
  type ContentHandlers,
  type PageHandlers,
} from "../../../src/lib/messaging/router";
import { createContentHandlers } from "../../../src/lib/messaging/content-handlers";
import { upsertSite } from "../../../src/lib/sites";
import { installShims } from "../helpers/browser-shims";
import { __resetForTests } from "../../../src/lib/vault/vault";

const SLOW = { timeout: 30_000 };
const P = "correct horse battery staple";
const ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
const REJECTED = { ok: false, error: "rejected" };
const INTERNAL = { ok: false, error: "internal" };

type Sender = Parameters<typeof classifySender>[0];
/** Test senders: unset members are omitted, as Chrome omits them (exactOptionalPropertyTypes). */
const mk = (o: Record<string, unknown>): Sender => {
  const clean = Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  );
  return clean as Sender;
};
const tab = (url?: string) => ({ id: 1, url }) as unknown as Sender["tab"];

const popup: Sender = { id: ID, url: `chrome-extension://${ID}/popup.html` };
const content: Sender = mk({
  id: ID,
  url: "https://example.com/form",
  origin: "https://example.com",
  frameId: 0,
  tab: tab("https://example.com/form"),
});

function spyHandlers() {
  const h = {
    "vault-status": vi.fn(async () => ({ state: "none" })),
    "vault-create": vi.fn(async () => ({ ok: true })),
    "vault-unlock": vi.fn(async () => ({ ok: true })),
    "vault-lock": vi.fn(async () => ({ ok: true })),
    "site-status": vi.fn(async () => ({ origin: null })),
    "site-enable": vi.fn(async () => ({ ok: true })),
    "site-remove": vi.fn(async () => ({ ok: true })),
    "site-intent": vi.fn(async () => ({ ok: true })),
    "record-start": vi.fn(async () => ({ ok: true })),
    "record-state": vi.fn(async () => ({ state: "off" })),
    "record-finish": vi.fn(async () => ({ ok: false })),
    "record-cancel": vi.fn(async () => ({ ok: true })),
    "review-load": vi.fn(async () => ({ state: "gone" })),
    "review-save": vi.fn(async () => ({ ok: true })),
    "review-discard": vi.fn(async () => ({ ok: true })),
    "review-check": vi.fn(async () => ({ state: "gone" })),
    "saved-summary": vi.fn(async () => ({ state: "none" })),
    "saved-load": vi.fn(async () => ({ state: "gone" })),
    "saved-save": vi.fn(async () => ({ ok: true })),
    "saved-check": vi.fn(async () => ({ state: "gone" })),
  };
  const c = {
    "scan-report": vi.fn(async () => ({ state: "none" })),
    "fill-result": vi.fn(async () => ({ ok: true })),
    "record-status": vi.fn(async () => ({ state: "off" })),
    "record-capture": vi.fn(async () => ({ state: "off" })),
    "record-finish": vi.fn(async () => ({ ok: false })),
  };
  return {
    h,
    c,
    handlers: { page: h, content: c } as {
      page: PageHandlers;
      content: ContentHandlers;
    },
  };
}

beforeEach(() => {
  fakeBrowser.reset();
  __resetForTests();
  vi.restoreAllMocks();
  // The router reads the runtime id at call time.
  (fakeBrowser.runtime as { id: string }).id = ID;
});

describe("classifySender", () => {
  it("popup (no tab) is a page", () => {
    expect(classifySender(popup, ID)).toBe("page");
  });

  it("an extension page opened as a tab is a page", () => {
    const s = mk({
      ...popup,
      tab: tab(`chrome-extension://${ID}/onboarding.html`),
    });
    expect(classifySender(s, ID)).toBe("page");
  });

  it("an extension page framed in a web page is not a page", () => {
    const s = mk({ ...popup, frameId: 3, tab: tab("https://evil.example/") });
    expect(classifySender(s, ID)).toBeNull();
  });

  it("a tab whose url is unknown does not count as a page", () => {
    const s = mk({ ...popup, tab: tab() });
    expect(classifySender(s, ID)).toBeNull();
  });

  it("an https top-frame content script is content", () => {
    expect(classifySender(content, ID)).toBe("content");
  });

  it("sender with another extension id is rejected", () => {
    expect(classifySender({ ...popup, id: OTHER }, ID)).toBeNull();
    expect(classifySender({ ...content, id: OTHER }, ID)).toBeNull();
    expect(classifySender(mk({ url: popup.url }), ID)).toBeNull();
  });

  it("page URL from a different extension id is rejected", () => {
    const s: Sender = { id: ID, url: `chrome-extension://${OTHER}/popup.html` };
    expect(classifySender(s, ID)).toBeNull();
    // Prefix must include the slash: a longer id sharing our id as a prefix is not us.
    expect(
      classifySender(
        { id: ID, url: `chrome-extension://${ID}x/popup.html` },
        ID,
      ),
    ).toBeNull();
  });

  it("a falsy runtime id classifies nothing, even a sender with no id", () => {
    expect(classifySender(mk({ url: "chrome-extension:///x" }), "")).toBeNull();
    expect(
      classifySender(mk({ id: "", url: "chrome-extension:///popup.html" }), ""),
    ).toBeNull();
    expect(
      classifySender(mk({ id: undefined, origin: "https://a.example" }), ""),
    ).toBeNull();
  });

  it("a page whose origin is present must be this extension's origin", () => {
    expect(
      classifySender({ ...popup, origin: `chrome-extension://${ID}` }, ID),
    ).toBe("page");
    expect(
      classifySender({ ...popup, origin: `chrome-extension://${OTHER}` }, ID),
    ).toBeNull();
    expect(
      classifySender({ ...popup, origin: "https://evil.example" }, ID),
    ).toBeNull();
    expect(classifySender({ ...popup, origin: "null" }, ID)).toBeNull();
  });

  it("sender.frameId 1 is not content", () => {
    expect(classifySender({ ...content, frameId: 1 }, ID)).toBeNull();
    expect(
      classifySender(mk({ ...content, frameId: undefined }), ID),
    ).toBeNull();
  });

  it("http:// origin is not content", () => {
    expect(
      classifySender({ ...content, origin: "http://example.com" }, ID),
    ).toBeNull();
    expect(
      classifySender(mk({ ...content, origin: undefined }), ID),
    ).toBeNull();
  });

  it("content needs a tab", () => {
    expect(classifySender(mk({ ...content, tab: undefined }), ID)).toBeNull();
  });
});

describe("parsePageRequest", () => {
  it("accepts the four request shapes", () => {
    expect(parsePageRequest({ type: "vault-status" })).toEqual({
      type: "vault-status",
    });
    expect(parsePageRequest({ type: "vault-lock" })).toEqual({
      type: "vault-lock",
    });
    expect(parsePageRequest({ type: "vault-unlock", passphrase: "x" })).toEqual(
      {
        type: "vault-unlock",
        passphrase: "x",
      },
    );
    expect(parsePageRequest({ type: "vault-create", passphrase: P })).toEqual({
      type: "vault-create",
      passphrase: P,
    });
  });

  it("accepts a 1024-char passphrase and rejects 1025", () => {
    expect(
      parsePageRequest({ type: "vault-unlock", passphrase: "a".repeat(1024) }),
    ).not.toBeNull();
    expect(
      parsePageRequest({ type: "vault-unlock", passphrase: "a".repeat(1025) }),
    ).toBeNull();
  });

  it.each([
    ["non-object", "vault-lock"],
    ["null", null],
    ["array", [{ type: "vault-lock" }]],
    ["unknown type", { type: "vault-delete" }],
    ["inherited type", { type: "toString" }],
    ["non-string type", { type: 1 }],
    ["missing passphrase", { type: "vault-unlock" }],
    ["non-string passphrase", { type: "vault-unlock", passphrase: 5 }],
    ["passphrase on status", { type: "vault-status", passphrase: "x" }],
    ["extra key", { type: "vault-lock", x: 1 }],
    [
      "extra key with passphrase",
      { type: "vault-create", passphrase: P, now: 1 },
    ],
    [
      "class instance",
      new (class A {
        type = "vault-lock";
      })(),
    ],
  ])("rejects %s", (_name, raw) => {
    expect(parsePageRequest(raw)).toBeNull();
  });

  it("rejects a JSON-parsed __proto__ key", () => {
    expect(
      parsePageRequest(JSON.parse('{"type":"vault-lock","__proto__":{}}')),
    ).toBeNull();
  });

  it("returns a fresh object", () => {
    const raw = { type: "vault-unlock", passphrase: "x" };
    expect(parsePageRequest(raw)).not.toBe(raw);
  });
});

describe("site requests", () => {
  const SITE = "https://a.example";
  const long = "https://" + "a".repeat(249); // 257 chars
  const exact = "https://" + "a".repeat(248); // 256 chars

  it("parses the four shapes with exact keys", () => {
    expect(parsePageRequest({ type: "site-status", origin: SITE })).toEqual({
      type: "site-status",
      origin: SITE,
    });
    expect(parsePageRequest({ type: "site-remove", origin: SITE })).toEqual({
      type: "site-remove",
      origin: SITE,
    });
    expect(
      parsePageRequest({ type: "site-enable", tabId: 3, origin: SITE }),
    ).toEqual({ type: "site-enable", tabId: 3, origin: SITE });
    expect(
      parsePageRequest({
        type: "site-intent",
        tabId: 0,
        origin: SITE,
        kind: "enable",
      }),
    ).toEqual({ type: "site-intent", tabId: 0, origin: SITE, kind: "enable" });
  });

  it("accepts a 256-char origin string and rejects 257", () => {
    expect(exact).toHaveLength(256);
    expect(long).toHaveLength(257);
    for (const type of ["site-status", "site-remove"]) {
      expect(parsePageRequest({ type, origin: exact })).not.toBeNull();
      expect(parsePageRequest({ type, origin: long })).toBeNull();
    }
    for (const type of ["site-enable", "site-intent", "record-start"]) {
      const kind = type === "site-intent" ? { kind: "record" } : {};
      expect(
        parsePageRequest({ type, tabId: 1, origin: exact, ...kind }),
      ).not.toBeNull();
      expect(
        parsePageRequest({ type, tabId: 1, origin: long, ...kind }),
      ).toBeNull();
    }
  });

  it.each([
    ["status without origin", { type: "site-status" }],
    ["status with a number origin", { type: "site-status", origin: 5 }],
    ["status with extra key", { type: "site-status", origin: SITE, x: 1 }],
    ["remove with tabId", { type: "site-remove", origin: SITE, tabId: 1 }],
    ["enable without tabId", { type: "site-enable", origin: SITE }],
    [
      "enable with a timestamp",
      { type: "site-enable", tabId: 1, origin: SITE, ts: 1 },
    ],
    [
      "intent without origin",
      { type: "site-intent", tabId: 1, kind: "enable" },
    ],
    ["intent without kind", { type: "site-intent", tabId: 1, origin: SITE }],
    ["negative tabId", { type: "site-enable", tabId: -1, origin: SITE }],
    [
      "fractional tabId",
      { type: "site-intent", tabId: 1.5, origin: SITE, kind: "enable" },
    ],
    [
      "NaN tabId",
      { type: "site-intent", tabId: NaN, origin: SITE, kind: "enable" },
    ],
    [
      "Infinity tabId",
      { type: "site-intent", tabId: Infinity, origin: SITE, kind: "enable" },
    ],
    [
      "unsafe tabId",
      { type: "site-intent", tabId: 2 ** 53, origin: SITE, kind: "enable" },
    ],
    [
      "string tabId",
      { type: "site-intent", tabId: "1", origin: SITE, kind: "enable" },
    ],
  ])("rejects %s", (_name, raw) => {
    expect(parsePageRequest(raw)).toBeNull();
  });

  it("a page sender reaches the handler; a content sender never does", async () => {
    const { h, handlers } = spyHandlers();
    const router = createRouter(handlers);
    const msgs = [
      { type: "site-status", origin: SITE },
      { type: "site-enable", tabId: 1, origin: SITE },
      { type: "site-remove", origin: SITE },
      { type: "site-intent", tabId: 1, origin: SITE, kind: "enable" },
    ];
    for (const m of msgs) expect(await router(m, content)).toEqual(REJECTED);
    for (const spy of Object.values(h)) expect(spy).not.toHaveBeenCalled();
    for (const m of msgs) await router(m, popup);
    expect(h["site-status"]).toHaveBeenCalledOnce();
    expect(h["site-enable"]).toHaveBeenCalledWith(msgs[1]);
    expect(h["site-remove"]).toHaveBeenCalledOnce();
    expect(h["site-intent"]).toHaveBeenCalledWith(msgs[3]);
  });

  it("an oversized origin is rejected by the router before any handler", async () => {
    const { h, handlers } = spyHandlers();
    const res = await createRouter(handlers)(
      { type: "site-status", origin: long },
      popup,
    );
    expect(res).toEqual(REJECTED);
    expect(h["site-status"]).not.toHaveBeenCalled();
  });
});

describe("router", () => {
  it("page sender (popup, no tab) can call vault-status", async () => {
    const { h, handlers } = spyHandlers();
    const res = await createRouter(handlers)({ type: "vault-status" }, popup);
    expect(res).toEqual({ state: "none" });
    expect(h["vault-status"]).toHaveBeenCalledOnce();
  });

  it("passes only the parsed request to the handler", async () => {
    const { h, handlers } = spyHandlers();
    await createRouter(handlers)(
      { type: "vault-unlock", passphrase: P },
      popup,
    );
    expect(h["vault-unlock"]).toHaveBeenCalledWith({
      type: "vault-unlock",
      passphrase: P,
    });
  });

  it("content-script sender cannot call vault-unlock", async () => {
    const { h, handlers } = spyHandlers();
    const res = await createRouter(handlers)(
      { type: "vault-unlock", passphrase: P },
      content,
    );
    expect(res).toEqual(REJECTED);
    for (const spy of Object.values(h)) expect(spy).not.toHaveBeenCalled();
  });

  it("sender with another extension id is rejected", async () => {
    const { h, handlers } = spyHandlers();
    const res = await createRouter(handlers)(
      { type: "vault-lock" },
      { ...popup, id: OTHER },
    );
    expect(res).toEqual(REJECTED);
    expect(h["vault-lock"]).not.toHaveBeenCalled();
  });

  it("an unclassified sender (no id, e.g. external) is rejected", async () => {
    const { h, handlers } = spyHandlers();
    expect(await createRouter(handlers)({ type: "vault-lock" }, {})).toEqual(
      REJECTED,
    );
    expect(h["vault-lock"]).not.toHaveBeenCalled();
  });

  it("rejects everything when the runtime has no id", async () => {
    const { h, handlers } = spyHandlers();
    (fakeBrowser.runtime as { id: string | undefined }).id = undefined;
    const res = await createRouter(handlers)(
      { type: "vault-lock" },
      mk({ url: "chrome-extension://undefined/popup.html" }),
    );
    expect(res).toEqual(REJECTED);
    expect(h["vault-lock"]).not.toHaveBeenCalled();
  });

  it("extra keys rejected", async () => {
    const { h, handlers } = spyHandlers();
    const res = await createRouter(handlers)(
      { type: "vault-lock", x: 1 },
      popup,
    );
    expect(res).toEqual(REJECTED);
    expect(h["vault-lock"]).not.toHaveBeenCalled();
  });

  it("a timestamp in the payload is rejected, never forwarded", async () => {
    const { h, handlers } = spyHandlers();
    const res = await createRouter(handlers)(
      { type: "vault-unlock", passphrase: P, now: 0 },
      popup,
    );
    expect(res).toEqual(REJECTED);
    expect(h["vault-unlock"]).not.toHaveBeenCalled();
  });

  it("oversized message rejected", async () => {
    const { h, handlers } = spyHandlers();
    const big = { type: "vault-unlock", passphrase: "a".repeat(70 * 1024) };
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_MESSAGE_CHARS);
    expect(await createRouter(handlers)(big, popup)).toEqual(REJECTED);
    expect(h["vault-unlock"]).not.toHaveBeenCalled();
  });

  it("passphrase of 1025 chars rejected", async () => {
    const { h, handlers } = spyHandlers();
    const res = await createRouter(handlers)(
      { type: "vault-unlock", passphrase: "a".repeat(1025) },
      popup,
    );
    expect(res).toEqual(REJECTED);
    expect(h["vault-unlock"]).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", undefined],
    [
      "cyclic",
      (() => {
        const a: Record<string, unknown> = {};
        a["a"] = a;
        return a;
      })(),
    ],
    ["bigint", { type: "vault-lock", n: 1n }],
  ])("unserializable message (%s) rejected", async (_n, msg) => {
    const { handlers } = spyHandlers();
    expect(await createRouter(handlers)(msg, popup)).toEqual(REJECTED);
  });

  it("handler exception resolves a generic internal error and logs the name only", async () => {
    const { h, handlers } = spyHandlers();
    const err = new RangeError("secret passphrase hunter2 stack");
    h["vault-lock"].mockRejectedValueOnce(err);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await createRouter(handlers)({ type: "vault-lock" }, popup);
    expect(res).toEqual(INTERNAL);
    expect(log).toHaveBeenCalledOnce();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("RangeError");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("stack");
  });

  it("a synchronously throwing handler is also internal", async () => {
    const { h, handlers } = spyHandlers();
    h["vault-lock"].mockImplementationOnce(() => {
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createRouter(handlers)({ type: "vault-lock" }, popup)).toEqual(
      INTERNAL,
    );
  });
});

describe("content senders", () => {
  const SITE = "https://example.com";
  const scanReport = {
    type: "scan-report",
    controls: [
      {
        i: 0,
        kind: "text",
        sig: {
          name: "email",
          idStable: null,
          autocomplete: "email",
          type: "email",
          labelText: "email",
          ordinal: 0,
          formAction: null,
          nameIdDerived: false,
        },
      },
    ],
    truncated: false,
  };
  const fillResult = {
    type: "fill-result",
    filled: 1,
    skipped: 0,
    unsupported: 0,
  };

  /** An enabled, granted site, as after a completed enable flow. */
  async function enabled() {
    const shims = installShims();
    shims.grant(`${SITE}/*`);
    await upsertSite(SITE, {});
    return shims;
  }

  it("an enabled, granted site reaches the handler with the context from the sender", async () => {
    await enabled();
    const { c, handlers } = spyHandlers();
    const s = mk({ ...content, documentId: "doc-9", url: `${SITE}/a/b?q=1#h` });
    expect(await createRouter(handlers)(scanReport, s)).toEqual({
      state: "none",
    });
    expect(c["scan-report"]).toHaveBeenCalledWith(scanReport, {
      origin: SITE,
      pathname: "/a/b",
      tabId: 1,
      documentId: "doc-9",
    });
    expect(await createRouter(handlers)(fillResult, content)).toEqual({
      ok: true,
    });
    expect(c["fill-result"]).toHaveBeenCalledWith(fillResult, {
      origin: SITE,
      pathname: "/form",
      tabId: 1,
      documentId: undefined,
    });
  });

  it("the handler gets a fresh parsed copy, not the message object", async () => {
    await enabled();
    const { c, handlers } = spyHandlers();
    await createRouter(handlers)(scanReport, content);
    const calls = c["scan-report"].mock.calls as unknown[][];
    expect(calls[0]![0]).toEqual(scanReport);
    expect(calls[0]![0]).not.toBe(scanReport);
  });

  it("a site that was never enabled is rejected", async () => {
    installShims().grant(`${SITE}/*`);
    const { c, handlers } = spyHandlers();
    expect(await createRouter(handlers)(scanReport, content)).toEqual(REJECTED);
    expect(c["scan-report"]).not.toHaveBeenCalled();
  });

  it("a revoked site is rejected", async () => {
    await enabled();
    await upsertSite(SITE, { accessRevoked: true });
    const { c, handlers } = spyHandlers();
    expect(await createRouter(handlers)(scanReport, content)).toEqual(REJECTED);
    expect(await createRouter(handlers)(fillResult, content)).toEqual(REJECTED);
    expect(c["scan-report"]).not.toHaveBeenCalled();
    expect(c["fill-result"]).not.toHaveBeenCalled();
  });

  it("an enabled site without the host permission is rejected", async () => {
    const shims = await enabled();
    shims.grants.clear();
    const { c, handlers } = spyHandlers();
    expect(await createRouter(handlers)(scanReport, content)).toEqual(REJECTED);
    expect(c["scan-report"]).not.toHaveBeenCalled();
    expect(shims.permissions.contains).toHaveBeenCalledWith({
      origins: [`${SITE}/*`],
    });
  });

  it.each([
    ["a non-canonical origin", { origin: `${SITE}/` }],
    ["an upper-case origin", { origin: "https://Example.com" }],
    ["an explicit default port", { origin: `${SITE}:443` }],
    ["a url on another origin", { url: "https://evil.example/form" }],
    ["a url on another port", { url: `${SITE}:8443/form` }],
    ["an http url", { url: "http://example.com/form" }],
    ["an unparsable url", { url: "not a url" }],
    ["no url", { url: undefined }],
    ["no tab id", { tab: { url: `${SITE}/form` } }],
    ["a negative tab id", { tab: { id: -1, url: `${SITE}/form` } }],
    ["a sub-frame", { frameId: 2 }],
  ])("%s is rejected", async (_name, patch) => {
    await enabled();
    const { c, handlers } = spyHandlers();
    const s = mk({ ...content, ...patch });
    expect(await createRouter(handlers)(scanReport, s)).toEqual(REJECTED);
    expect(c["scan-report"]).not.toHaveBeenCalled();
  });

  it("page-kind messages from content are rejected", async () => {
    await enabled();
    const { h, c, handlers } = spyHandlers();
    for (const m of [
      { type: "vault-status" },
      { type: "vault-lock" },
      { type: "site-status", origin: SITE },
      { type: "review-load", sessionId: "abc" },
      { type: "review-discard", sessionId: "abc" },
      { type: "review-check", sessionId: "abc" },
      {
        type: "review-save",
        sessionId: "abc",
        name: "n",
        fillMode: "auto",
        pathPrefix: "/",
        policies: [],
      },
      // Saved mode (ADR 0035): page-only too.
      { type: "saved-summary", origin: SITE },
      { type: "saved-load", profileId: "abc" },
      { type: "saved-check", profileId: "abc" },
      {
        type: "saved-save",
        profileId: "abc",
        name: "n",
        fillMode: "auto",
        pathPrefix: "/",
        policies: [],
      },
    ]) {
      expect(await createRouter(handlers)(m, content)).toEqual(REJECTED);
    }
    for (const spy of [...Object.values(h), ...Object.values(c)]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("record-start from a content sender is rejected before any handler", async () => {
    const shims = await enabled();
    const { h, c, handlers } = spyHandlers();
    for (const m of [
      { type: "record-start", tabId: 1, origin: SITE },
      { type: "record-start" },
    ]) {
      expect(await createRouter(handlers)(m, content)).toEqual(REJECTED);
    }
    for (const spy of [...Object.values(h), ...Object.values(c)]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(shims.permissions.contains).not.toHaveBeenCalled();
  });

  it("recording requests reach their handler with the sender's context", async () => {
    await enabled();
    const { c, handlers } = spyHandlers();
    const capture = {
      type: "record-capture",
      kind: "text",
      sig: scanReport.controls[0]!.sig,
      value: "typed",
      pageDefault: "",
      fieldId: "f1",
    };
    const s = mk({ ...content, documentId: "doc-3" });
    const where = {
      origin: SITE,
      pathname: "/form",
      tabId: 1,
      documentId: "doc-3",
    };
    const r = createRouter(handlers);
    expect(await r({ type: "record-status" }, s)).toEqual({ state: "off" });
    expect(await r(capture, s)).toEqual({ state: "off" });
    expect(await r({ type: "record-finish" }, s)).toEqual({ ok: false });
    expect(c["record-status"]).toHaveBeenCalledWith(
      { type: "record-status" },
      where,
    );
    expect(c["record-capture"]).toHaveBeenCalledWith(capture, where);
    expect(c["record-finish"]).toHaveBeenCalledWith(
      { type: "record-finish" },
      where,
    );
  });

  it("recording requests from a page or a revoked site are rejected", async () => {
    await enabled();
    const { c, handlers } = spyHandlers();
    const r = createRouter(handlers);
    expect(await r({ type: "record-status" }, popup)).toEqual(REJECTED);
    expect(await r({ type: "record-finish" }, popup)).toEqual(REJECTED);
    await upsertSite(SITE, { accessRevoked: true });
    expect(await r({ type: "record-finish" }, content)).toEqual(REJECTED);
    for (const spy of Object.values(c)) expect(spy).not.toHaveBeenCalled();
  });

  it("content messages from a page are rejected", async () => {
    await enabled();
    const { h, c, handlers } = spyHandlers();
    expect(await createRouter(handlers)(scanReport, popup)).toEqual(REJECTED);
    expect(await createRouter(handlers)(fillResult, popup)).toEqual(REJECTED);
    for (const spy of [...Object.values(h), ...Object.values(c)]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["origin", { origin: SITE }],
    ["url", { url: `${SITE}/form` }],
    ["now", { now: 1 }],
    ["tabId", { tabId: 1 }],
  ])("a payload %s key is rejected", async (_name, extra) => {
    await enabled();
    const { c, handlers } = spyHandlers();
    expect(
      await createRouter(handlers)({ ...scanReport, ...extra }, content),
    ).toEqual(REJECTED);
    expect(c["scan-report"]).not.toHaveBeenCalled();
  });

  it("301 controls are rejected", async () => {
    await enabled();
    const { c, handlers } = spyHandlers();
    const sig = { ...scanReport.controls[0]!.sig, name: null, labelText: null };
    const controls = Array.from({ length: 301 }, (_, i) => ({
      i: i % 300,
      kind: "text",
      sig,
    }));
    const msg = { ...scanReport, controls };
    expect(JSON.stringify(msg).length).toBeLessThan(MAX_MESSAGE_CHARS);
    expect(await createRouter(handlers)(msg, content)).toEqual(REJECTED);
    expect(c["scan-report"]).not.toHaveBeenCalled();
  });

  it("an oversized content message is rejected before any store read", async () => {
    const shims = await enabled();
    const { c, handlers } = spyHandlers();
    const msg = { ...scanReport, pad: "x".repeat(MAX_MESSAGE_CHARS) };
    expect(await createRouter(handlers)(msg, content)).toEqual(REJECTED);
    expect(shims.permissions.contains).not.toHaveBeenCalled();
    expect(c["scan-report"]).not.toHaveBeenCalled();
  });

  it("a content handler that throws is internal", async () => {
    await enabled();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { c, handlers } = spyHandlers();
    c["scan-report"].mockRejectedValue(new Error("secret detail"));
    expect(await createRouter(handlers)(scanReport, content)).toEqual(INTERNAL);
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret detail");
  });

  it("a failing permission check is internal, never a pass", async () => {
    const shims = await enabled();
    vi.spyOn(console, "error").mockImplementation(() => {});
    shims.permissions.contains.mockRejectedValue(new Error("boom"));
    const { c, handlers } = spyHandlers();
    expect(await createRouter(handlers)(scanReport, content)).toEqual(INTERNAL);
    expect(c["scan-report"]).not.toHaveBeenCalled();
  });
});

describe("runtime listener adapter", () => {
  it("answers through sendResponse and returns true to keep the channel open", async () => {
    const { handlers } = spyHandlers();
    const listener = toRuntimeListener(createRouter(handlers));
    const sendResponse = vi.fn();
    expect(listener({ type: "vault-status" }, popup, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());
    expect(sendResponse).toHaveBeenCalledWith({ state: "none" });
  });

  it("answers a rejected message with the generic error", async () => {
    const { handlers } = spyHandlers();
    const listener = toRuntimeListener(createRouter(handlers));
    const sendResponse = vi.fn();
    listener({ type: "vault-lock" }, content, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(REJECTED));
  });

  it("a router that returns undefined leaves the channel closed", () => {
    const listener = toRuntimeListener(() => undefined);
    const sendResponse = vi.fn();
    expect(listener({}, popup, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("a sendResponse that throws (closed popup) causes no unhandled rejection", async () => {
    const { handlers } = spyHandlers();
    const listener = toRuntimeListener(createRouter(handlers));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const sendResponse = vi.fn(() => {
        throw new Error(
          "The message port closed before a response was received",
        );
      });
      expect(listener({ type: "vault-status" }, popup, sendResponse)).toBe(
        true,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      // The INTERNAL fallback must not run a second sendResponse either.
      await new Promise((r) => setTimeout(r, 20));
      expect(sendResponse).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a sendResponse that throws for the fallback answer is swallowed too", async () => {
    const listener = toRuntimeListener(() => Promise.reject(new Error("x")));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const sendResponse = vi.fn(() => {
        throw new Error("closed");
      });
      listener({}, popup, sendResponse);
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a rejecting router still answers", async () => {
    const listener = toRuntimeListener(() => Promise.reject(new Error("x")));
    const sendResponse = vi.fn();
    listener({}, popup, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(INTERNAL));
  });
});

describe("sendToSw", () => {
  it("returns the response", async () => {
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue({
      state: "none",
    } as never);
    expect(await sendToSw({ type: "vault-status" })).toEqual({ state: "none" });
  });

  it.each([REJECTED, INTERNAL])("throws MessagingError for %o", async (res) => {
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(
      res as never,
    );
    await expect(sendToSw({ type: "vault-lock" })).rejects.toMatchObject({
      name: "MessagingError",
      code: res.error,
    });
  });

  it("wraps a rejected transport (no receiver, lastError) in MessagingError", async () => {
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockRejectedValue(
      new Error(
        "Could not establish connection. Receiving end does not exist.",
      ),
    );
    const err = await sendToSw({ type: "vault-lock" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toMatchObject({ code: "internal" });
    expect(String((err as Error).message)).not.toContain("Receiving end");
  });

  it("wraps a synchronously throwing transport too", async () => {
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(() => {
      throw new Error("Extension context invalidated.");
    });
    await expect(sendToSw({ type: "vault-lock" })).rejects.toBeInstanceOf(
      MessagingError,
    );
  });

  it("throws on a missing response", async () => {
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(
      undefined as never,
    );
    await expect(sendToSw({ type: "vault-lock" })).rejects.toBeInstanceOf(
      MessagingError,
    );
  });
});

describe("vault through the router", SLOW, () => {
  it("vault-create → vault-lock → vault-unlock round-trip", async () => {
    const calibrate = vi.fn(async () => newKdfParams());
    const route = createRouter({
      page: createPageHandlers(calibrate),
      content: createContentHandlers(),
    });
    const call = (m: unknown) => route(m, popup);

    expect(await call({ type: "vault-status" })).toEqual({ state: "none" });
    expect(await call({ type: "vault-create", passphrase: P })).toEqual({
      ok: true,
    });
    expect(calibrate).toHaveBeenCalledOnce();
    expect(await call({ type: "vault-status" })).toMatchObject({
      state: "unlocked",
    });
    expect(await call({ type: "vault-lock" })).toEqual({ ok: true });
    expect(await call({ type: "vault-status" })).toMatchObject({
      state: "locked",
    });
    expect(await call({ type: "vault-unlock", passphrase: P })).toEqual({
      ok: true,
    });
    expect(await call({ type: "vault-status" })).toMatchObject({
      state: "unlocked",
    });
    // Last, because a wrong guess starts the backoff.
    expect(await call({ type: "vault-lock" })).toEqual({ ok: true });
    expect(
      await call({ type: "vault-unlock", passphrase: "wrong passphrase!" }),
    ).toMatchObject({ ok: false, reason: "wrong-passphrase" });
  });

  it("vault-create maps exists and weak", async () => {
    const route = createRouter({
      page: createPageHandlers(async () => newKdfParams()),
      content: createContentHandlers(),
    });
    expect(
      await route({ type: "vault-create", passphrase: "short" }, popup),
    ).toEqual({ ok: false, error: "weak" });
    expect(await route({ type: "vault-create", passphrase: P }, popup)).toEqual(
      {
        ok: true,
      },
    );
    expect(await route({ type: "vault-create", passphrase: P }, popup)).toEqual(
      {
        ok: false,
        error: "exists",
      },
    );
  });

  it("an invalid create never calibrates", async () => {
    const calibrate = vi.fn(async () => newKdfParams());
    const route = createRouter({
      page: createPageHandlers(calibrate),
      content: createContentHandlers(),
    });
    expect(
      await route({ type: "vault-create", passphrase: "short" }, popup),
    ).toEqual({ ok: false, error: "weak" });
    // 11 code points after NFC, however many UTF-16 units: still weak.
    expect(
      await route(
        { type: "vault-create", passphrase: "e\u0301".repeat(5) + "x" },
        popup,
      ),
    ).toEqual({ ok: false, error: "weak" });
    expect(calibrate).not.toHaveBeenCalled();
  });

  it("create over an existing vault never calibrates", async () => {
    const calibrate = vi.fn(async () => newKdfParams());
    const route = createRouter({
      page: createPageHandlers(calibrate),
      content: createContentHandlers(),
    });
    expect(await route({ type: "vault-create", passphrase: P }, popup)).toEqual(
      { ok: true },
    );
    expect(calibrate).toHaveBeenCalledOnce();
    expect(await route({ type: "vault-create", passphrase: P }, popup)).toEqual(
      { ok: false, error: "exists" },
    );
    expect(calibrate).toHaveBeenCalledOnce();
  });

  it("an unexpected create failure is internal", async () => {
    const route = createRouter({
      page: createPageHandlers(async () => {
        throw new RangeError("calibration failed");
      }),
      content: createContentHandlers(),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await route({ type: "vault-create", passphrase: P }, popup)).toEqual(
      INTERNAL,
    );
  });
});
