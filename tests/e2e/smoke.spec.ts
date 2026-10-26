import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { EXTENSION_ID } from "../../src/manifest-key";

// Launch guard: Chromium starts, loads the built extension, and its service worker has the pinned ID.
test("built extension loads and its service worker has the pinned ID", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const userDataDir = await mkdtemp(join(tmpdir(), "refill-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(new URL(worker.url()).host).toBe(EXTENSION_ID);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

// Messaging in real Chromium: the callback-style onMessage answers through sendResponse (a
// returned Promise would not be delivered), and rejected messages get an answer rather than a
// hanging channel.
test("service worker answers page messages and rejects invalid ones", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const userDataDir = await mkdtemp(join(tmpdir(), "refill-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
    const send = (msg: unknown) =>
      page.evaluate(
        (m) =>
          (
            globalThis as unknown as {
              chrome: {
                runtime: { sendMessage(m: unknown): Promise<unknown> };
              };
            }
          ).chrome.runtime.sendMessage(m),
        msg,
      );
    expect(await send({ type: "vault-status" })).toEqual({ state: "none" });
    expect(await send({ type: "vault-lock", extra: 1 })).toEqual({
      ok: false,
      error: "rejected",
    });
    expect(await send({ type: "vault-create", passphrase: "short" })).toEqual({
      ok: false,
      error: "weak",
    });
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
