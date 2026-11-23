#!/usr/bin/env node
// Universal read-only EVM preflight. Never signs or broadcasts transactions.
import fs from "node:fs";
import { validateLiteRelease } from "../config/release.mjs";

const configFile = process.argv[2] || "config/release.json";
const plan = JSON.parse(fs.readFileSync(configFile, "utf8"));
try {
  validateLiteRelease(plan);
} catch (err) {
  console.error("BLOCKED invalid release:", err.message);
  process.exit(1);
}

const { network } = plan;
const rpcUrl = process.env.RPC_URL || network.rpcUrl;
const errors = [];
async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error || payload.result == null) {
    throw Error(`RPC ${method} failed: ${JSON.stringify(payload.error || payload)}`);
  }
  return payload.result;
}
try {
  const observedChain = BigInt(await rpc("eth_chainId"));
  if (observedChain !== BigInt(network.chainId)) errors.push("RPC chain ID does not match approved profile");
  const addresses = {
    "V2 factory": network.infrastructure.v2Factory,
    "V2 router": network.infrastructure.v2Router,
    "USD stable token": network.infrastructure.stableToken,
    "stable/USD reference feed": network.infrastructure.stableUsdFeed
  };
  if (network.infrastructure.nativeUsdFeed) addresses["native/USD reference feed"] = network.infrastructure.nativeUsdFeed;
  for (const [label, address] of Object.entries(addresses)) {
    const code = await rpc("eth_getCode", [address, "latest"]);
    if (code === "0x" || code === "0x0") errors.push(`${label}: no bytecode at ${address}`);
  }
  const signer = plan.launch.deployer;
  const balance = BigInt(await rpc("eth_getBalance", [signer, "latest"]));
  if (balance === 0n) errors.push("deployer has zero native gas token");
  console.log(JSON.stringify({
    expectedChainId: String(network.chainId),
    observedChainId: String(observedChain),
    deployer: signer,
    gasBalanceWei: String(balance),
    checkedContracts: Object.keys(addresses),
    status: errors.length ? "BLOCKED" : "READY_FOR_LOCAL_SIMULATION_ONLY",
    broadcasts: 0
  }, null, 2));
  for (const problem of errors) console.error("BLOCKED:", problem);
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error("BLOCKED endpoint check failed:", error.message);
  process.exitCode = 1;
}
