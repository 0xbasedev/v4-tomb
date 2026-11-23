#!/usr/bin/env node
// LONGYU testnet only. Read-only preflight. No private keys or transactions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "../longyu.testnet.json"), "utf8"));
const rpcUrl = process.env.LONGYU_TESTNET_RPC || manifest.chain.rpc;
const deployer = process.env.DEPLOYER_ADDRESS;
const errors = [];
function check(condition, message) { if (!condition) errors.push(message); }
function address(value) { return /^0x[a-fA-F0-9]{40}$/.test(value || ""); }
async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error || !payload.result) throw Error(`RPC ${method}: ${JSON.stringify(payload.error ?? payload)}`);
  return payload.result;
}
try {
  check(manifest.testnetOnly === true, "profile is not testnet-only");
  check(manifest.chain.id === 668801, "unexpected profile chain ID");
  const observedChain = Number(BigInt(await rpc("eth_chainId")));
  check(observedChain === 668801, `unexpected live chain ID ${observedChain}`);
  console.log(`RPC chain ID: ${observedChain}`);
  for (const [label, candidate] of [
    ["V2 factory", manifest.infrastructure.factory],
    ["V2 router", manifest.infrastructure.router],
  ]) {
    check(address(candidate), `${label}: malformed address`);
    if (address(candidate)) {
      const code = await rpc("eth_getCode", [candidate, "latest"]);
      check(code !== "0x" && code !== "0x0", `${label}: no contract code`);
      console.log(`${label}: ${candidate} (${code.length - 2} hex bytes)`);
    }
  }
  if (!address(deployer)) {
    errors.push("DEPLOYER_ADDRESS missing: use a disposable user-controlled keystore address");
  } else {
    const balance = BigInt(await rpc("eth_getBalance", [deployer, "latest"]));
    check(balance > 0n, "deployer has no testnet tBNB gas");
    console.log(`Deployer gas balance: ${balance} wei`);
  }
  check(!manifest.pilot.productionReady, "pilot must not claim production readiness");
  check(manifest.pilot.bondToken === null, "bonds must be absent");
  check(manifest.pilot.shareCapWholeTokens === "333333", "unexpected xSHARE cap");
  check(manifest.pilot.expansionMaximumBps === 200, "expansion cap changed");
  check(manifest.pilot.mintRequiresPriceStrictlyAboveUsdE18 === "1010000000000000000", "peg gate changed");
  check(manifest.pilot.masonryLp === "xTOMB/xSHARE", "incorrect Masonry LP");
  check(manifest.pilot.manualTestOracleUnsafe, "manual oracle must remain labeled unsafe");
  check(manifest.pilot.quoteCurrency.startsWith("MockUSD"), "mock fee denomination is not labeled");
  if (errors.length) {
    for (const problem of errors) console.error("BLOCKED:", problem);
    process.exitCode = 1;
  } else {
    console.log("RPC/infrastructure checks passed. This is NOT a contract audit or broadcast approval.");
  }
} catch (error) {
  console.error("BLOCKED: cannot verify LONGYU testnet endpoint:", error.message);
  process.exitCode = 1;
}
