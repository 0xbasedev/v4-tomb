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
    await page.goto(`/genesis?t=${DAY - 60}&preview=1`);
    await expect(page.getByText(/Genesis · day 1 of 7/i)).toBeVisible();
    await expect(pool(page, 0)).toContainText(/Emissions now\s*100%/);
    await expect(pool(page, 1)).toContainText(/Emissions now\s*0%/);
    await expect(pool(page, 1)).toContainText(/Opens at the start of Day 2/);

    await page.goto(`/genesis?t=${DAY}&preview=1`);
    await expect(page.getByText(/Genesis · day 2 of 7/i)).toBeVisible();
    await expect(pool(page, 1)).toContainText(/Emissions now\s*75%/);
    await expect(pool(page, 0)).toContainText(/Emissions now\s*25%/);
    await expect(pool(page, 1)).not.toContainText(/Opens at the start of Day 2/);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("Genesis end: deposits close, withdrawals and claims stay open", async ({ page, broadcasts }) => {
    await page.goto(`/genesis?t=${7 * DAY - 60}&preview=1`);
    await expect(page.getByText(/Genesis · day 7 of 7/i)).toBeVisible();
    await expect(pool(page, 1)).toContainText(/Emissions now\s*75%/);

    await page.goto(`/genesis?t=${7 * DAY}&preview=1`);
    await expect(page.getByText(/Genesis · complete/i)).toBeVisible();
    await expect(pool(page, 0)).toContainText(/Genesis has ended\. Withdrawals and claims stay open\./);
    await expect(pool(page, 1)).toContainText(/The LP pool closed with Genesis/);
    await expect(pool(page, 0).getByRole("button", { name: "Withdraw" })).toBeVisible();
    await expectNoTransactionRequests(page, broadcasts);
  });
});

