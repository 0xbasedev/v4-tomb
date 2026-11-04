import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseNetworks, deploymentKeys } from '../config/schema.mjs';

export function readManifest(file = 'config/networks.json') {
  const document = JSON.parse(readFileSync(file, 'utf8'));
  return { document, networks: parseNetworks(document) };
}

const createdTopic = '0x4db17dd5e4732fb6da34a148104a592783ca119a1e7bb8829eba6cbadef0b511';
const proxyTopic = '0x2feea65dd4e9f9cbd86b74b7734210c59a1b2981b5b137bd0ee3e208200c9067';
const lower = (value) => value?.toLowerCase();
const indexedAddress = (value) => `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;

export async function verifyCreate3Receipts(plan, deployment, receipts) {
  const { coreRoles, create3Address, factory } = await import('./create3.mjs');
  if (lower(plan.factory) !== lower(factory)) throw new Error('Unexpected CreateX factory');
  const mined = receipts.filter((receipt) => lower(receipt.to) === lower(factory)
    && lower(receipt.from) === lower(plan.deployer) && receipt.contractAddress == null);
  for (const role of coreRoles) {
    const predicted = create3Address(plan, role, role === 'hook' ? plan.hookNonce : 0);
    if (lower(predicted.address) !== lower(plan.addresses[role])
      || lower(predicted.address) !== lower(deployment[role])) {
      throw new Error(`${role} does not match the CREATE3 prediction`);
    }
    const confirmed = mined.filter((receipt) => {
      const logs = (receipt.logs ?? []).filter((log) => lower(log.address) === lower(factory));
      return logs.some((log, index) => log.topics?.length === 3
        && lower(log.topics[0]) === proxyTopic
        && lower(log.topics[1]) === indexedAddress(predicted.proxy)
        && lower(log.topics[2]) === lower(predicted.guarded)
        && logs.slice(index + 1).some((creation) => creation.topics?.length === 2
          && lower(creation.topics[0]) === createdTopic
          && lower(creation.topics[1]) === indexedAddress(predicted.address)));
    });
    if (confirmed.length !== 1) throw new Error(`${role} has no unique confirmed CreateX creation receipt`);
  }
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
  if (network.create3) {
    const { factory, factoryCodeHash, hashHex } = await import('./create3.mjs');
    const code = await rpc('eth_getCode', [factory, 'latest']);
    if (!code || hashHex(code) !== factoryCodeHash) throw new Error('Unexpected CreateX factory bytecode');
    await verifyCreate3Receipts(network.create3, deployment, receipts);
  } else {
    const names = {
      PegToken: 'money', ShareToken: 'estate', TrustNote: 'trustNote', Treasury: 'treasury',
      Boardroom: 'boardroom', Oracle: 'oracle', V4PositionWrapper: 'lpWrapper',
      GenesisRewardPool: 'genesisRewardPool', MainRewardPool: 'mainRewardPool',
      ShareRewardPool: 'shareRewardPool', MiniSwapRouter: 'miniSwapRouter', Timelock: 'timelock',
    };
    // Older Foundry broadcasts recorded the original Solidity names.
    const legacyNames = { PegToken: 'OldMoney', ShareToken: 'Estate' };
    for (const [name, key] of Object.entries(names)) {
      const acceptedNames = [name, ...(legacyNames[name] ? [legacyNames[name]] : [])];
      const txIndex = transactions.findIndex((tx) => acceptedNames.includes(tx.contractName) && tx.transactionType === 'CREATE');
      if (txIndex < 0 || receipts[txIndex].contractAddress?.toLowerCase() !== deployment[key].toLowerCase()) {
        throw new Error(`${key} does not match the confirmed ${name} creation receipt`);
      }
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
