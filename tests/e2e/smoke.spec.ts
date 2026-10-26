import { EXTENSION_ID } from "../../src/manifest-key";
import { expect, test } from "./fixtures";

// Launch guard: Chromium starts, loads the built extension, and its service worker has the pinned ID.
test("built extension loads and its service worker has the pinned ID", ({
  extensionId,
}) => {
  expect(extensionId).toBe(EXTENSION_ID);
});

// Messaging in real Chromium: the callback-style onMessage answers through sendResponse (a
// returned Promise would not be delivered), and rejected messages get an answer rather than a
// hanging channel.
test("service worker answers page messages and rejects invalid ones", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
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
});
