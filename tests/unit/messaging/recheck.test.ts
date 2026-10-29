// The worker's data-free "check again" signal to extension pages (ADR 0033 I3, ADR 0035): sent on
// every recording discard, every lock and every site removal; a page acts on it only when it is the
// exact message from this extension's own service worker.
import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECHECK,
  announceRecheck,
  onRecheck,
} from "../../../src/lib/messaging/recheck";

const SIGNAL = { type: "refill-recheck" };
const WORKER_URL = "chrome-extension://test-extension-id/background.js";
/** What Chrome gives a page for a message from the worker: no tab, no document, no origin. */
const worker = () => ({ id: fakeBrowser.runtime.id, url: WORKER_URL });
const noReply = () => undefined;

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({
    manifest_version: 3,
    name: "Refill",
    version: "0.0.0",
    background: { service_worker: "background.js" },
  } as never);
});

describe("announceRecheck (worker)", () => {
  it("sends exactly the data-free message, and a missing receiver is not an error", async () => {
    expect(RECHECK).toEqual(SIGNAL);
    const send = vi
      .spyOn(fakeBrowser.runtime, "sendMessage")
      .mockRejectedValue(new Error("Receiving end does not exist.") as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    announceRecheck();
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledWith({ type: "refill-recheck" });
    expect(log).not.toHaveBeenCalled();
  });
});

describe("onRecheck (pages)", () => {
  it("calls back for the worker's signal", async () => {
    const signal = vi.fn();
    onRecheck(signal);
    await fakeBrowser.runtime.onMessage.trigger(SIGNAL, worker(), noReply);
    expect(signal).toHaveBeenCalledOnce();
  });

  it.each([
    ["another extension", SIGNAL, { id: "another", url: WORKER_URL }],
    ["no sender id", SIGNAL, { url: WORKER_URL }],
    [
      "another extension page (the popup)",
      SIGNAL,
      {
        id: "test-extension-id",
        url: "chrome-extension://test-extension-id/popup.html",
        documentId: "D1",
      },
    ],
    [
      "a page that claims the worker's URL from a tab",
      SIGNAL,
      { ...worker(), tab: { id: 3 }, documentId: "D2" },
    ],
    [
      "a page that claims the worker's URL with a document",
      SIGNAL,
      { ...worker(), documentId: "D3" },
    ],
    ["no url", SIGNAL, { id: "test-extension-id" }],
    ["the old message type", { type: "refill-recording-ended" }, undefined],
    ["another type", { type: "refill-nudge" }, undefined],
    ["an extra key", { ...SIGNAL, sessionId: "s1" }, undefined],
    ["not an object", "refill-recheck", undefined],
    ["null", null, undefined],
  ])("ignores %s", async (_n, msg, sender) => {
    const signal = vi.fn();
    onRecheck(signal);
    await fakeBrowser.runtime.onMessage.trigger(
      msg,
      sender ?? worker(),
      noReply,
    );
    expect(signal).not.toHaveBeenCalled();
  });

  it("a manifest it cannot read accepts nothing", async () => {
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockImplementation(() => {
      throw new Error("no manifest");
    });
    const signal = vi.fn();
    onRecheck(signal);
    await fakeBrowser.runtime.onMessage.trigger(SIGNAL, worker(), noReply);
    expect(signal).not.toHaveBeenCalled();
  });

  it("stops listening once unsubscribed", async () => {
    const signal = vi.fn();
    const stop = onRecheck(signal);
    stop();
    await fakeBrowser.runtime.onMessage.trigger(SIGNAL, worker(), noReply);
    expect(signal).not.toHaveBeenCalled();
  });
});
