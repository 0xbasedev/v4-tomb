import { expect, test } from "@playwright/test";

import { recoveryFloorBps, sellTax, targetBps, type TaxQuote } from "../src/lib/fireTax";
import { emissionShare, genesisClock, walletClaim } from "../src/lib/genesis";
import { DEFENSE, EXPANSION, FIRE, GENESIS_POLICY, PASSES, SQUARE_SUPPLY } from "../src/lib/launch";
import { expansionCap, marketPhase, stepDefense } from "../src/lib/market";
import { planRoute, quoteRoute } from "../src/lib/routes";

/**
 * The protocol model the UI renders, checked against the launch template and
 * the merge-branch contract rules — at the exact second each rule flips.
 */

const START = 1_000_000;
const DAY = 86_400;

test.describe("Genesis clock", () => {
  test("Day 1 → Day 2 boundary: LP pool opens at exactly +24h", () => {
    const before = genesisClock(START, START + DAY - 1);
    const at = genesisClock(START, START + DAY);
    expect(before.phase).toBe("day1");
    expect(before.lpOpen).toBe(false);
    expect(emissionShare(0, before)).toBe(1);
    expect(emissionShare(1, before)).toBe(0);
    expect(at.phase).toBe("lp");
    expect(at.lpOpen).toBe(true);
    expect(at.day).toBe(2);
    expect(emissionShare(1, at)).toBe(0.75);
    expect(emissionShare(0, at)).toBe(0.25);
  });

  test("Genesis end boundary: emissions stop at exactly +7d", () => {
    const before = genesisClock(START, START + 7 * DAY - 1);
    const at = genesisClock(START, START + 7 * DAY);
    expect(before.phase).toBe("lp");
    expect(before.active).toBe(true);
    expect(before.day).toBe(7);
    expect(at.phase).toBe("ended");
    expect(at.active).toBe(false);
    expect(emissionShare(0, at) + emissionShare(1, at)).toBe(0);
  });

  test("Ultra early access opens exactly 24h before start", () => {
    expect(genesisClock(START, START - DAY - 1).ultraEarly).toBe(false);
    expect(genesisClock(START, START - DAY).ultraEarly).toBe(true);
    expect(genesisClock(START, START).ultraEarly).toBe(false);
  });

  test("a 400 wallet claim: 196 wallet, 4 Treasury, 200 vested in 16 installments", () => {
    const c = walletClaim(400);
    expect(c.toWallet).toBeCloseTo(196, 9);
    expect(c.treasury).toBeCloseTo(4, 9);
    expect(c.vested).toBeCloseTo(200, 9);
    expect(GENESIS_POLICY.installments).toBe(16);
    expect(GENESIS_POLICY.installmentSeconds).toBe(6 * 3600);
  });

  test("passes are 50 / 100 / 500 USDC with the same weighting; only Pro and Ultra get a keeper", () => {
    expect([PASSES.genesis.priceUsdc, PASSES.pro.priceUsdc, PASSES.ultra.priceUsdc]).toEqual([50, 100, 500]);
    expect([PASSES.genesis.keeper, PASSES.pro.keeper, PASSES.ultra.keeper]).toEqual([false, true, true]);
    expect([PASSES.genesis.earlyStandardStaking, PASSES.pro.earlyStandardStaking, PASSES.ultra.earlyStandardStaking]).toEqual([false, false, true]);
    expect(GENESIS_POLICY.ultraMultiplier).toBe(1);
  });
});

test.describe("Fire Tax", () => {
  const base = { raisedBps: 0, raisedAt: 0, now: 0 };

  test("baseline 3% at or above the reference, 12% cap at or below 0.90", () => {
    expect(FIRE.baselineBps).toBe(300);
    expect(FIRE.fullTaxAt).toBeCloseTo(0.9, 10);
    expect(targetBps(1)).toBe(FIRE.baselineBps);
    expect(targetBps(1.2)).toBe(300);
    expect(targetBps(0.9)).toBe(1200);
    expect(targetBps(0.85)).toBe(1200);
    expect(targetBps(0.5)).toBe(1200);
    expect(targetBps(0.98)).toBe(702);
    expect(targetBps(0.95)).toBe(936);
  });

  test("one rate: the highest of TWAP, projected, recovery and Genesis floor, capped at 12%", () => {
    const q = sellTax({ asset: "xTOMB", twap: 1, projected: 0.9, genesisActive: false, ...base });
    expect(q.driver).toBe("projected");
    expect(q.rateBps).toBe(targetBps(0.9));
    const capped = sellTax({ asset: "xTOMB", twap: 0.7, projected: 0.6, genesisActive: true, ...base });
    expect(capped.rateBps).toBe(FIRE.capBps);
  });

  test("Genesis floors: 3% xTOMB (burned in full), 6% xSHARE", () => {
    const l = sellTax({ asset: "xTOMB", twap: 1, projected: 1, genesisActive: true, ...base });
    const s = sellTax({ asset: "xSHARE", twap: 1, projected: 1, genesisActive: true, ...base });
    expect([l.rateBps, l.driver, l.burned]).toEqual([300, "genesis", true]);
    expect([s.rateBps, s.driver, s.burned]).toEqual([600, "genesis", false]);
    const after = sellTax({ asset: "xTOMB", twap: 1, projected: 1, genesisActive: false, ...base });
    expect([after.rateBps, after.driver, after.burned]).toEqual([300, "baseline", false]);
  });

  test("recovery floor decays linearly to baseline over 7h", () => {
    expect(recoveryFloorBps(1200, 0, 0)).toBe(1200);
    expect(recoveryFloorBps(1200, 0, FIRE.recoverySeconds / 2)).toBe(750);
    expect(recoveryFloorBps(1200, 0, FIRE.recoverySeconds)).toBe(300);
  });

  test("stale oracle: the hook rejects the sell", () => {
    const q = sellTax({ asset: "xTOMB", twap: null, projected: null, genesisActive: false, ...base });
    expect(q.rateBps).toBeNull();
    expect(q.blocked).toMatch(/rejects sells/);
  });
});

