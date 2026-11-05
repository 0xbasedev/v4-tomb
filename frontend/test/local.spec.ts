import { expect, test, type Page } from "@playwright/test";

/**
 * Live wallet flows against a local anvil Masonry deployment — the paths the
 * Preview suite can't reach: a rejected signature, confirmed transactions,
 * and on-chain state read back after the receipt.
 *
 * Requires (see playwright.local.config.ts):
 *   anvil --port 8545 --code-size-limit 100000
 *   forge script script/DeployMasonryLocal.s.sol:DeployMasonryLocal --broadcast …   (fresh chain)
 *
 * The injected wallet forwards every JSON-RPC request to anvil, where account 0
 * (the deployer, scheduler and every role holder) is unlocked, so
 * eth_sendTransaction really executes. `reject` mode refuses signing the way a
 * user pressing "Cancel" does (EIP-1193 code 4001).
 */

const RPC = "http://127.0.0.1:8545";
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

async function anvilWallet(page: Page) {
  await page.addInitScript(
    ({ rpc, account }) => {
      const w = window as unknown as { __wallet: { reject: boolean; sent: string[] }; ethereum: unknown };
      w.__wallet = { reject: false, sent: [] };
      const listeners: Record<string, ((v: unknown) => void)[]> = {};
      let id = 0;
      w.ethereum = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
          if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
          if (method === "wallet_switchEthereumChain") return null;
          if (/^(eth_sendTransaction|eth_sign|personal_sign|eth_signTypedData)/.test(method)) {
            if (w.__wallet.reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            w.__wallet.sent.push(method);
          }
          const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }) });
          const body = await res.json();
          if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
          return body.result;
        },
        on: (e: string, f: (v: unknown) => void) => void (listeners[e] ??= []).push(f),
        removeListener: (e: string, f: (v: unknown) => void) => void (listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)),
      };
    },
    { rpc: RPC, account: ACCOUNT },
  );
}

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await res.json()).result;
}

async function openAdmin(page: Page) {
  await page.goto("/genesis");
  await connect(page);
  await page.getByRole("link", { name: /(^|\s)Admin$/i }).filter({ visible: true }).first().click();
}

async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("network-note")).toContainText(/Local \(anvil\) · verified deployment/);
}

const setReject = (page: Page, v: boolean) => page.evaluate((x) => ((window as unknown as { __wallet: { reject: boolean } }).__wallet.reject = x), v);

function futureLocal(hours: number) {
  const d = new Date(Date.now() + hours * 3_600_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // Scheduling validates against wall-clock time; a reused chain that was
  // time-travelled by a previous run would make every start "in the past".
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const drift = Number(BigInt(block.timestamp)) - Math.floor(Date.now() / 1000);
  if (Math.abs(drift) > 600) throw new Error(`anvil clock is ${drift}s off wall time — restart anvil and redeploy (fresh chain required).`);
});

test("unscheduled deployment: pass sales closed, Admin readiness all green", async ({ page }) => {
  await anvilWallet(page);
  await page.goto("/genesis");
  await connect(page);
  await expect(page.getByText(/Genesis · not scheduled yet/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Mint Pro" })).toBeDisabled();

  await page.getByRole("link", { name: /(^|\s)Admin$/i }).filter({ visible: true }).first().click();
  const panel = page.getByTestId("genesis-schedule");
  await expect(panel).toContainText("Genesis isn't scheduled yet");
  await expect(panel.getByRole("list", { name: "Readiness checks" }).locator("li")).toHaveCount(6);
  await expect(panel.getByText("✓")).toHaveCount(6, { timeout: 15_000 });
});

test("a rejected signature sends nothing and leaves Genesis unscheduled", async ({ page }) => {
  await anvilWallet(page);
  await openAdmin(page);
  const panel = page.getByTestId("genesis-schedule");
  await expect(panel.getByText("✓")).toHaveCount(6, { timeout: 15_000 });
  await panel.getByLabel("Genesis start").fill(futureLocal(2));
  const nonceBefore = BigInt(await rpc("eth_getTransactionCount", [ACCOUNT, "latest"]));
  await setReject(page, true);
  await panel.getByRole("button", { name: "Confirm Genesis date in wallet" }).click();
  await expect(page.getByText("You declined in your wallet. Nothing was sent.")).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { __wallet: { sent: string[] } }).__wallet.sent)).toEqual([]);
  expect(BigInt(await rpc("eth_getTransactionCount", [ACCOUNT, "latest"]))).toBe(nonceBefore);
  await expect(panel).toContainText("Genesis isn't scheduled yet");
});

test("schedule Genesis: simulate, sign, confirm, read back", async ({ page }) => {
  await anvilWallet(page);
  await openAdmin(page);
  const panel = page.getByTestId("genesis-schedule");
  await expect(panel.getByText("✓")).toHaveCount(6, { timeout: 15_000 });
  await panel.getByLabel("Genesis start").fill(futureLocal(2));
  await panel.getByRole("button", { name: "Confirm Genesis date in wallet" }).click();
  await expect(page.getByText(/Schedule Genesis for .* · Confirmed/)).toBeVisible({ timeout: 20_000 });
  await expect(panel).toContainText(/Scheduled for/, { timeout: 20_000 });
});

test("buy a Pro pass, then stake USDC once Genesis is live", async ({ page }) => {
  await anvilWallet(page);
  // A controllable clock that still runs in real time, so polling keeps working.
  await page.clock.install();
  await page.goto("/genesis");
  await connect(page);
  await expect(page.getByText(/Genesis · starts in/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Mint Pro" }).click();
  await expect(page.getByText(/· Confirmed/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/You hold the Pro pass/)).toBeVisible({ timeout: 20_000 });

  // Move the chain past the scheduled start, then stake in the standard pool.
  // The countdown runs on the browser clock, so move it in step with the chain.
  await rpc("evm_increaseTime", [3 * 3600]);
  await rpc("evm_mine");
  await page.clock.setSystemTime(Date.now() + 3 * 3_600_000 + 60_000);
  const pool0 = page.getByTestId("pool-0");
  await expect(pool0).toContainText(/Open/, { timeout: 15_000 });
  await pool0.getByLabel("Amount to stake in pool 0").fill("100");
  await pool0.getByRole("button", { name: "Stake" }).click();
  await expect(page.getByText(/Stake 100 in the standard pool · (Confirmed|Not sent)/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Stake 100 in the standard pool · Confirmed")).toBeVisible();
  await expect(pool0).toContainText(/Your stake[\s\S]*100/, { timeout: 20_000 });

  // Principal comes back out in the asset's own decimals (USDC: 6).
  await pool0.getByLabel("Amount to stake in pool 0").fill("40");
  await pool0.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("Withdraw from pool 0 · Confirmed")).toBeVisible({ timeout: 20_000 });
  await expect(pool0).toContainText(/Your stake[\s\S]*60/, { timeout: 20_000 });
});
