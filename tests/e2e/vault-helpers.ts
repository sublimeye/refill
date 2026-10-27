import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "./fixtures";

export const PASSPHRASE = "correct horse battery staple";

export async function openOnboarding(context: BrowserContext, id: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/onboarding.html`);
  return page;
}

export async function createVault(page: Page) {
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Confirm passphrase").fill(PASSPHRASE);
  await page.getByLabel("I understand there is no recovery").check();
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(
    page.getByText(
      "Refill is ready. Pin it to your toolbar, then open a form you fill often.",
    ),
  ).toBeVisible({ timeout: 60_000 });
}