test.describe("Routes", () => {
  const prices = { xTOMB: 1, xSHARE: 120, USDC: 1, "xTOMB-USDC": 2, "xSHARE-USDC": 240, ETH: null, xBOND: null };
  const ctx = (rate: number | null) => ({
    prices,
    poolFeeBps: { xTOMB: 30, xSHARE: 30 },
    taxFor: (): TaxQuote => ({ rateBps: rate, driver: rate === null ? null : "baseline", parts: { baseline: 300, twap: 0, projected: 0, recovery: 0, genesis: 0 }, burned: false, blocked: rate === null ? "no TWAP" : undefined }),
  });

  test("buy vs sell: buys carry no Fire Tax, sells carry one", () => {
    const buy = planRoute("USDC", "xTOMB");
    const sell = planRoute("xTOMB", "USDC");
    if (!buy.ok || !sell.ok) throw new Error("official routes must plan");
    const qb = quoteRoute(buy, "USDC", "xTOMB", 1000, ctx(100))!;
    const qs = quoteRoute(sell, "xTOMB", "USDC", 1000, ctx(100))!;
    expect(qb.fireTaxUsd).toBe(0);
    expect(qs.fireTaxUsd).toBeCloseTo(10, 9);
    expect(qs.poolFeesUsd).toBeCloseTo((1000 - 10) * 0.003, 9);
  });

  test("LP → USDC taxes only the sold xTOMB half; pool fees itemised separately", () => {
    const plan = planRoute("xTOMB-USDC", "USDC", { xTOMB: 0.5 });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.legs.map((l) => l.kind)).toEqual(["redeem", "sell"]);
    const q = quoteRoute(plan, "xTOMB-USDC", "USDC", 500, ctx(300))!; // 500 LP × $2 = $1,000
    expect(q.valueInUsd).toBe(1000);
    expect(q.fireTaxUsd).toBeCloseTo(15, 9); // 3% of the $500 sold, not of $1,000
    expect(q.poolFeesUsd).toBeCloseTo((500 - 15) * 0.003, 9);
    expect(q.valueOutUsd).toBeCloseTo(1000 - 15 - 1.455, 9);
  });

  test("LP → its own asset buys with the USDC half — no sell leg", () => {
    const plan = planRoute("xTOMB-USDC", "xTOMB", { xTOMB: 0.5 });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.legs.map((l) => l.kind)).toEqual(["redeem", "buy"]);
  });

  test("stale oracle blocks the sell leg of any route", () => {
    const plan = planRoute("xTOMB-USDC", "USDC", { xTOMB: 0.5 });
    if (!plan.ok) throw new Error(plan.reason);
    expect(quoteRoute(plan, "xTOMB-USDC", "USDC", 10, ctx(null))!.blocked).toBe("no TWAP");
  });

  test("unsupported routes say why", () => {
    for (const [a, b] of [["ETH", "xTOMB"], ["USDC", "xTOMB-USDC"], ["xTOMB-USDC", "xSHARE-USDC"], ["xTOMB-USDC", "xSHARE"], ["xBOND", "USDC"]] as const) {
      const p = planRoute(a, b, { xTOMB: 0.5, xSHARE: 0.5 });
      expect(p.ok, `${a} → ${b}`).toBe(false);
      if (!p.ok) expect(p.reason.length).toBeGreaterThan(10);
    }
    const toLp = planRoute("USDC", "xTOMB-USDC");
    expect(!toLp.ok && toLp.suggest).toBe("liquidity");
  });
});

