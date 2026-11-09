import type { TaxQuote, TaxedAsset } from "@/lib/fireTax";
import { PEG } from "@/lib/peg";
import { TOKENS, type TokenId } from "@/lib/tokens";

/**
 * Swap routing over what the contracts actually expose:
 *   - MiniSwapRouter.swapExactIn on the official xTOMB/USDC and xSHARE/USDC
 *     pools (each through its Fire Tax hook), and
 *   - MasonryLevelUsdcVault / MasonrySquareUsdcVault redeem (LP → both tokens)
 *     and deposit (both tokens → LP).
 * There is no zap contract, so every leg is its own transaction. Anything the
 * contracts can't do is returned as unavailable with the reason, never faked.
 */

export type LegKind = "sell" | "buy" | "redeem";
export type Pool = "xTOMB/USDC" | "xSHARE/USDC"; // internal ids; labels use PEG.symbol

export interface Leg {
  kind: LegKind;
  label: string;
  /** Asset traded on the pool (swaps), or the vault's asset (redeem). */
  asset: TaxedAsset;
  pool: Pool;
  /** Fraction of the input's value that passes through this leg. */
  valueShare: number;
}

export type RoutePlan =
  | { ok: true; legs: Leg[]; mode: "swap" | "two-hop" | "remove"; txCount: number }
  | { ok: false; reason: string; suggest?: "liquidity" | "pair-tokens" };

const POOL_OF: Record<TaxedAsset, Pool> = { xTOMB: "xTOMB/USDC", xSHARE: "xSHARE/USDC" };
const LP_OF: Partial<Record<TokenId, TaxedAsset>> = { "xTOMB-USDC": "xTOMB", "xSHARE-USDC": "xSHARE" };
const asset = (id: TokenId): TaxedAsset | null => (id === "xTOMB" || id === "xSHARE" ? id : null);

const sell = (a: TaxedAsset, share: number): Leg => ({ kind: "sell", label: `Sell ${a} → ${PEG.symbol}`, asset: a, pool: POOL_OF[a], valueShare: share });
const buy = (a: TaxedAsset, share: number): Leg => ({ kind: "buy", label: `Buy ${a} with ${PEG.symbol}`, asset: a, pool: POOL_OF[a], valueShare: share });

/**
 * `lpAssetShare` is the share of an LP's value held in its asset (xTOMB or
 * xSHARE) — it sets how much of an LP exit is actually sold.
 */
export function planRoute(input: TokenId, output: TokenId, lpAssetShare: Partial<Record<TaxedAsset, number>> = {}): RoutePlan {
  if (input === output) return { ok: false, reason: "Pick two different tokens." };
  if (input === "ETH" || output === "ETH") {
    return { ok: false, reason: `No official ETH pool. The official pairs are xTOMB/${PEG.symbol} and xSHARE/${PEG.symbol} — swap ETH for ${PEG.symbol} elsewhere first.` };
  }
  if (input === "xBOND" || output === "xBOND") return { ok: false, reason: "xBOND has no swap market; buy and redeem through MasonryBond once launched." };

  const ai = asset(input);
  const ao = asset(output);
  if (ai && output === "USDC") return { ok: true, mode: "swap", txCount: 1, legs: [sell(ai, 1)] };
  if (input === "USDC" && ao) return { ok: true, mode: "swap", txCount: 1, legs: [buy(ao, 1)] };
  if (ai && ao) return { ok: true, mode: "two-hop", txCount: 2, legs: [sell(ai, 1), buy(ao, 1)] };

  const lpIn = LP_OF[input];
  const lpOut = LP_OF[output];
  if (lpOut) {
    return {
      ok: false,
      reason: `Adding liquidity takes both tokens: ${TOKENS[output].pair![0]} and ${PEG.symbol} go into the vault together. There's no zap contract to do it from one token.`,
      suggest: "liquidity",
    };
  }
  if (lpIn) {
    const share = lpAssetShare[lpIn] ?? 0.5;
    const redeem: Leg = { kind: "redeem", label: `Redeem ${TOKENS[input].symbol}`, asset: lpIn, pool: POOL_OF[lpIn], valueShare: 1 };
    if (output === "USDC") return { ok: true, mode: "remove", txCount: 2, legs: [redeem, sell(lpIn, share)] };
    if (output === lpIn) return { ok: true, mode: "remove", txCount: 2, legs: [redeem, buy(lpIn, 1 - share)] };
    return {
      ok: false,
      reason: `From ${TOKENS[input].symbol} the contracts reach ${lpIn} and ${PEG.symbol}. Redeem to both, then swap — ${output} needs a route through the other pool.`,
      suggest: "pair-tokens",
    };
  }
  return { ok: false, reason: "No route between these tokens in the current contracts." };
}

