import { test, expect } from '@playwright/test';
import { sameWalletSession } from '../src/lib/walletSession';

const routes = ['/', '/dashboard', '/genesis', '/farm', '/masonry', '/swap', '/docs', '/club', '/vault', '/notes', '/admin', '/wizard', '/bridge'];
for (const width of [1280, 390, 320]) {
  test(`all routes render without errors or overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator('h1')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (route !== '/') await expect(page.getByRole('status')).toContainText('no protocol deployment configured');
    }
    expect(errors).toEqual([]);
  });
}

test('unsupported wallet can switch to the configured chain without requesting transactions', async ({ page }) => {
  await page.addInitScript(() => {
    let chain = '0x1';
    const callbacks: Record<string, Array<(value: string) => void>> = {};
    const requests: string[] = [];
    Object.assign(window, {
      walletRequests: requests,
      ethereum: {
        isMetaMask: true,
        on(event: string, callback: (value: string) => void) { (callbacks[event] ||= []).push(callback); },
        removeListener(event: string, callback: (value: string) => void) {
          callbacks[event] = (callbacks[event] || []).filter(value => value !== callback);
        },
        async request({ method, params }: { method: string; params: Array<{ chainId: string }> }) {
          requests.push(method);
          if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return ['0x00000000000000000000000000000000000000a1'];
          if (method === 'eth_chainId') return chain;
          if (['wallet_requestPermissions', 'wallet_getPermissions'].includes(method)) return [{ parentCapability: 'eth_accounts' }];
          if (method === 'wallet_switchEthereumChain') {
            chain = params[0].chainId;
            for (const callback of callbacks.chainChanged || []) callback(chain);
            return null;
          }
          if (method === 'eth_sendTransaction') throw new Error('Transactions disabled in browser test');
          return null;
        },
      },
    });
  });
  await page.goto('/swap');
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
  await expect(page.getByRole('status')).toContainText('unsupported network');
  await expect(page.getByRole('button', { name: 'Swap unavailable' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Network' }).selectOption('31337');
  await expect(page.getByRole('status')).toContainText('Local EVM has no protocol deployment configured');
  await expect(page.getByRole('button', { name: 'Swap unavailable' })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { walletRequests: string[] }).walletRequests.filter(method => method === 'eth_sendTransaction'))).toEqual([]);
});

test('transaction sessions reject account, network, and disconnection changes', () => {
  const origin = { chainId: 777, address: '0x00aA' as const };
  expect(sameWalletSession(origin, { chainId: 777, address: '0x00aa' })).toBe(true);
  expect(sameWalletSession(origin, { ...origin, chainId: 888 })).toBe(false);
  expect(sameWalletSession(origin, { ...origin, address: '0x00bb' })).toBe(false);
  expect(sameWalletSession(origin, {})).toBe(false);
  expect(sameWalletSession(null, origin)).toBe(false);
});

test('Genesis uses the current NFT tiers, timing and xTOMB pair', async ({ page }) => {
  await page.goto('/genesis');
  await expect(page.getByText('Day 2', { exact: true })).toBeVisible();
  await expect(page.getByText('7 days', { exact: true })).toBeVisible();
  for (const [tier, price] of [['Genesis', 50], ['Pro', 100], ['Ultra', 500]] as const) {
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: tier, exact: true }) });
    await expect(card.getByText(`${price} USDC`)).toBeVisible();
    await expect(card.getByRole('button', { name: `Mint ${tier}` })).toBeDisabled();
  }
  await expect(page.getByRole('heading', { name: 'xTOMB/USDC LP' })).toBeVisible();
});

test('Fire Tax simulator applies one capped sell rate and zero buy tax', async ({ page }) => {
  await page.goto('/swap');
  const estimate = page.getByLabel('Estimated Fire Tax');
  await expect(estimate).toHaveText('3%');
  await page.getByLabel('Asset').selectOption('xSHARE');
  await expect(estimate).toHaveText('6%');
  await page.getByLabel('Projected price / reference').fill('0.8500');
  await expect(estimate).toHaveText('12%');
  await page.getByLabel('Direction').selectOption('buy');
  await expect(estimate).toHaveText('0%');
  await page.getByLabel('Direction').selectOption('sell');
  await page.getByLabel('During Genesis').uncheck();
  await page.getByLabel('Projected price / reference').fill('1');
  await page.getByLabel('Recovery floor (%)').fill('7');
  await expect(estimate).toHaveText('7%');
  await page.getByLabel('Recovery floor (%)').fill('13');
  await expect(estimate).toHaveText('—');
  await expect(page.getByRole('button', { name: 'Swap unavailable' })).toBeDisabled();
});

test('dashboard simulator distinguishes defense from expansion', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Defense', exact: true }).click();
  await expect(page.getByText('At or below the Critical Defense threshold.')).toBeVisible();
  await page.getByRole('button', { name: 'Above gate', exact: true }).click();
  await expect(page.getByText('Above the expansion price gate.', { exact: false })).toBeVisible();
});
