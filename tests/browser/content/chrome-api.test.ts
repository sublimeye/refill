import { afterEach, describe, expect, it, vi } from "vitest";
import { captureChrome } from "../../../src/lib/content/chrome-api";

afterEach(() => {
  document.body.replaceChildren();
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html; // test-only fixture markup
  document.body.append(root);
  return root;
}

type Listener = (msg: unknown, sender: unknown, reply: unknown) => unknown;

function fakeChrome(id: string | undefined = "abcdefghijklmnop") {
  const listeners: Listener[] = [];
  const runtime: {
    id: string | undefined;
    sendMessage: (msg: unknown) => Promise<unknown>;
    onMessage?: unknown;
  } = {
    id,
    sendMessage: vi.fn(async (msg: unknown) => ({ echo: msg })),
    onMessage: {
      addListener: vi.fn((l: Listener) => {
        listeners.push(l);
      }),
    },
  };
  const dom = {
    openOrClosedShadowRoot: vi.fn((el: Element) => el.shadowRoot),
  };
  /** Delivers `msg` from `sender` to every listener; what each returned. */
  const deliver = (msg: unknown, sender: unknown, reply: unknown = vi.fn()) =>
    listeners.map((l) => l(msg, sender, reply));
  return { runtime, dom, deliver };
}

describe("captureChrome", () => {
  it("captures the real API: send, alive and the closed-root reader", async () => {
    const chrome = fakeChrome();
    const api = captureChrome(chrome)!;
    expect(api).not.toBeNull();
    expect(await api.send({ type: "x" })).toEqual({ echo: { type: "x" } });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "x" });
    expect(api.alive()).toBe(true);

    const host = mount(`<div></div>`).firstElementChild!;
    const shadow = host.attachShadow({ mode: "open" });
    expect(api.openOrClosedShadowRoot!(host)).toBe(shadow);

    // The context goes away: Chrome clears runtime.id.
    chrome.runtime.id = undefined;
    expect(api.alive()).toBe(false);
  });

  it("keeps the runtime it captured, whatever the global becomes later", async () => {
    const chrome = fakeChrome();
    const api = captureChrome(chrome)!;
    (chrome as Record<string, unknown>).runtime = { sendMessage: () => "page" };
    expect(await api.send(1)).toEqual({ echo: 1 });
  });

  it("works without dom.openOrClosedShadowRoot", () => {
    const api = captureChrome({ runtime: fakeChrome().runtime });
    expect(api).not.toBeNull();
    expect(api!.openOrClosedShadowRoot).toBeUndefined();
  });

  it("ignores a dom reader that is page markup", () => {
    const form = mount(
      `<form><input name="openOrClosedShadowRoot"></form>`,
    ).querySelector("form")!;
    const api = captureChrome({ runtime: fakeChrome().runtime, dom: form });
    expect(api!.openOrClosedShadowRoot).toBeUndefined();
  });

  it("refuses page markup standing in for chrome or chrome.runtime", () => {
    // <form id="chrome"><input name="runtime" id="x"> through window named access.
    const form = mount(
      `<form id="chrome-x"><input name="runtime" id="x"></form>`,
    ).querySelector("form")!;
    expect(captureChrome(form)).toBeNull();
    expect(captureChrome({ runtime: form.querySelector("input") })).toBeNull();
    // A runtime whose sendMessage is an element.
    const named = mount(
      `<form><input name="sendMessage"></form>`,
    ).querySelector("form")!;
    expect(
      captureChrome({ runtime: { id: "abc", sendMessage: named.firstChild } }),
    ).toBeNull();
  });

  it("refuses a frame's window standing in for chrome", () => {
    const frame = mount(`<iframe name="chrome-y"></iframe>`).querySelector(
      "iframe",
    )!;
    expect(captureChrome(frame.contentWindow)).toBeNull();
  });

  it("refuses a runtime without a usable id or sendMessage", () => {
    const { runtime } = fakeChrome();
    expect(captureChrome(undefined)).toBeNull();
    expect(captureChrome(null)).toBeNull();
    expect(captureChrome({})).toBeNull();
    expect(captureChrome({ runtime: { ...runtime, id: "" } })).toBeNull();
    expect(
      captureChrome({ runtime: { ...runtime, id: undefined } }),
    ).toBeNull();
    expect(captureChrome({ runtime: { ...runtime, id: 7 } })).toBeNull();
    expect(
      captureChrome({ runtime: { id: "abc", sendMessage: "nope" } }),
    ).toBeNull();
  });

  it("never throws on hostile getters", () => {
    const trap = {
      get runtime(): never {
        throw new Error("boom");
      },
    };
    expect(captureChrome(trap)).toBeNull();
    const runtime = {
      sendMessage: () => undefined,
      get id(): never {
        throw new Error("boom");
      },
    };
    expect(captureChrome({ runtime })).toBeNull();
  });
});

describe("captureChrome onNudge", () => {
  const ID = "abcdefghijklmnop";
  const NUDGE = { type: "refill-nudge" };

  it("calls back for the worker's nudge and never replies", () => {
    const chrome = fakeChrome(ID);
    const cb = vi.fn();
    captureChrome(chrome)!.onNudge(cb);
    const reply = vi.fn();
    const returned = chrome.deliver(NUDGE, { id: ID }, reply);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(returned).toEqual([undefined]); // not `true`: the channel closes without an answer
  });

  it("ignores a nudge from a tab, another extension or with any other shape", () => {
    const chrome = fakeChrome(ID);
    const cb = vi.fn();
    captureChrome(chrome)!.onNudge(cb);
    // Another content script of this extension (a tab sender) cannot wake this one.
    chrome.deliver(NUDGE, {
      id: ID,
      tab: { id: 3 },
      url: "https://x.example/",
    });
    chrome.deliver(NUDGE, { id: "otherextensionid" });
    chrome.deliver(NUDGE, {});
    chrome.deliver(NUDGE, null);
    chrome.deliver({ type: "refill-nudge", extra: 1 }, { id: ID });
    chrome.deliver({ type: "scan-report" }, { id: ID });
    chrome.deliver("refill-nudge", { id: ID });
    chrome.deliver([NUDGE], { id: ID });
    chrome.deliver(Object.create({ type: "refill-nudge" }), { id: ID });
    const trap = {
      get type(): never {
        throw new Error("boom");
      },
    };
    chrome.deliver(trap, { id: ID });
    expect(cb).not.toHaveBeenCalled();
  });

  it("is a no-op when onMessage is missing or page markup", () => {
    const { runtime } = fakeChrome(ID);
    delete runtime.onMessage;
    expect(() => captureChrome({ runtime })!.onNudge(vi.fn())).not.toThrow();
    const form = mount(`<form><input name="addListener"></form>`).querySelector(
      "form",
    )!;
    const marked = fakeChrome(ID).runtime;
    marked.onMessage = form;
    expect(() =>
      captureChrome({ runtime: marked })!.onNudge(vi.fn()),
    ).not.toThrow();
    const named = fakeChrome(ID).runtime;
    named.onMessage = { addListener: form.firstChild };
    expect(() =>
      captureChrome({ runtime: named })!.onNudge(vi.fn()),
    ).not.toThrow();
  });
});
