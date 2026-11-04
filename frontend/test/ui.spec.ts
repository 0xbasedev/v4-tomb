import { expect, expectNoTransactionRequests, installWallet, note, test } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Screen-level checks, run on desktop and on a phone. Preview mode is on (no
 * verified deployment), so every action is simulated — each test ends by
 * proving the wallet was never asked to sign or send.
 */

const DAY = 86_400;
const pool = (page: Page, i: 0 | 1) => page.getByTestId(`pool-${i}`);
const amountIn = (page: Page) => page.getByLabel(/^Amount of .* to pay$/);
const feeRow = (page: Page) => page.locator("dl div").filter({ has: page.locator("dt", { hasText: /^Fire Tax$/ }) });

async function preset(page: Page, title: string) {
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
}

test.describe("Genesis boundaries", () => {
  test("Day 1 → Day 2: the LP pool opens and takes 75%", async ({ page, broadcasts }) => {
    await page.goto(`/genesis?t=${DAY - 5}`);
    await expect(page.getByText(/Genesis · day 1 of 7/i)).toBeVisible();
    await expect(pool(page, 0)).toContainText(/Emissions now\s*100%/);
    await expect(pool(page, 1)).toContainText(/Emissions now\s*0%/);
    await expect(pool(page, 1)).toContainText(/Opens at the start of Day 2/);

    await page.goto(`/genesis?t=${DAY}`);
    await expect(page.getByText(/Genesis · day 2 of 7/i)).toBeVisible();
    await expect(pool(page, 1)).toContainText(/Emissions now\s*75%/);
    await expect(pool(page, 0)).toContainText(/Emissions now\s*25%/);
    await expect(pool(page, 1)).not.toContainText(/Opens at the start of Day 2/);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("Genesis end: deposits close, withdrawals and claims stay open", async ({ page, broadcasts }) => {
    await page.goto(`/genesis?t=${7 * DAY - 5}`);
    await expect(page.getByText(/Genesis · day 7 of 7/i)).toBeVisible();
    await expect(pool(page, 1)).toContainText(/Emissions now\s*75%/);

    await page.goto(`/genesis?t=${7 * DAY}`);
    await expect(page.getByText(/Genesis · complete/i)).toBeVisible();
    await expect(pool(page, 0)).toContainText(/Genesis has ended\. Withdrawals and claims stay open\./);
    await expect(pool(page, 1)).toContainText(/The LP pool closed with Genesis/);
    await expect(pool(page, 0).getByRole("button", { name: "Withdraw" })).toBeVisible();
    await expectNoTransactionRequests(page, broadcasts);
  });
});

test.describe("Swap and the Fire Tax", () => {
  test("buys pay 0%, sells pay one Fire Tax (baseline after Genesis)", async ({ page, broadcasts }) => {
    await page.goto("/swap?genesis=ended");
    await preset(page, "Buy xTOMB");
    await amountIn(page).fill("100");
    await expect(page.getByText("Buy xTOMB with USDC · 0% tax")).toBeVisible();
    await expect(feeRow(page)).toContainText("0%");
    await expect(feeRow(page)).toContainText("no sell leg");

    await preset(page, "Sell xTOMB");
    await amountIn(page).fill("100");
    await expect(page.getByText("Sell xTOMB → USDC · 1% tax")).toBeVisible();
    await expect(feeRow(page)).toContainText("−$1.00");
    await expect(page.locator("dl")).toContainText(/Pool fee · xTOMB\/USDC/);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("during Genesis an xTOMB sell pays the 3% floor and it burns", async ({ page, broadcasts }) => {
    await page.goto("/swap?genesis=day2");
    await preset(page, "Sell xTOMB");
    await amountIn(page).fill("100");
    await expect(page.getByText("Sell xTOMB → USDC · 3% tax")).toBeVisible();
    await expect(feeRow(page)).toContainText("−$3.00");
    await expect(page.locator("dl")).toContainText(/burn/i);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("LP → USDC taxes only the sell leg, and offers the untaxed exit", async ({ page, broadcasts }) => {
    await page.goto("/swap?genesis=day2");
    await preset(page, "Exit LP to USDC");
    await amountIn(page).fill("10");
    await expect(page.getByText(/^Redeem xTOMB/)).toBeVisible();
    await expect(page.getByText("Sell xTOMB → USDC · 3% tax")).toBeVisible();
    await expect(feeRow(page)).toContainText(/3% on the xTOMB sold \(50% of value\)/);
    await expect(page.getByText("Take it as xTOMB instead")).toBeVisible();
    await page.getByText("Take it as xTOMB instead").click();
    await expect(page.getByText("Buy xTOMB with USDC · 0% tax")).toBeVisible();
    await expect(feeRow(page)).toContainText("0%");
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("unsupported routes are unavailable with a reason", async ({ page, broadcasts }) => {
    await page.goto("/swap");
    await preset(page, "Buy xTOMB");
    await page.getByRole("button", { name: "Choose the token you pay with" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /ETH/ }).click();
    await expect(page.getByRole("button", { name: "Route unavailable" })).toBeDisabled();
    await expect(page.getByRole("note").filter({ hasText: /No official ETH pool/ })).toBeVisible();
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("stale oracle: sells are rejected, buys still go through", async ({ page, broadcasts }) => {
    await page.goto("/swap?oracle=stale");
    await preset(page, "Sell xTOMB");
    await amountIn(page).fill("10");
    await expect(feeRow(page)).toContainText("sell rejected");
    await expect(page.getByRole("button", { name: "Sell rejected" })).toBeDisabled();
    await expect(page.getByText(/no valid TWAP/i).first()).toBeVisible();

    await preset(page, "Buy xTOMB");
    await amountIn(page).fill("10");
    await expect(page.getByRole("button", { name: /^Buy.*\(simulated\)$|^Swap \(simulated\)$/ })).toBeEnabled();
    await expectNoTransactionRequests(page, broadcasts);
  });
});

test.describe("Wallet and network states", () => {
  test("disconnected wallet: actions say why", async ({ page, broadcasts }) => {
    await installWallet(page);
    await page.goto("/genesis?preview=0");
    await expect(note(page)).toContainText("Wallet disconnected");
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expect(pool(page, 0)).toContainText("Connect a wallet to continue.");
    await expect(pool(page, 0).getByRole("button", { name: "Stake" })).toBeDisabled();
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("unsupported chain: the note warns and nothing can be sent", async ({ page, broadcasts }) => {
    await installWallet(page, "0x38"); // BNB Chain: no Uniswap v4 + native USDC entry in the registry
    await page.goto("/genesis?preview=0");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(note(page)).toContainText(/unsupported network/);
    await expect(pool(page, 0)).toContainText("Switch to a supported network.");
    await expect(pool(page, 0).getByRole("button", { name: "Stake" })).toBeDisabled();
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("supported chain without a verified deployment: transactions unavailable", async ({ page, broadcasts }) => {
    await installWallet(page, "0x2105"); // Base
    await page.goto("/genesis?preview=0");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(note(page)).toContainText(/Base has no verified xTOMB deployment yet/);
    await expect(pool(page, 0)).toContainText(/No verified xTOMB deployment on Base/);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("Preview with an unsupported wallet still warns, and stays simulated", async ({ page, broadcasts }) => {
    await installWallet(page, "0x38");
    await page.goto("/dashboard?wallet=0");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(note(page)).toContainText(/unsupported network.*Showing simulated data/);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("Admin stays invisible to non-owners", async ({ page }) => {
    await page.goto("/admin?owner=0");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  });
});

test.describe("Preview makes zero transaction requests", () => {
  test("pass, stake, claim and swap — all simulated with a real wallet connected", async ({ page, broadcasts }) => {
    test.setTimeout(90_000);
    await installWallet(page, "0x2105");
    await page.goto("/genesis?genesis=day2&pass=none&wallet=0");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(note(page)).toContainText(/Showing simulated data/);

    await page.getByRole("button", { name: "Mint Pro" }).click();
    await expect(page.getByText(/Simulated/).filter({ hasText: /Pass|Mint|Pro/ }).first()).toBeVisible();
    await expect(page.getByText(/You hold the Pro pass/)).toBeVisible({ timeout: 10_000 });

    await pool(page, 0).getByLabel("Amount to stake in pool 0").fill("100");
    await pool(page, 0).getByRole("button", { name: "Stake" }).click();
    await expect(page.getByText(/Preview mode — no transaction was requested or sent/).first()).toBeVisible({ timeout: 10_000 });

    // Let something accrue, then claim through the settle sheet.
    await page.waitForTimeout(1500);
    await pool(page, 0).getByRole("button", { name: "Claim to wallet" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Claim \(simulated\)/ }).click();
    await expect(page.getByText(/Preview mode — no transaction was requested or sent/).first()).toBeVisible();

    // Client-side navigation keeps the wallet connection and the simulated state.
    await page.getByRole("link", { name: /(^|\s)Swap$/ }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/swap/);
    await expect(note(page)).toContainText(/Showing simulated data/);
    await preset(page, "Buy xTOMB");
    await amountIn(page).fill("25");
    await page.getByRole("button", { name: /^Buy.*\(simulated\)$|^Swap \(simulated\)$/ }).click();
    await expect(page.getByText(/Preview mode — no transaction was requested or sent/).first()).toBeVisible();

    await expectNoTransactionRequests(page, broadcasts);
  });
});
