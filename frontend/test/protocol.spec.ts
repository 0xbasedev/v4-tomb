import { test, expect } from '@playwright/test';
import { sameWalletSession } from '../src/lib/walletSession';

const routes = ['/', '/dashboard', '/club', '/vault', '/notes', '/swap', '/admin', '/docs'];
for (const width of [1280, 390]) {
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
  await page.getByRole('button', { name: 'Enter The Trust', exact: true }).first().click();
  await expect(page.getByRole('status')).toContainText('unsupported network');
  await expect(page.getByRole('button', { name: 'Authorize · Swap' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Network' }).selectOption('31337');
  await expect(page.getByRole('status')).toContainText('Local EVM has no protocol deployment configured');
  await expect(page.getByRole('button', { name: 'Authorize · Swap' })).toBeDisabled();
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