export interface LegQuote extends Leg {
  valueUsd: number;
  poolFeeUsd: number;
  poolFeeBps: number;
  tax: TaxQuote | null;
  taxUsd: number;
}

export interface RouteQuote {
  legs: LegQuote[];
  valueInUsd: number;
  poolFeesUsd: number;
  fireTaxUsd: number;
  valueOutUsd: number;
  amountOut: number | null;
  /** Fire Tax as a share of the value put in. */
  taxShareOfValue: number;
  /** Set when a sell leg would be rejected (no valid TWAP). */
  blocked: string | null;
}

export interface QuoteContext {
  prices: Partial<Record<TokenId, number | null>>;
  /** Static LP fee of each official pool, in bps (from its pool key). */
  poolFeeBps: Record<TaxedAsset, number>;
  /** Fire Tax on selling `valueUsd` of `asset` (projects the post-sale price). */
  taxFor: (asset: TaxedAsset, valueUsd: number) => TaxQuote;
}

export function quoteRoute(plan: Extract<RoutePlan, { ok: true }>, input: TokenId, output: TokenId, amountIn: number, ctx: QuoteContext): RouteQuote | null {
  const pIn = ctx.prices[input];
  const pOut = ctx.prices[output];
  if (!(amountIn > 0) || !pIn) return null;
  const valueIn = amountIn * pIn;
  let running = valueIn;
  let poolFees = 0;
  let fireTax = 0;
  let blocked: string | null = null;
  const legs: LegQuote[] = [];
  for (const leg of plan.legs) {
    // A two-hop's second leg buys with what the first leg returned.
    const base = plan.mode === "two-hop" && leg.kind === "buy" ? running : valueIn * leg.valueShare;
    if (leg.kind === "redeem") {
      legs.push({ ...leg, valueUsd: valueIn, poolFeeUsd: 0, poolFeeBps: 0, tax: null, taxUsd: 0 });
      continue;
    }
    const feeBps = ctx.poolFeeBps[leg.asset];
    const tax = leg.kind === "sell" ? ctx.taxFor(leg.asset, base) : null;
    if (tax && tax.rateBps === null) blocked = tax.blocked ?? "Sell rejected by the hook.";
    const taxUsd = tax?.rateBps ? (base * tax.rateBps) / 10_000 : 0;
    const poolFeeUsd = ((base - taxUsd) * feeBps) / 10_000;
    poolFees += poolFeeUsd;
    fireTax += taxUsd;
    running = plan.mode === "two-hop" ? base - taxUsd - poolFeeUsd : running - taxUsd - poolFeeUsd;
    legs.push({ ...leg, valueUsd: base, poolFeeUsd, poolFeeBps: feeBps, tax, taxUsd });
  }
  const valueOut = valueIn - poolFees - fireTax;
  return {
    legs,
    valueInUsd: valueIn,
    poolFeesUsd: poolFees,
    fireTaxUsd: fireTax,
    valueOutUsd: valueOut,
    amountOut: pOut ? valueOut / pOut : null,
    taxShareOfValue: valueIn > 0 ? fireTax / valueIn : 0,
    blocked,
  };
}
