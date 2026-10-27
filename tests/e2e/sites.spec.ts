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
