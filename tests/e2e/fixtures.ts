import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Worker,
} from "@playwright/test";
import { EXTENSION_ID } from "../../src/manifest-key";

const EXTENSION_PATH = resolve(".output/chrome-mv3");

/**
 * An unattended machine (a dev box, a CI runner) is "idle" to Chrome, which then sends one
 * `idle.onStateChanged` event about a second after the service worker starts. Refill locks on it,
 * as it should. A test that creates a vault meanwhile races that event (Argon2 calibration blocks
 * the worker, so the event is handled right as the vault commits and lock wins). Wait for the
 * event here so every test starts after it. An active machine reports "active" and never waits.
 * ADR 0015.
 */
async function settleIdle(worker: Worker): Promise<void> {
  await worker.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const c = (
          globalThis as unknown as {
            chrome: {
              idle: {
                queryState(s: number, cb: (state: string) => void): void;
                onStateChanged: { addListener(cb: () => void): void };
              };
            };
          }
        ).chrome;
        c.idle.queryState(60, (state) => {
          if (state === "active") return resolve();
          c.idle.onStateChanged.addListener(() => resolve());
          setTimeout(resolve, 5_000); // the event may already have been delivered
        });
      }),
  );
}

/**
 * Shared e2e fixtures: a fresh persistent Chromium profile per test with the built extension
 * loaded, and the extension ID read from its service worker URL (asserted against the pinned ID).
 */
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  cspViolations: string[];
}>({
  // ADR 0016: every test also asserts that no page logged a CSP violation. Violations arrive as
  // console errors ("Refused to ...") and as `securitypolicyviolation` events, which the init
  // script re-logs under a marker. A test that provokes one on purpose must splice it out.
  cspViolations: [
    async ({ context }, use) => {
      const violations: string[] = [];
      await context.addInitScript(() => {
        addEventListener("securitypolicyviolation", (e) =>
          console.error(
            `REFILL_CSP_VIOLATION ${e.violatedDirective} ${e.blockedURI}`,
          ),
        );
      });
      context.on("console", (m) => {
        const t = m.text();
        if (
          t.includes("REFILL_CSP_VIOLATION") ||
          t.includes("Content Security Policy")
        )
          violations.push(t);
      });
      await use(violations);
      expect(violations, "CSP violations logged by extension pages").toEqual(
        [],
      );
    },
    { auto: true },
  ],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here.
  context: async ({}, use) => {
    const userDataDir = await mkdtemp(join(tmpdir(), "refill-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
  extensionId: async ({ context }, use) => {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    expect(id).toBe(EXTENSION_ID);
    await settleIdle(worker);
    await use(id);
  },
});

export { expect };
