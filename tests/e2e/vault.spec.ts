import { EXTENSION_ID } from "../../src/manifest-key";
import { expect, test } from "./fixtures";
import { PASSPHRASE, createVault, openOnboarding } from "./vault-helpers";

// Real Argon2id calibration runs on create, so these tests are slower than the smoke tests.
test.setTimeout(90_000);

test("install opens onboarding", async ({ context }) => {
  const opened =
    context.pages().find((p) => p.url().endsWith("/onboarding.html")) ??
    (await context.waitForEvent("page", {
      predicate: (p) => p.url().endsWith("/onboarding.html"),
    }));
  expect(opened.url()).toBe(
    `chrome-extension://${EXTENSION_ID}/onboarding.html`,
  );
});

test("create vault requires acknowledgment, a strong passphrase and a matching confirmation", async ({
  context,
  extensionId,
}) => {
  const page = await openOnboarding(context, extensionId);
  const create = page.getByRole("button", { name: "Create vault" });
  const passphrase = page.getByLabel("Passphrase", { exact: true });
  const confirm = page.getByLabel("Confirm passphrase");
  const ack = page.getByLabel("I understand there is no recovery");
  await expect(create).toBeDisabled();

  // Weak passphrase, confirmed and acknowledged: still disabled.
  await passphrase.fill("password123");
  await confirm.fill("password123");
  await ack.check();
  await expect(create).toBeDisabled();

  // Strong and confirmed, not acknowledged: disabled.
  await ack.uncheck();
  await passphrase.fill(PASSPHRASE);
  await confirm.fill(PASSPHRASE);
  await expect(create).toBeDisabled();

  // Strong and acknowledged, confirmation differs: disabled, with a hint.
  await ack.check();
  await confirm.fill(PASSPHRASE + "x");
  await expect(page.getByText("Passphrases don't match")).toBeVisible();
  await expect(create).toBeDisabled();

  await confirm.fill(PASSPHRASE);
  await expect(page.getByText("Passphrases don't match")).toBeHidden();
  await expect(create).toBeEnabled();
});

test("create, then lock and unlock from the popup", async ({
  context,
  extensionId,
}) => {
  const onboarding = await openOnboarding(context, extensionId);
  await createVault(onboarding);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByText("Unlocked", { exact: true })).toBeVisible();

  await popup.getByRole("button", { name: "Lock now" }).click();
  await expect(popup.getByLabel("Passphrase")).toBeVisible();

  // Wrong passphrase: message appears and receives focus. Submit with Enter.
  const field = popup.getByLabel("Passphrase");
  await field.fill("not the right one at all");
  await field.press("Enter");
  const wrong = popup.getByText("Wrong passphrase", { exact: true });
  await expect(wrong).toBeVisible();
  await expect(wrong).toBeFocused();

  // The failure started the 1 s backoff. Guess again until the backoff copy shows (a guess that
  // lands after the window only doubles it), then retry the right passphrase until it is accepted.
  const backoff = popup.getByText(
    /^Too many attempts — try again in [1-9]\d* s$/,
  );
  await expect(async () => {
    await field.fill("still not the right one");
    await field.press("Enter");
    await expect(backoff).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await expect(async () => {
    await field.fill(PASSPHRASE);
    await field.press("Enter");
    await expect(popup.getByText("Unlocked", { exact: true })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 30_000 });
});

test("a refused create clears both passphrase fields and focuses the message", async ({
  context,
  extensionId,
}) => {
  const first = await openOnboarding(context, extensionId);
  const second = await openOnboarding(context, extensionId);
  await createVault(first);

  await second.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await second.getByLabel("Confirm passphrase").fill(PASSPHRASE);
  await second.getByLabel("I understand there is no recovery").check();
  await second.getByRole("button", { name: "Create vault" }).click();
  const message = second.getByText(
    "A Refill vault already exists. Open Refill from the toolbar.",
  );
  await expect(message).toBeVisible();
  await expect(message).toBeFocused();
  await expect(second.getByLabel("Passphrase", { exact: true })).toHaveValue(
    "",
  );
  await expect(second.getByLabel("Confirm passphrase")).toHaveValue("");
});

test("popup offers setup when there is no vault", async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(
    popup.getByRole("button", { name: "Set up Refill" }),
  ).toBeVisible();
});

test("the popup's Set up Refill button opens a new onboarding tab", async ({
  context,
  extensionId,
}) => {
  const onboardingPages = () =>
    context.pages().filter((p) => p.url().endsWith("/onboarding.html"));
  // The install-time tab may still be opening: wait for it so only the button's tab is new.
  await expect.poll(() => onboardingPages().length).toBe(1);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole("button", { name: "Set up Refill" }).click();
  await expect.poll(() => onboardingPages().length).toBe(2);
});

test("no permission warnings: no granted host origins at runtime", async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const perms = await popup.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: {
          permissions: {
            getAll(): Promise<{ origins?: string[]; permissions?: string[] }>;
          };
        };
      }
    ).chrome.permissions.getAll(),
  );
  // The e2e build pre-grants only the fixture host (ADR 0017); the production manifest's empty
  // host_permissions is asserted by `pnpm test:manifest`.
  expect(perms.origins).toEqual(["https://localhost/*"]);
});
