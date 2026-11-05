/**
 * Compound plan for MasonryGenesisStaking.compoundToLP — the LEVEL (xTOMB) to
 * sell and the gross LP shares to mint from a reward's liquid half.
 *
 * The vault holds one fixed tick range; one share = one unit of liquidity.
 * For a budget B of xTOMB at the current price, sell x for USDC so the
 * remaining (B − x) xTOMB and the USDC received fill the range in proportion:
 *
 *   xTOMB = token0:  x = B·k / (p·(1−f)/(√P−√Pa) + k),  k = √P·√Pb/(√Pb−√P)
 *   xTOMB = token1:  x = (B/(√P−√Pa)) / ((1−f)·k/p + 1/(√P−√Pa))
 *
 * p is the raw token1/token0 price and f the sell leg's Fire Tax + pool fee.
 * Shares are rounded down 0.5% so the vault's max-amount bounds hold; the
 * contract refunds at most 3% of the budget, so the plan must be close —
 * it is always simulated before it's sent.
 */

export interface PlanInputs {
  /** Liquid budget available to compound, xTOMB base units (18 decimals). */
  budget: bigint;
  /** Spot price, USDC per xTOMB, 18-decimal (MasonryBuybackGuard.validatedSpot). */
  spot18: bigint;
  tickLower: number;
  tickUpper: number;
  levelIsCurrency0: boolean;
  /** Fire Tax + pool fee on the sell leg, bps. */
  sellCostBps: number;
  /** LP burn fee and slippage, bps. */
  lpBurnBps: number;
  slippageBps: number;
}

export interface CompoundPlan {
  levelToSell: bigint;
  grossShares: bigint;
  minNetShares: bigint;
}

const LEVEL_DEC = 18;
const USDC_DEC = 6;

export function planCompound(i: PlanInputs): CompoundPlan | null {
  if (i.budget <= 0n || i.spot18 <= 0n) return null;
  const B = Number(i.budget) / 10 ** LEVEL_DEC; // human xTOMB
  const spot = Number(i.spot18) / 1e18; // human USDC per xTOMB
  // Raw token1/token0 price.
  const p = i.levelIsCurrency0 ? spot * 10 ** (USDC_DEC - LEVEL_DEC) : 1 / (spot * 10 ** (USDC_DEC - LEVEL_DEC));
  const s = Math.sqrt(p);
  const sa = Math.sqrt(1.0001 ** i.tickLower);
  const sb = Math.sqrt(1.0001 ** i.tickUpper);
  const f = i.sellCostBps / 10_000;
  const Braw = B * 10 ** LEVEL_DEC;

  let x: number; // raw LEVEL to sell
  let L: number;
  if (i.levelIsCurrency0) {
    if (s <= sa) {
      x = 0; // all token0 (LEVEL)
      L = (Braw * sa * sb) / (sb - sa);
    } else if (s >= sb) {
      x = Braw; // all token1 (USDC)
      L = (x * p * (1 - f)) / (sb - sa);
    } else {
      const k = (s * sb) / (sb - s);
      x = (Braw * k) / ((p * (1 - f)) / (s - sa) + k);
      L = (Braw - x) * k;
    }
  } else {
    if (s >= sb) {
      x = 0; // all token1 (LEVEL)
      L = Braw / (sb - sa);
    } else if (s <= sa) {
      x = Braw; // all token0 (USDC)
      L = ((x * (1 - f)) / p) * ((sa * sb) / (sb - sa));
    } else {
      const k = (s * sb) / (sb - s);
      x = Braw / (s - sa) / (((1 - f) * k) / p + 1 / (s - sa));
      L = (Braw - x) / (s - sa);
    }
  }
  if (!(L > 0) || !Number.isFinite(L)) return null;
  const gross = BigInt(Math.floor(L * 0.995));
  const net = (gross * BigInt(10_000 - i.lpBurnBps)) / 10_000n;
  return {
    levelToSell: BigInt(Math.floor(Math.max(0, Math.min(x, Braw)))),
    grossShares: gross,
    minNetShares: (net * BigInt(10_000 - i.slippageBps)) / 10_000n,
  };
}

/**
 * Vault deposit sizing: liquidity (= shares) from an asset amount at the
 * current price, and the USDC that liquidity needs. Raw units throughout.
 */
export function sizeDeposit(i: { assetRaw: bigint; spot: number; assetDecimals: number; tickLower: number; tickUpper: number; assetIsCurrency0: boolean }) {
  const a = Number(i.assetRaw);
  const p = i.assetIsCurrency0 ? i.spot * 10 ** (USDC_DEC - i.assetDecimals) : 1 / (i.spot * 10 ** (USDC_DEC - i.assetDecimals));
  const s = Math.sqrt(p);
  const sa = Math.sqrt(1.0001 ** i.tickLower);
  const sb = Math.sqrt(1.0001 ** i.tickUpper);
  if (!(s > sa && s < sb)) return null; // out of range: one-sided, sized by the other token
  let L: number;
  let usdc: number;
  if (i.assetIsCurrency0) {
    L = (a * s * sb) / (sb - s);
    usdc = L * (s - sa);
  } else {
    L = a / (s - sa);
    usdc = (L * (sb - s)) / (s * sb);
  }
  return { shares: BigInt(Math.floor(L * 0.995)), usdcRaw: BigInt(Math.ceil(usdc)) };
}
