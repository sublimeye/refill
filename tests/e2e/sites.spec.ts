import { expect, test } from "./fixtures";
import { FIXTURE_A, FIXTURE_B } from "./fixtures-server";
import { createVault, openOnboarding } from "./vault-helpers";

test("fixture origins are reachable", async ({ context, sites }) => {
  void sites;
  const page = await context.newPage();
  for (const origin of [FIXTURE_A, FIXTURE_B]) {
    await page.goto(`${origin}/`);
    await expect(page.getByText("fixture ok")).toBeVisible();
  }
});

// Task 3: the reconciler registers the unlisted script and `site-enable` injects it into an
// already-open tab. The e2e build pre-grants https://localhost/* (ADR 0017), so the "already
// granted" path applies and no permission prompt is needed.
test("site-enable registers and injects the content script; site-remove stops it", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const fixture = await context.newPage();
  await fixture.goto(`${FIXTURE_A}/`);
  await expect(fixture.locator("html")).not.toHaveAttribute(
    "data-refill-loaded",
    "1",
  );

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  type Chrome = {
    chrome: {
      runtime: { sendMessage(m: unknown): Promise<unknown> };
      tabs: { query(q: unknown): Promise<{ id: number; url: string }[]> };
    };
  };
  const send = (msg: unknown) =>
    popup.evaluate(
      (m) => (globalThis as unknown as Chrome).chrome.runtime.sendMessage(m),
      msg,
    );
  const tabId = await popup.evaluate(async (origin) => {
    const tabs = await (globalThis as unknown as Chrome).chrome.tabs.query({});
    return tabs.find((t) => t.url?.startsWith(origin))?.id;
  }, FIXTURE_A);
  expect(typeof tabId).toBe("number");

  expect(await send({ type: "site-enable", tabId, origin: FIXTURE_A })).toEqual(
    {
      ok: true,
    },
  );
  // executeScript path: marked without a reload.
  await expect(fixture.locator("html")).toHaveAttribute(
    "data-refill-loaded",
    "1",
  );
  expect(await send({ type: "site-status", origin: FIXTURE_A })).toMatchObject({
    enabled: true,
    granted: true,
    accessRevoked: false,
  });

  // registerContentScripts path: a reload gets the script from the registration.
  await fixture.reload();
  await expect(fixture.locator("html")).toHaveAttribute(
    "data-refill-loaded",
    "1",
  );

  // The permission is required in the e2e build, so removing it fails (non-fatal); the record
  // goes and the registration is dropped.
  expect(await send({ type: "site-remove", origin: FIXTURE_A })).toEqual({
    ok: true,
  });
  expect(await send({ type: "site-status", origin: FIXTURE_A })).toMatchObject({
    enabled: false,
  });
  await fixture.reload();
  await expect(fixture.locator("html")).not.toHaveAttribute(
    "data-refill-loaded",
    "1",
  );
});

