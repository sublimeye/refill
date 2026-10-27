import { expect, test } from "./fixtures";
import { FIXTURE_A, FIXTURE_B } from "./fixtures-server";

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
