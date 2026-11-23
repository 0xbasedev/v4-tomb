import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateLiteRelease, exportPublicEnv } from "./release.mjs";

const template = JSON.parse(fs.readFileSync(new URL("./release.template.json", import.meta.url), "utf8"));
function plan() {
  const x = structuredClone(template);
  x.network.infrastructure.stableToken = "0x0000000000000000000000000000000000000001";
  x.network.infrastructure.stableUsdFeed = "0x0000000000000000000000000000000000000002";
  x.network.infrastructure.quoteTokenVerified = true;
  x.network.infrastructure.oracleFeedVerified = true;
  x.launch.deployer = "0x0000000000000000000000000000000000000003";
  x.launch.treasury = "0x0000000000000000000000000000000000000004";
  x.launch.arbitrage = "0x0000000000000000000000000000000000000005";
  x.launch.team = "0x0000000000000000000000000000000000000006";
  x.launch.developer = "0x0000000000000000000000000000000000000007";
  x.launch.saleEscrow = "0x0000000000000000000000000000000000000008";
  x.launch.genesisStart = "1000000";
  x.launch.farmStart = String(1000000 + 604800);
  x.launch.levelLaunchSupplyWei = "10000000000000000000000";
  x.launch.levelSupplyApproved = true;
  x.launch.distributionApproved = true;
  x.testnetDeploymentApproved = true;
  x.guards.minPegReserveWei = "1000000000000000000000";
  x.guards.minQuoteReserveUnits = "1000000000";
  x.guards.v2SwapFeeBps = 30;
  const a = x.launch.shareAllocations;
  a.farmLevelLp = "128200"; a.farmShareLp = "128200";
  a.saleEscrow = "100"; a.deployer = "1";
  a.teamUpfront = "100"; a.devUpfront = "0";
  a.treasuryUpfront = "500"; a.arbitrageUpfront = "50";
  a.teamVested = "33000"; a.devVested = "33000";
  a.treasuryVested = "5000"; a.arbitrageVested = "5182";
  // Totals: farms 256400 + 101 + 650 + 76182 = 333333
  return x;
}

test("incomplete release template must fail closed", () => {
  assert.throws(() => validateLiteRelease(template, { now: 0 }));
});
test("reconciled 333333 xSHARE release validates", () => {
  const validated = validateLiteRelease(plan(), { now: 0 });
  assert.equal(validated.sharesAllocated, "333333");
  assert.equal(validated.productionReady, false);
  const env = exportPublicEnv(plan(), { now: 0 });
  assert.equal(env.EXPECTED_CHAIN_ID, 668801);
  assert.equal(env.SHARE_FARM_LEVEL_LP, "128200");
  assert.equal(env.NATIVE_USD_FEED, "0x0000000000000000000000000000000000000000");
  assert.equal("DEPLOYER_PRIVATE_KEY" in env, false);
});
test("different chain ID needs no code change", () => {
  const x = plan();
  x.network.chainId = 123456789;
  x.network.name = "Other EVM Testnet";
  x.network.rpcUrl = "https://rpc.other.example";
  const result = validateLiteRelease(x, { now: 0 });
  assert.equal(result.chainId, "123456789");
});
test("mismatched share supply is rejected", () => {
  const x = plan();
  x.launch.shareAllocations.teamVested = "32999";
  assert.throws(() => validateLiteRelease(x, { now: 0 }), /mismatch/);
});
test("bonds, mint-at-peg, tax cap and catchup cannot be enabled", () => {
  for (const [key, replacement] of [
    ["bondsEnabled", true],
    ["mintRequiresStrictlyAboveUsdE18", "1000000000000000000"],
    ["fireTaxHardCapBps", 2000],
    ["allowCatchup", true],
    ["manualPriceSourceAllowed", true]
  ]) {
    const x = plan();
    x.mechanics[key] = replacement;
    assert.throws(() => validateLiteRelease(x, { now: 0 }), /must equal/);
  }
});
test("production or unverifiable stable feed is rejected", () => {
  const x = plan();
  x.network.testnet = false;
  assert.throws(() => validateLiteRelease(x, { now: 0 }), /testnet/);
  x.network.testnet = true;
  x.network.infrastructure.oracleFeedVerified = false;
  assert.throws(() => validateLiteRelease(x, { now: 0 }), /feed/);
});
test("missing deployment approval is rejected", () => {
  const x = plan();
  x.testnetDeploymentApproved = false;
  assert.throws(() => validateLiteRelease(x, { now: 0 }), /approval/);
});
test("farm runway cannot begin before seven-day Genesis ends", () => {
  const x = plan();
  x.launch.farmStart = "1000001";
  assert.throws(() => validateLiteRelease(x, { now: 0 }), /clock/);
});