// Task 4: the popup's "This site" section. The popup is opened as a tab, so the e2e build reads
// the target tab from seam query params (production reads tabs.query({ active, currentWindow })).
// The e2e build pre-grants https://localhost/*, so "Enable" takes the already-granted path.
test.describe("popup: this site", () => {
  test.setTimeout(90_000); // vault creation runs real Argon2id calibration

  type Ctx = Parameters<Parameters<typeof test>[2]>[0]["context"];
  type Chrome = {
    chrome: {
      tabs: { query(q: unknown): Promise<{ id: number; url: string }[]> };
      storage: {
        session: { get(k: string): Promise<Record<string, unknown>> };
      };
      runtime: { sendMessage(m: unknown): Promise<unknown> };
    };
  };

  async function tabIdOf(context: Ctx, url: string) {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = await worker.evaluate(async (origin) => {
      const tabs = await (globalThis as unknown as Chrome).chrome.tabs.query(
        {},
      );
      return tabs.find((t) => t.url?.startsWith(origin))?.id;
    }, url);
    expect(typeof id).toBe("number");
    return id!;
  }

  async function openPopup(
    context: Ctx,
    extensionId: string,
    tabId: number,
    url: string,
  ) {
    const popup = await context.newPage();
    const q = new URLSearchParams({
      __refillE2E_tabId: String(tabId),
      __refillE2E_url: url,
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?${q}`);
    return popup;
  }

  const pendingIntent = (context: Ctx) =>
    context
      .serviceWorkers()[0]!
      .evaluate(
        async () =>
          (
            await (globalThis as unknown as Chrome).chrome.storage.session.get(
              "sites:intent",
            )
          )["sites:intent"] ?? null,
      );

  test("enable, status and remove, with in-popup confirmation", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    await createVault(await openOnboarding(context, extensionId));
    const fixture = await context.newPage();
    await fixture.goto(`${FIXTURE_A}/`);
    const marker = fixture.locator("html");
    await expect(marker).not.toHaveAttribute("data-refill-loaded", "1");
    const popup = await openPopup(
      context,
      extensionId,
      await tabIdOf(context, FIXTURE_A),
      `${FIXTURE_A}/`,
    );

    await expect(
      popup.getByRole("heading", { name: "This site" }),
    ).toBeVisible();
    await expect(
      popup.getByText("Refill will ask Chrome for access to this site only."),
    ).toBeVisible();
    await popup
      .getByRole("button", { name: "Enable Refill on this site" })
      .click();
    const enabled = popup.getByText("Enabled on localhost:4510", {
      exact: true,
    });
    await expect(enabled).toBeVisible();
    await expect(enabled).toBeFocused();
    // Injected into the open tab (executeScript path): no reload.
    await expect(marker).toHaveAttribute("data-refill-loaded", "1");
    // The intent was consumed by site-enable.
    expect(await pendingIntent(context)).toBeNull();

    // Cancel keeps the site.
    await popup.getByRole("button", { name: "Remove site" }).click();
    const confirm = popup.getByText(
      "Remove localhost:4510 and its saved form?",
    );
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeFocused();
    await popup.getByRole("button", { name: "Cancel" }).click();
    await expect(enabled).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Remove site" }),
    ).toBeFocused();

    // Remove, confirmed.
    await popup.getByRole("button", { name: "Remove site" }).click();
    await popup.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(
      popup.getByRole("button", { name: "Enable Refill on this site" }),
    ).toBeVisible();
    await expect(enabled).toBeHidden();

    // The registration is gone: a reload gets no script.
    await fixture.reload();
    await expect(marker).not.toHaveAttribute("data-refill-loaded", "1");

    // P8: an unconsumed intent cannot resurrect a removed site. Leave one behind, remove, and the
    // intent is gone; with access still granted (e2e build) a reload stays unmarked.
    const tabId = await tabIdOf(context, FIXTURE_A);
    await popup.evaluate(
      (m) => (globalThis as unknown as Chrome).chrome.runtime.sendMessage(m),
      { type: "site-intent", tabId, origin: FIXTURE_A },
    );
    expect(await pendingIntent(context)).toMatchObject({ origin: FIXTURE_A });
    await popup.evaluate(
      (m) => (globalThis as unknown as Chrome).chrome.runtime.sendMessage(m),
      { type: "site-remove", origin: FIXTURE_A },
    );
    expect(await pendingIntent(context)).toBeNull();
    await fixture.reload();
    await expect(marker).not.toHaveAttribute("data-refill-loaded", "1");
  });

  test("works while the vault is locked, and a non-https tab shows the https-only copy", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    await createVault(await openOnboarding(context, extensionId));
    const fixture = await context.newPage();
    await fixture.goto(`${FIXTURE_A}/`);
    const tabId = await tabIdOf(context, FIXTURE_A);
    const popup = await openPopup(context, extensionId, tabId, `${FIXTURE_A}/`);

    await popup.getByRole("button", { name: "Lock now" }).click();
    await expect(popup.getByLabel("Passphrase")).toBeVisible();
    await popup
      .getByRole("button", { name: "Enable Refill on this site" })
      .click();
    await expect(
      popup.getByText("Enabled on localhost:4510", { exact: true }),
    ).toBeVisible();
    await expect(fixture.locator("html")).toHaveAttribute(
      "data-refill-loaded",
      "1",
    );
    await popup.getByRole("button", { name: "Remove site" }).click();
    await popup.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(
      popup.getByRole("button", { name: "Enable Refill on this site" }),
    ).toBeVisible();

    const insecure = await openPopup(
      context,
      extensionId,
      tabId,
      "about:blank",
    );
    await expect(
      insecure.getByText("Refill works on secure (https) sites only."),
    ).toBeVisible();
    await expect(insecure.getByRole("button", { name: /Enable/ })).toHaveCount(
      0,
    );
  });

  test("the section is hidden until a vault exists", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const fixture = await context.newPage();
    await fixture.goto(`${FIXTURE_A}/`);
    const popup = await openPopup(
      context,
      extensionId,
      await tabIdOf(context, FIXTURE_A),
      `${FIXTURE_A}/`,
    );
    await expect(
      popup.getByRole("button", { name: "Set up Refill" }),
    ).toBeVisible();
    await expect(popup.getByText("This site")).toHaveCount(0);
  });
});
