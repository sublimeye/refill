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

function fakeChrome(id: string | undefined = "abcdefghijklmnop") {
  const runtime: {
    id: string | undefined;
    sendMessage: (msg: unknown) => Promise<unknown>;
  } = {
    id,
    sendMessage: vi.fn(async (msg: unknown) => ({ echo: msg })),
  };
  const dom = {
    openOrClosedShadowRoot: vi.fn((el: Element) => el.shadowRoot),
  };
  return { runtime, dom };
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