test.describe("Expansion and Critical Defense", () => {
  test("expansion needs a fresh TWAP strictly above $1.01, capped at 2% per epoch", () => {
    expect(EXPANSION.gate).toBe(1.01);
    expect(expansionCap(1_000_000, 1.01, true)).toBe(0);
    expect(expansionCap(1_000_000, 1.0101, true)).toBe(20_000);
    expect(expansionCap(1_000_000, 1.2, false)).toBe(0);
    expect(marketPhase({ twap: 1.05, fresh: false, defenseActive: false })).toBe("stale");
  });

  test("defense enters at ≤ $0.90 and exits after 2 fresh checkpoints above $1.01; stale data changes nothing", () => {
    let d = { active: false, checkpoints: 0 };
    d = stepDefense(d, DEFENSE.enterAt, true);
    expect(d.active).toBe(true);
    d = stepDefense(d, 1.05, false);
    expect(d).toEqual({ active: true, checkpoints: 0 });
    d = stepDefense(d, 1.02, true);
    expect(d).toEqual({ active: true, checkpoints: 1 });
    d = stepDefense(d, 1.0, true);
    expect(d).toEqual({ active: true, checkpoints: 0 });
    d = stepDefense(stepDefense(d, 1.02, true), 1.03, true);
    expect(d.active).toBe(false);
  });

  test("xSHARE cap is the configured 33,333", () => {
    expect(SQUARE_SUPPLY.cap).toBe(33_333);
  });
});

test.describe("CREATE3 release planning", () => {
  const release = { releaseId: `0x${"99".repeat(32)}` as const, deployer: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as const };

  test("the browser planner matches scripts/create3.mjs for every Masonry role, hooks included", async () => {
    test.setTimeout(120_000);
    // @ts-expect-error — plain .mjs from the repository root, no type declarations
    const script = await import("../../scripts/create3.mjs");
    const { planMasonrySync, MASONRY_HOOK_FLAGS, HOOK_MASK } = await import("../src/lib/create3");
    const expected = script.planMasonry({ ...release, canonicalDomain: 8453 });
    const actual = planMasonrySync({ ...release, chainId: 8453 });
    expect(actual.addresses).toEqual(expected.addresses);
    expect(actual.hookNonces).toEqual(expected.hookNonces);
    for (const role of ["masonryTaxHook", "masonryShareTaxHook"] as const) expect(BigInt(actual.addresses[role]) & HOOK_MASK).toBe(MASONRY_HOOK_FLAGS);
    expect(new Set(Object.values(actual.addresses)).size).toBe(Object.keys(actual.addresses).length);
    expect(Object.keys(actual.addresses)).toContain("masonrySwapRouter");
  });

  test("address patterns: prefix + suffix are found, recorded as nonces, and match the script", async () => {
    test.setTimeout(120_000);
    // @ts-expect-error — plain .mjs from the repository root
    const script = await import("../../scripts/create3.mjs");
    const { planMasonrySync, create3Address } = await import("../src/lib/create3");
    const addressPatterns = { masonryPeg: { prefix: "a", suffix: "b" } };
    const mine = planMasonrySync({ ...release, chainId: 8453, addressPatterns });
    const theirs = script.planMasonry({ ...release, canonicalDomain: 8453, addressPatterns });
    expect(mine.addresses.masonryPeg).toBe(theirs.addresses.masonryPeg);
    expect(mine.addresses.masonryPeg.toLowerCase()).toMatch(/^0xa.*b$/);
    const nonce = mine.addressNonces!.masonryPeg!;
    expect(create3Address(release, "masonryPeg", nonce).address).toBe(mine.addresses.masonryPeg);
  });

  test("pattern validation: hook suffixes must keep the permission bits; other roles allow four characters", async () => {
    const { patternProblem } = await import("../src/lib/create3");
    expect(patternProblem({ masonryTaxHook: { suffix: "35c8" } })).toBeNull();
    expect(patternProblem({ masonryTaxHook: { suffix: "ffff" } })).toMatch(/conflicts with Uniswap permissions/);
    expect(patternProblem({ masonryPeg: { prefix: "abc", suffix: "de" } })).toMatch(/up to four/);
    expect(patternProblem({ masonryPeg: { prefix: "zz" } })).toMatch(/hexadecimal/);
  });

  test("bridge and Bridged xSHARE addresses match the script for a Base home chain", async () => {
    // @ts-expect-error — plain .mjs from the repository root
    const script = await import("../../scripts/create3.mjs");
    const { planBridge: browserBridge, BRIDGE } = await import("../src/lib/create3");
    const owner = "0x0000000000000000000000000000000000000123";
    const full = script.planBridge(BRIDGE, {
      ...release,
      canonicalDomain: 8453,
      canonicalTokenRole: "masonryShare",
      routeCaps: { 4663: "100", 56: "200", 369: "300", 146: "400" },
      bridgeOperators: Object.fromEntries(BRIDGE.networks.map(({ id }) => [id, { owner, ism: owner }])),
    });
    const mine = browserBridge(release, 8453, "masonryShare")!;
    for (const n of full.networks) {
      expect(n.bridge).toBe(mine.bridge);
      expect(n.token).toBe(mine.tokens[n.id]);
      expect(n.enabled).toBe(false);
    }
    expect(browserBridge(release, 42161)).toBeNull(); // Arbitrum is not a bridge network
  });

  test("a different signer or release ID moves every address", async () => {
    const { create3Address } = await import("../src/lib/create3");
    const a = create3Address(release, "masonryPeg").address;
    expect(create3Address({ ...release, deployer: "0x0000000000000000000000000000000000000123" }, "masonryPeg").address).not.toBe(a);
    expect(create3Address({ ...release, releaseId: `0x${"88".repeat(32)}` }, "masonryPeg").address).not.toBe(a);
  });
});
