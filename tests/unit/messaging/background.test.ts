import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { upsertSite } from "../../../src/lib/sites";
import { originPattern } from "../../../src/lib/sites/origin";
import { installShims } from "../helpers/browser-shims";

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).__refillE2E;
});

beforeEach(() => {
  fakeBrowser.reset();
  installShims(); // the site reconciler needs scripting and permissions
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("registers the runtime.onMessage router in the first turn, rejecting foreign senders", async () => {
  // fakeBrowser mocks neither idle nor storage.session.setAccessLevel; stub both.
  (fakeBrowser as unknown as { idle: unknown }).idle = {
    setDetectionInterval: vi.fn(),
    onStateChanged: { addListener: vi.fn() },
  };
  fakeBrowser.storage.session.setAccessLevel = vi.fn(async () => {});
  const { default: background } =
    await import("../../../src/entrypoints/background");
  const main = (background as unknown as { main: () => void }).main;
  const add = vi.spyOn(fakeBrowser.runtime.onMessage, "addListener");

  main(); // synchronous: nothing awaited between the call and the assertions

  expect(add).toHaveBeenCalledOnce();
  const listener = add.mock.calls[0]![0] as unknown as (
    msg: unknown,
    sender: unknown,
    sendResponse: (r: unknown) => void,
  ) => boolean;
  const sendResponse = vi.fn();
  const keepOpen = listener(
    { type: "vault-lock" },
    { id: "someone-else", url: "https://evil.example/" },
    sendResponse,
  );
  expect(keepOpen).toBe(true);
  await vi.waitFor(() =>
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "rejected" }),
  );
});

it("opens onboarding on install only", async () => {
  (fakeBrowser as unknown as { idle: unknown }).idle = {
    setDetectionInterval: vi.fn(),
    onStateChanged: { addListener: vi.fn() },
  };
  fakeBrowser.storage.session.setAccessLevel = vi.fn(async () => {});
  const { default: background } =
    await import("../../../src/entrypoints/background");
  const main = (background as unknown as { main: () => void }).main;
  const create = vi
    .spyOn(fakeBrowser.tabs, "create")
    .mockResolvedValue({} as never);
  const add = vi.spyOn(fakeBrowser.runtime.onInstalled, "addListener");

  main();

  // Two listeners: onboarding (this file's subject) and the site reconciler.
  expect(add).toHaveBeenCalledTimes(2);
  const onInstalled = (d: { reason: string }): void => {
    for (const [fn] of add.mock.calls) {
      (fn as unknown as (d: { reason: string }) => void)(d);
    }
  };
  onInstalled({ reason: "update" });
  onInstalled({ reason: "chrome_update" });
  expect(create).not.toHaveBeenCalled();
  onInstalled({ reason: "install" });
  expect(create).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith({
    url: fakeBrowser.runtime.getURL("/onboarding.html"),
  });
});

it("the e2e wrapper logs a toast-unlock-click as its type, ok and where, nothing else", async () => {
  vi.stubEnv("MODE", "e2e");
  (fakeBrowser as unknown as { idle: unknown }).idle = {
    setDetectionInterval: vi.fn(),
    onStateChanged: { addListener: vi.fn() },
  };
  fakeBrowser.storage.session.setAccessLevel = vi.fn(async () => {});
  const openPopup = vi.fn(async () => {});
  (fakeBrowser as unknown as { action: unknown }).action = { openPopup };
  const A = "https://a.example";
  const shims = installShims();
  shims.grant(originPattern(A));
  await upsertSite(A, {});
  const { default: background } =
    await import("../../../src/entrypoints/background");
  const main = (background as unknown as { main: () => void }).main;
  const add = vi.spyOn(fakeBrowser.runtime.onMessage, "addListener");

  main();

  const listener = add.mock.calls[0]![0] as unknown as (
    msg: unknown,
    sender: unknown,
    sendResponse: (r: unknown) => void,
  ) => boolean;
  const sendResponse = vi.fn();
  listener(
    { type: "toast-unlock-click" },
    {
      id: fakeBrowser.runtime.id,
      url: `${A}/signup`,
      origin: A,
      frameId: 0,
      documentId: "doc-1",
      tab: { id: 7, url: `${A}/signup` },
    },
    sendResponse,
  );
  await vi.waitFor(() =>
    expect(sendResponse).toHaveBeenCalledWith({ ok: true }),
  );
  expect(openPopup).toHaveBeenCalledOnce();
  const seam = (globalThis as Record<string, unknown>).__refillE2E as {
    contentLog: Record<string, unknown>[];
    boot: string;
  };
  expect(seam.contentLog).toEqual([
    {
      boot: seam.boot,
      seq: 1,
      type: "toast-unlock-click",
      ok: true,
      origin: A,
      pathname: "/signup",
      tabId: 7,
      documentId: "doc-1",
    },
  ]);
});
