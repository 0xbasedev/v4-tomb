import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const account = '0x0000000000000000000000000000000000001234';
const releaseId = '0x' + '99'.repeat(32);

test('Wizard validates inputs, predicts addresses, exports a release, and restores the draft in Admin', async ({ page }) => {
  await page.goto('/wizard');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Select a home network.');

  await page.getByLabel('Home network').selectOption('8453');
  await page.getByLabel('Public RPC URL').fill('https://rpc.example.test/');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Release ID', { exact: true }).fill(releaseId);
  for (const label of ['Deployment signer', 'Governance owner', 'Treasury recipient']) {
    await page.getByLabel(label, { exact: true }).fill(account);
  }
  const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 16);
  await page.getByLabel('Genesis start (local time)').fill(tomorrow);
  for (const [name, value] of [
    ['xTOMB authorized launch supply', '10000'],
    ['xSHARE team vesting', '6941'], ['xSHARE developer vesting', '0'],
    ['xSHARE Treasury vesting', '0'], ['xSHARE arbitrage vesting', '0'],
  ]) await page.getByLabel(name, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('xTOMB funding exceeds authorized launch supply');
  await page.getByLabel('xTOMB authorized launch supply', { exact: true }).fill('12000');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await page.getByLabel('Include xSHARE bridge in this release').check();
  for (const name of ['Base', 'Robinhood Chain', 'BNB Smart Chain', 'PulseChain', 'Sonic']) {
    await page.getByLabel(name + ' bridge owner', { exact: true }).fill(account);
    await page.getByLabel(name + ' message verifier', { exact: true }).fill(account);
    if (name !== 'Base') await page.getByLabel(name + ' route cap (base units)', { exact: true }).fill('1000000000000000000');
  }
  await page.getByRole('button', { name: 'Calculate addresses', exact: true }).click();
  await expect(page.getByText('Predicted contract addresses')).toBeVisible();

  const getDownload = async (button: string) => {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: button, exact: true }).click();
    const path = await (await downloaded).path();
    return JSON.parse(await readFile(path!, 'utf8'));
  };
  const masonry = await getDownload('Download address plan');
  const bridge = await getDownload('Download bridge plan');
  const launch = await getDownload('Download launch settings');
  expect(launch.network.infrastructure.universalRouter.toLowerCase()).toBe('0x6ff5693b99212da76ad316178a184ab56d299b43');
  expect(masonry.chainId).toBe(8453);
  expect(masonry.releaseId).toBe(releaseId);
  expect(masonry.addresses.masonrySwapRouter).toMatch(/^0x[0-9a-f]{40}$/i);
  expect(BigInt(masonry.addresses.masonryTaxHook) & 0x3fffn).toBe(0x35c8n);
  expect(bridge.networks[0].token).toBe(masonry.addresses.masonryShare);
  expect(bridge.networks.every(({ enabled }: { enabled: boolean }) => !enabled)).toBe(true);

  await page.getByRole('link', { name: 'Open Admin' }).click();
  await page.reload();
  await expect(page.getByText('Local draft · Base · Chain 8453')).toBeVisible();
  await page.getByRole('button', { name: 'Load address plan' }).click();
  await expect(page.getByText(masonry.addresses.masonryPeg)).toBeVisible();

  let chain = '0x1';
  const methods: string[] = [];
  await page.route('https://rpc.example.test/', async (route) => {
    const { id, method } = route.request().postDataJSON();
    methods.push(method);
    await route.fulfill({ json: { jsonrpc: '2.0', id, result: method === 'eth_chainId' ? chain : method === 'eth_blockNumber' ? '0x123' : '0x' } });
  });
  await page.getByRole('button', { name: 'Check on-chain code' }).click();
  await expect(page.getByRole('alert')).toHaveText('RPC returned chain 1. The release is configured for chain 8453.');
  expect(methods).toEqual(['eth_chainId']);
  chain = '0x2105';
  await page.getByRole('button', { name: 'Check on-chain code' }).click();
  const results = page.getByRole('region', { name: 'On-chain check results' });
  await expect(results).toContainText('Chain 8453 · Block 291');
  await expect(results.getByText('No code').first()).toBeVisible();
  expect(methods.every((method) => ['eth_chainId', 'eth_blockNumber', 'eth_getCode'].includes(method))).toBe(true);
  await page.route('https://pulsechain-rpc.publicnode.com/', async (route) => {
    const { id, method } = route.request().postDataJSON();
    await route.fulfill({ json: { jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x171' : method === 'eth_blockNumber' ? '0x123' : '0x' } });
  });
  await page.getByLabel('Verification network').selectOption('369');
  await expect(results).toHaveCount(0);
  await page.getByRole('button', { name: 'Check on-chain code' }).click();
  await expect(results).toContainText('Chain 369 · Block 291');
  await expect(results.getByText('Wrapped xSHARE')).toBeVisible();
});

test('Wizard prefills only the selected chain and preserves overrides when filling blanks', async ({ page }) => {
  await page.goto('/wizard');
  const network = page.getByLabel('Home network');
  const usdc = page.getByLabel('USDC', { exact: true });
  const poolManager = page.getByLabel('Uniswap V4 PoolManager', { exact: true });
  const positionManager = page.getByLabel('V4 PositionManager', { exact: true });
  const router = page.getByLabel('Uniswap V4 Universal Router', { exact: true });
  const permit2 = page.getByLabel('Permit2', { exact: true });

  await network.selectOption('8453');
  await expect(usdc).toHaveValue('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  await usdc.fill(account);
  await permit2.clear();
  await page.reload();
  await page.getByRole('button', { name: 'Fill missing addresses' }).click();
  await expect(usdc).toHaveValue(account);
  await expect(permit2).toHaveValue('0x000000000022D473030F116dDEE9F6B43aC78BA3');

  for (const [id, expectedPositionManager] of [
    ['4663', '0x58daec3116aae6d93017baaea7749052e8a04fa7'],
    ['56', '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b'],
  ]) {
    await network.selectOption(id);
    await expect(usdc).toHaveValue('');
    await expect(positionManager).toHaveValue(expectedPositionManager);
    await expect(router).toHaveValue(/^0x[\da-f]{40}$/i);
  }
  await network.selectOption('146');
  await expect(usdc).toHaveValue('0x29219dd400f2Bf60E5a23d13Be72B486D4038894');
  for (const field of [poolManager, positionManager, router]) await expect(field).toHaveValue('');
  await network.selectOption('369');
  await expect(usdc).toHaveValue('');
  await expect(permit2).toHaveValue('0x000000000022D473030F116dDEE9F6B43aC78BA3');
  await network.selectOption('custom');
  for (const field of [usdc, poolManager, positionManager, router, permit2]) await expect(field).toHaveValue('');
});

test('Bridge presents all five networks with transfers disabled', async ({ page }) => {
  await page.goto('/bridge');
  await expect(page.getByRole('heading', { name: 'xSHARE Bridge' })).toBeVisible();
  for (const name of ['Base', 'Robinhood Chain', 'BNB Smart Chain', 'PulseChain', 'Sonic']) {
    await expect(page.getByRole('button', { name: `Bridge to ${name} unavailable` })).toBeDisabled();
  }
  await expect(page.getByText('Validator and relayer setup required')).toBeVisible();
});


test('import rejects an invalid draft and restores a valid draft without trusting extra fields', async ({ page }) => {
  await page.goto('/wizard');
  const input = page.getByLabel('Release draft file');
  await input.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.getByRole('alert')).toContainText('Choose an xTOMB release draft');
  await input.setInputFiles({
    name: 'draft.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 1, type: 'xtomb-release-draft',
      fields: { network: '369', chainName: 'PulseChain', chainId: '369', privateKey: 'ignored' },
    })),
  });
  await expect(page.getByLabel('Home network')).toHaveValue('369');
  await page.reload();
  await expect(page.getByLabel('Home network')).toHaveValue('369');
  expect(await page.evaluate(() => localStorage.getItem('xtomb:release-draft:v1'))).not.toContain('privateKey');
});