test.describe("Swap and the Fire Tax", () => {
  test("shows protocol-owned range status for xTOMB and xSHARE", async ({ page }) => {
    await page.goto("/swap?preview=1");
    await expect(page.getByRole("heading", { name: "Protocol-owned ranges" })).toBeVisible();
    await expect(page.getByText("xTOMB / USDG")).toBeVisible();
    await expect(page.getByText("xSHARE / USDG")).toBeVisible();
    await expect(page.getByText("−18%").first()).toBeVisible();
    await expect(page.getByText("+10%").first()).toBeVisible();
    await expect(page.getByText("±8%").first()).toBeVisible();
  });

  test("buys pay 0%, sells pay one Fire Tax (baseline after Genesis)", async ({ page, broadcasts }) => {
    await page.goto("/swap?genesis=ended&preview=1");
    await preset(page, "Buy xTOMB");
    await amountIn(page).fill("100");
    await expect(page.getByText("Buy xTOMB with USDG · 0% tax")).toBeVisible();
    await expect(feeRow(page)).toContainText("0%");
    await expect(feeRow(page)).toContainText("no sell leg");

    await preset(page, "Sell xTOMB");
    await amountIn(page).fill("100");
    await expect(page.getByText("Sell xTOMB → USDG · 3.4% tax")).toBeVisible();
    await expect(feeRow(page)).toContainText("−$3.40");
    await expect(page.locator("dl")).toContainText(/Pool fee · xTOMB\/USDG/);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("during Genesis an xTOMB sell pays the 3% floor and it burns", async ({ page, broadcasts }) => {
    await page.goto("/swap?genesis=day2&preview=1");
    await preset(page, "Sell xTOMB");
    await amountIn(page).fill("100");
    await expect(page.getByText("Sell xTOMB → USDG · 3.4% tax")).toBeVisible();
    await expect(feeRow(page)).toContainText("−$3.40");
    await expect(page.locator("dl")).toContainText(/burn/i);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("LP → USDC taxes only the sell leg, and offers the untaxed exit", async ({ page, broadcasts }) => {
    await page.goto("/swap?genesis=day2&preview=1");
    await preset(page, "Exit LP to USDG");
    await amountIn(page).fill("10");
    await expect(page.getByText(/^Redeem xTOMB/)).toBeVisible();
    await expect(page.getByText(/Sell xTOMB → USDG · \d+(\.\d+)?% tax/)).toBeVisible();
    await expect(feeRow(page)).toContainText(/[\d.]+% on the xTOMB sold \(50% of value\)/);
    await expect(page.getByText("Take it as xTOMB instead")).toBeVisible();
    await page.getByText("Take it as xTOMB instead").click();
    await expect(page.getByText("Buy xTOMB with USDG · 0% tax")).toBeVisible();
    await expect(feeRow(page)).toContainText("0%");
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("unsupported routes are unavailable with a reason", async ({ page, broadcasts }) => {
    await page.goto("/swap?preview=1");
    await preset(page, "Buy xTOMB");
    await page.getByRole("button", { name: "Choose the token you pay with" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /ETH/ }).click();
    await expect(page.getByRole("button", { name: "Route unavailable" })).toBeDisabled();
    await expect(page.getByRole("note").filter({ hasText: /No official ETH pool/ })).toBeVisible();
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("stale oracle: sells are rejected, buys still go through", async ({ page, broadcasts }) => {
    await page.goto("/swap?oracle=stale&preview=1");
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
    await expect(page.getByRole("heading", { name: "Not launched yet" })).toBeVisible();
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("unsupported chain: the note warns and nothing can be sent", async ({ page, broadcasts }) => {
    await installWallet(page, "0xfa"); // Fantom: neither a Masonry chain nor a bridge network
    await page.goto("/genesis?preview=0");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(note(page)).toContainText(/unsupported network/);
    await expect(page.getByRole("heading", { name: /Coming soon on/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Genesis", exact: true, level: 1 })).toBeVisible();
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("supported chain without a verified deployment: transactions unavailable", async ({ page, broadcasts }) => {
    await installWallet(page, "0x1237"); // Base
    await page.goto("/genesis?preview=0");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(note(page)).toContainText(/Robinhood Chain has no verified xTOMB deployment yet/);
    await expect(page.getByRole("heading", { name: "Not launched yet" })).toBeVisible();
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("Preview with an unsupported wallet still warns, and stays simulated", async ({ page, broadcasts }) => {
    await installWallet(page, "0xfa");
    await page.goto("/dashboard?wallet=0&preview=1");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(note(page)).toContainText(/unsupported network.*Showing simulated data/);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("Admin stays invisible to non-owners", async ({ page }) => {
    await page.goto("/admin?owner=0&preview=1");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  });
});

test.describe("Preview makes zero transaction requests", () => {
  test("pass, stake, claim and swap — all simulated with a real wallet connected", async ({ page, broadcasts }) => {
    test.setTimeout(90_000);
    await installWallet(page, "0x1237");
    await page.goto("/genesis?genesis=day2&pass=none&wallet=0&preview=1");
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

test.describe("Bridge and release plan", () => {
  test("a bridge-only network says so and stays unsupported for Masonry", async ({ page, broadcasts }) => {
    await installWallet(page, "0x38"); // BNB Smart Chain
    await page.goto("/genesis?preview=0");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(note(page)).toContainText(/BNB Smart Chain is an xSHARE bridge network/);
    await expect(page.getByRole("heading", { name: /Coming soon on/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Genesis", exact: true, level: 1 })).toBeVisible();
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("five networks, all disabled; Sonic awaits relayer and verifier setup", async ({ page, broadcasts }) => {
    await page.goto("/bridge?preview=1");
    const nets = page.getByTestId("bridge-networks");
    for (const name of ["Base", "Robinhood Chain", "BNB Smart Chain", "PulseChain", "Sonic"]) await expect(nets).toContainText(name);
    await expect(nets.locator("[data-network=sonic]")).toContainText("Awaiting relayer and verifier setup");
    await expect(nets.locator("[data-network=base]")).toContainText("Bridge unavailable");
    await expect(page.getByRole("button", { name: "Bridge unavailable" })).toBeDisabled();
    await expect(page.getByTestId("bridge-reasons")).toContainText(/No home chain|disabled in the manifest/);
    await expect(page.locator("body")).not.toContainText(/LayerZero|\bOFT\b|ONFT/);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("Wizard predicts addresses from signer + release ID and the Bridge page shows them", async ({ page, broadcasts }) => {
    test.setTimeout(120_000);
    await page.goto("/wizard?preview=1");
    await page.getByRole("button", { name: /Base\s*8453/ }).click();
    await page.getByRole("button", { name: /Release$/ }).click();
    await page.getByRole("textbox", { name: "Deployment signer" }).fill("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    await page.getByRole("textbox", { name: "Release ID" }).fill(`0x${"99".repeat(32)}`);
    const masonry = page.getByTestId("predicted-masonry");
    await expect(masonry).toBeVisible({ timeout: 60_000 });
    await expect(masonry).toContainText("masonryTaxHook");
    await expect(masonry).toContainText("0x35c8 ✓");
    await expect(page.getByTestId("predicted-bridge")).toContainText("xshareBridge");

    await page.getByRole("link", { name: /(^|\s)Bridge$/ }).filter({ visible: true }).first().click();
    await expect(page.getByText(/Home chain in your release plan: Base/)).toBeVisible();
    await expect(page.getByTestId("bridge-networks").locator("[data-network=base]")).toContainText(/home · original xSHARE/);
    await expect(page.getByTestId("bridge-networks").locator("[data-network=pulsechain]")).toContainText(/token 0x.*predicted/);
    await expect(page.getByRole("button", { name: "Bridge unavailable" })).toBeDisabled();
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("Wizard address patterns: a custom prefix is mined and a conflicting hook suffix is refused", async ({ page, broadcasts }) => {
    test.setTimeout(150_000);
    await page.goto("/wizard?preview=1");
    await page.getByRole("button", { name: /Base\s*8453/ }).click();
    await page.getByRole("button", { name: /Release$/ }).click();
    await page.getByRole("textbox", { name: "Deployment signer" }).fill("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    await page.getByRole("textbox", { name: "Release ID" }).fill(`0x${"99".repeat(32)}`);
    await page.getByText("Custom contract addresses").click();
    await page.getByRole("combobox", { name: "Contract to customize" }).selectOption("masonryTaxHook");
    await page.getByRole("textbox", { name: "Address suffix" }).fill("ffff");
    await expect(page.getByRole("alert")).toContainText(/conflicts with Uniswap permissions/);
    await expect(page.getByTestId("predicted-masonry")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Address suffix" }).fill("");
    await page.getByRole("combobox", { name: "Contract to customize" }).selectOption("masonryPeg");
    await page.getByRole("textbox", { name: "Address prefix" }).fill("ab");
    const masonry = page.getByTestId("predicted-masonry");
    await expect(masonry).toBeVisible({ timeout: 90_000 });
    await expect(masonry).toContainText(/masonryPeg · pattern · nonce \d+/);
    await expect(masonry.getByRole("button", { name: /^0xab/i }).first()).toBeVisible();
    await expectNoTransactionRequests(page, broadcasts);
  });
});

test.describe("Deferred Genesis scheduling", () => {
  test("unscheduled Genesis with closed sale: passes and staking stay closed", async ({ page, broadcasts }) => {
    await page.goto("/genesis?genesis=unscheduled&pass=none&sale=closed&preview=1");
    await expect(page.getByText(/Genesis · not scheduled yet/i)).toBeVisible();
    await expect(page.getByText("Not set yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mint Pro" })).toBeDisabled();
    await expect(page.getByText(/Sale not open yet/).first()).toBeVisible();
    await expect(pool(page, 0)).toContainText(/Staking opens once the scheduler sets the start date/);
    await expectNoTransactionRequests(page, broadcasts);
  });

  test("Admin schedules Genesis once: readiness checks, a future date, then it's permanent", async ({ page, broadcasts }) => {
    await page.goto("/admin?genesis=unscheduled&preview=1");
    const panel = page.getByTestId("genesis-schedule");
    await expect(panel).toContainText("Genesis isn't scheduled yet");
    await expect(panel.getByRole("button", { name: /Schedule Genesis/ })).toBeDisabled();
    await expect(panel).toContainText("Pick the start date and time.");
    const future = new Date(Date.now() + 3 * 86_400_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await panel.getByLabel("Genesis start").fill(local);
    await expect(panel).toContainText(/sent as \d+/);
    await panel.getByRole("button", { name: /Schedule Genesis/ }).click();
    await expect(panel).toContainText(/Scheduled for/, { timeout: 10_000 });
    await expect(panel.getByRole("button", { name: /Schedule Genesis/ })).toHaveCount(0);
    await expectNoTransactionRequests(page, broadcasts);
  });
});


test.describe("Farm zap and withdraw cooldown", () => {
  test("replaces Claim with Zap into Masonry and shows the forfeit countdown", async ({ page, broadcasts }) => {
    await page.goto("/farm?preview=1");
    await page.getByTestId("farm-pool-xTOMB-USDC").screenshot({ path: "/workspace/v4-assess/shots/farm-zap-card.png" });
    await expect(page.getByRole("button", { name: "Zap into Masonry" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Claim" })).toHaveCount(0);
    await expect(page.getByText("This is for protocol stability. All X Share earned in the farm must be aged in the Masonry before it can be claimed.").first()).toBeVisible();
    await page.getByRole("button", { name: "Withdraw" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("withdraw-countdown")).toBeVisible();
    await expect(page.getByTestId("withdraw-live-rewards")).toContainText("xSHARE");
    await expect(page.getByText(/forfeited to the DAO wallet/i)).toBeVisible();
    await expect(page.getByText("You can cancel this timer by hitting Compound or Cancel.")).toBeVisible();
    const dialog = page.getByRole("dialog");
    await expect(page.getByTestId("withdraw-fee")).toContainText("2%");
    await dialog.screenshot({ path: "/workspace/v4-assess/shots/withdraw-cooldown-modal.png" });
    await expect(dialog.getByRole("button", { name: "Compound" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Complete withdrawal" })).toBeDisabled();
    await expectNoTransactionRequests(page, broadcasts);
  });
});

test.describe("Farm compound restyle", () => {
  test("is green when the window is clear and muted while counting", async ({ page, broadcasts }) => {
    await page.goto("/farm?preview=1");
    const readyCard = page.getByTestId("farm-pool-xTOMB-USDC");
    await expect(readyCard.getByTestId("compound-button")).toHaveAttribute("data-ready", "true");
    await expect(readyCard.getByTestId("next-compound")).toHaveText("Next Compound: 0");
    await readyCard.screenshot({ path: "/workspace/v4-assess/shots/farm-compound-ready.png" });
    await page.getByRole("button", { name: "Withdraw" }).first().click();
    const readyDialog = page.getByRole("dialog");
    await expect(readyDialog.getByTestId("compound-button")).toHaveAttribute("data-ready", "true");
    await expect(readyDialog.getByTestId("next-compound")).toHaveText("Next Compound: 0");
    await readyDialog.screenshot({ path: "/workspace/v4-assess/shots/withdraw-compound-ready.png" });
    await readyDialog.getByRole("button", { name: "Close" }).click().catch(async () => {
      await page.keyboard.press("Escape");
    });

    await page.goto("/farm?preview=1&compounded=xTOMB-USDC");
    const cooling = page.getByTestId("farm-pool-xTOMB-USDC");
    const other = page.getByTestId("farm-pool-xSHARE-USDC");
    await expect(cooling.getByTestId("compound-button")).toHaveAttribute("data-ready", "false");
    await expect(cooling.getByTestId("compound-button")).toBeEnabled();
    await expect(cooling.getByTestId("next-compound")).toContainText("Next Compound:");
    await expect(cooling.getByTestId("next-compound")).not.toHaveText("Next Compound: 0");
    await expect(cooling.getByTestId("compound-button")).toHaveAttribute("title", /Green returns/i);
    await expect(other.getByTestId("compound-button")).toHaveAttribute("data-ready", "true");
    await expect(other.getByTestId("next-compound")).toHaveText("Next Compound: 0");
    await cooling.screenshot({ path: "/workspace/v4-assess/shots/farm-compound-cooling.png" });
    await cooling.getByRole("button", { name: "Withdraw" }).click();
    const coolDialog = page.getByRole("dialog");
    await expect(coolDialog.getByTestId("compound-button")).toHaveAttribute("data-ready", "false");
    await expect(coolDialog.getByTestId("next-compound")).not.toHaveText("Next Compound: 0");
    await coolDialog.screenshot({ path: "/workspace/v4-assess/shots/withdraw-compound-cooling.png" });
    await expectNoTransactionRequests(page, broadcasts);
  });
});
