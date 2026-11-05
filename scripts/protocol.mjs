import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseNetworks, deploymentKeys } from '../config/schema.mjs';

export function readManifest(file = 'config/networks.json') {
  const document = JSON.parse(readFileSync(file, 'utf8'));
  return { document, networks: parseNetworks(document) };
}

export async function publishDeployment(document, artifact, broadcast, index, rpc) {
  const networks = parseNetworks(document);
  const network = networks[index];
  if (!network || Number(artifact.chainId) !== network.id || Number(broadcast.chain) !== network.id) {
    throw new Error('Deployment, broadcast and selected network must use the same chain ID');
  }
  const deployment = Object.fromEntries(deploymentKeys.map((key) => [key, artifact[key]]));
  // Validate addresses before sending any RPC requests.
  deployment.deployBlock = '0';
  const candidate = structuredClone(document);
  candidate.networks[index].deployment = deployment;
  parseNetworks(candidate);
  if (Number(BigInt(await rpc('eth_chainId', []))) !== network.id) throw new Error('RPC chain mismatch');
  const transactions = broadcast.transactions;
  if (!Array.isArray(transactions) || !transactions.length || transactions.some((tx) => !/^0x[\da-f]{64}$/i.test(tx.hash ?? ''))) {
    throw new Error('A completed broadcast with transaction hashes is required; simulation output is insufficient');
  }
  const receipts = await Promise.all(transactions.map((tx) => rpc('eth_getTransactionReceipt', [tx.hash])));
  if (receipts.some((receipt) => !receipt || BigInt(receipt.status) !== 1n || !receipt.blockNumber)) {
    throw new Error('All broadcast transactions must have successful mined receipts');
  }
  const names = {
    OldMoney: 'money', Estate: 'estate', TrustNote: 'trustNote', Treasury: 'treasury',
    Boardroom: 'boardroom', Oracle: 'oracle', V4PositionWrapper: 'lpWrapper',
    GenesisRewardPool: 'genesisRewardPool', MainRewardPool: 'mainRewardPool',
    ShareRewardPool: 'shareRewardPool', MiniSwapRouter: 'miniSwapRouter', Timelock: 'timelock',
  };
  for (const [name, key] of Object.entries(names)) {
    const txIndex = transactions.findIndex((tx) => tx.contractName === name && tx.transactionType === 'CREATE');
    if (txIndex < 0 || receipts[txIndex].contractAddress?.toLowerCase() !== deployment[key].toLowerCase()) {
      throw new Error(`${key} does not match the confirmed ${name} creation receipt`);
    }
  }
  for (const key of deploymentKeys) {
    const code = await rpc('eth_getCode', [deployment[key], 'latest']);
    if (!code || code === '0x' || code === '0x0') throw new Error(`No deployed code for ${key}`);
  }
  deployment.deployBlock = receipts.reduce((min, receipt) => {
    const block = BigInt(receipt.blockNumber);
    return block < min ? block : min;
  }, BigInt(receipts[0].blockNumber)).toString();
  return candidate;
}

async function main() {
  const [command = 'validate', file = process.env.PROTOCOL_CONFIG || fileURLToPath(new URL('../config/networks.json', import.meta.url)), ...args] = process.argv.slice(2);
  const { document, networks } = readManifest(file);
  if (command === 'validate') {
    console.log(`Valid configuration: ${networks.length} network(s)`);
    return;
  }
  if (command !== 'publish' || args.length !== 3) {
    throw new Error('Usage: node scripts/protocol.mjs publish <manifest> <deployment-output.json> <run-latest.json> <network-index>');
  }
  const [artifactFile, broadcastFile, indexText] = args;
  if (!/^(0|[1-9][0-9]*)$/.test(indexText)) throw new Error('Network index must be a nonnegative integer');
  const index = Number(indexText);
  const network = networks[index];
  if (!network) throw new Error('Network index out of range');
  const rpc = async (method, params) => {
    const response = await fetch(process.env.RPC_URL || network.rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(`RPC ${method} failed: ${payload.error.message}`);
    return payload.result;
  };
  const result = await publishDeployment(document,
    JSON.parse(readFileSync(artifactFile, 'utf8')),
    JSON.parse(readFileSync(broadcastFile, 'utf8')), index, rpc);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Published confirmed deployment for ${network.name}; rebuild the frontend to use it.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
