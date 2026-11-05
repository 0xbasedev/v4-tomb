import { expect, test } from "./fixtures";

/**
 * Mobile layouts: every screen fits a 412px phone and a 320px small phone
 * with no sideways scroll, the thumb bar replaces the desktop nav, and the
 * recommended next move is reachable without hunting.
 */

const ROUTES = ["/", "/dashboard", "/genesis", "/genesis?genesis=ended", "/farm", "/masonry", "/swap", "/swap?mode=liquidity", "/bonds", "/bridge", "/docs", "/admin", "/wizard"];

for (const width of [412, 320]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: 860 });
    const over: string[] = [];
    for (const r of ROUTES) {
      await page.goto(r, { waitUntil: "domcontentloaded" });
      await page.locator("main, body").first().waitFor();
      await page.waitForTimeout(600);
      const d = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (d > 1) over.push(`${r} +${d}px`);
    }
    expect(over).toEqual([]);
  });
}

test("thumb bar replaces the desktop nav; More holds the rest", async ({ page }) => {
  await page.goto("/dashboard");
  const bar = page.getByRole("navigation", { name: "Primary" });
  await expect(bar).toBeVisible();
  for (const label of ["Dashboard", "Genesis", "Swap", "Bridge"]) await expect(bar.getByRole("link", { name: label })).toBeVisible();
  await bar.getByRole("button", { name: /More/ }).click();
  await expect(page.getByRole("link", { name: "Docs" }).last()).toBeVisible();
});

test("the next move sits near the top of the Dashboard on a phone", async ({ page }) => {
  await page.goto("/dashboard");
  const move = page.getByText("Your next move");
  await move.scrollIntoViewIfNeeded();
  const y = await move.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(y / h).toBeLessThan(0.45);
});
