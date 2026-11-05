import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { create3Planner } from '../config/create3-plan.mjs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const viem = require('viem');

export { coreRoles, factory, factoryCodeHash } from '../config/create3-plan.mjs';
export const hashHex = viem.keccak256;
export const { create3Address, planCore, planMasonry, planBridge } = create3Planner(viem);

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

function main([target, template, releaseFile, output, index = '0', ...extra]) {
  if (!['core', 'bridge', 'masonry'].includes(target) || !releaseFile || !output
    || !/^(0|[1-9]\d*)$/.test(index) || extra.length !== 0) {
    throw new Error('Usage: node scripts/create3.mjs <core|bridge|masonry> <template (use - for masonry)> <release> <output> [core-network-index]');
  }
  const release = read(releaseFile);
  const result = target === 'core' ? planCore(read(template), release, Number(index))
    : target === 'bridge' ? planBridge(read(template), release)
    : planMasonry(release);
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(`Wrote predicted addresses to ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
