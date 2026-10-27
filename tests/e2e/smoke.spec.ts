import { EXTENSION_ID } from "../../src/manifest-key";
import { expect, test } from "./fixtures";

// Launch guard: Chromium starts, loads the built extension, and its service worker has the pinned ID.
test("built extension loads and its service worker has the pinned ID", ({
  extensionId,
}) => {
  expect(extensionId).toBe(EXTENSION_ID);
});

// ADR 0022: the e2e build exposes the profile seeding seam in the service worker (and only it does;
// CI proves the production build has no such marker).
test("e2e service worker exposes the profile seam", async ({ context }) => {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const result = await worker.evaluate(async () => {
    const seam = (
      globalThis as unknown as {
        __refillE2E?: { saveProfile?: (p: unknown) => Promise<void> };
      }
    ).__refillE2E;
    if (typeof seam?.saveProfile !== "function") return "missing";
    try {
      await seam.saveProfile({});
      return "resolved";
    } catch (err) {
      return err instanceof Error ? err.name : "threw";
    }
  });
  expect(result).toBe("TypeError"); // reached the real validation, not just a stub
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

// ADR 0016: extension pages run under `default-src 'none'`. Both pages must render and run
// (onboarding loads zxcvbn, the popup talks to the worker) with no CSP violation, and the policy
// must actually block what it claims to: an image from another origin is refused.
test("onboarding and popup load without CSP violations, and the CSP blocks foreign images", async ({
  context,
  extensionId,
  cspViolations,
}) => {
  const onboarding = await context.newPage();
  await onboarding.goto(`chrome-extension://${extensionId}/onboarding.html`);
  await expect(
    onboarding.getByRole("button", { name: "Create vault" }),
  ).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(
    popup.getByRole("button", { name: "Set up Refill" }),
  ).toBeVisible();
  expect(cspViolations).toEqual([]);

  // Positive control: the watcher sees a real violation.
  await popup.evaluate(() => {
    new Image().src = "https://example.invalid/pixel.png";
  });
  await expect.poll(() => cspViolations.length).toBeGreaterThan(0);
  expect(cspViolations.join("\n")).toMatch(/img-src|default-src/);
  cspViolations.length = 0;
});
