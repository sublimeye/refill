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
  type PageHandlers,
} from "../../../src/lib/messaging/router";
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
  };
  return { h, handlers: { page: h } as { page: PageHandlers } };
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

  it("any content-classified message is rejected for now", async () => {
    const { h, handlers } = spyHandlers();
    const res = await createRouter(handlers)({ type: "scan-report" }, content);
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
    const route = createRouter({ page: createPageHandlers(calibrate) });
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
    const route = createRouter({ page: createPageHandlers(calibrate) });
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
    const route = createRouter({ page: createPageHandlers(calibrate) });
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
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await route({ type: "vault-create", passphrase: P }, popup)).toEqual(
      INTERNAL,
    );
  });
});
