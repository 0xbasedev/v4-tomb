import { mkdir } from "node:fs/promises";
import { test, expect, installWallet, walletLog, expectNoTransactionRequests } from "./fixtures";

test("Robinhood is unlaunched by default; expansions show coming soon", async ({ page }, testInfo) => {
  await page.goto("/genesis");
  await expect(page.getByRole("heading", { name: "Not launched yet" })).toBeVisible();
  await expect(page.getByText("USDG", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Select chain" }).click();
  await expect(page.getByRole("button", { name: /Base · Coming soon/ })).toBeVisible();
  await mkdir("/workspace/v4-assess/shots", { recursive: true });
  await page.screenshot({ path: `/workspace/v4-assess/shots/chain-dropdown-${testInfo.project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: /Base · Coming soon/ }).click();
  await expect(page.getByRole("heading", { name: "Coming soon on Base" })).toBeVisible();
  await page.screenshot({ path: `/workspace/v4-assess/shots/coming-soon-base-${testInfo.project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "Switch back to Robinhood Chain" }).click();
  await expect(page.getByRole("heading", { name: "Not launched yet" })).toBeVisible();
});


test("wrong wallet chain returns to Robinhood without a transaction", async ({ page, broadcasts }) => {
  await installWallet(page, "0x2105");
  await page.goto("/swap");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByRole("heading", { name: "Coming soon on Base" })).toBeVisible();
  await page.getByRole("button", { name: "Switch back to Robinhood Chain" }).click();
  await expect(page.getByRole("heading", { name: "Not launched yet" })).toBeVisible();
  await expectNoTransactionRequests(page, broadcasts);
});

test("sale is independent of the Genesis start and Admin toggle is simulated", async ({ page, broadcasts }) => {
  await page.goto("/genesis?preview=1&genesis=unscheduled&sale=closed&pass=none");
  await expect(page.getByText("Sale not open yet").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Mint Pro" })).toBeDisabled();
  await page.goto("/admin?preview=1&genesis=unscheduled&sale=closed");
  await page.getByRole("button", { name: "Open NFT sale (simulated)" }).click();
  await expect(page.getByTestId("genesis-sale")).toContainText("NFT sale: Open");
  await page.getByRole("button", { name: "Close NFT sale (simulated)" }).click();
  await expect(page.getByTestId("genesis-sale")).toContainText("Sale not open yet");
  await expectNoTransactionRequests(page, broadcasts);
});


test("unlaunched chain screens fit a small phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 860 });
  await page.goto("/genesis");
  await page.getByRole("button", { name: "Select chain" }).click();
  await page.getByRole("button", { name: /Base · Coming soon/ }).click();
  const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })));
  expect(overflow).toEqual([]);
});


for (const behavior of ["missing", "rejected"] as const) {
  test(`return switch handles ${behavior} network without transactions`, async ({ page, broadcasts }) => {
    await installWallet(page, "0x2105", behavior);
    await page.goto("/genesis");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.getByRole("heading", { name: "Coming soon on Base" })).toBeVisible();
    await page.getByRole("button", { name: "Switch back to Robinhood Chain" }).click();
    if (behavior === "missing") {
      await expect(page.getByRole("heading", { name: "Not launched yet" })).toBeVisible();
      expect((await walletLog(page)).calls).toContain("wallet_addEthereumChain");
    } else {
      await expect(page.getByRole("alert")).toContainText("Network switch was not completed");
      const calls = (await walletLog(page)).calls;
      expect(calls.filter((m) => m === "wallet_switchEthereumChain")).toHaveLength(1);
      expect(calls).not.toContain("wallet_addEthereumChain");
    }
    await expectNoTransactionRequests(page, broadcasts);
  });
}
