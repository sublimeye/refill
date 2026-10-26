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
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    expect(new URL(worker.url()).host).toBe(EXTENSION_ID);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
