import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, expect, it, vi } from "vitest";
import { installShims } from "../helpers/browser-shims";

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
