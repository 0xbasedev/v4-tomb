# Protocol range optimization (8 November 2026, America/New_York)

Monte Carlo sweep of `MasonryRangeManager` knobs for the two official
Robinhood pools. The live contract still *follows spot* with a symmetric
band (that is what `MasonryRangeLib.bandTicks` does today). This note picks
per-pool defaults for that design and compares it with two alternatives that
were **not** wired into the contracts: a fixed band around $1, and a
peg-anchored band that follows spot but always covers the path back to peg.

Nothing here was broadcast, pushed, or launched. Recalibrate after launch
with real Robinhood volume, fee income, and user-LP mix.

## Methodology

A Python harness (`scripts/range_optimize.py`) mirrors:

- `MasonryRangeLib` band / recenter / TWAP-deviation math (tick spacing 60)
- Uniswap v3/v4 concentrated-liquidity amounts
- Official 0.30% pool fee, inventory swap against residual full-range
  liquidity (30% of starting TVL) after the protocol position is removed
- `MAX_INVENTORY_LOSS_BPS = 100`, cooldown, TWAP guard
- Fire Tax curve: 3% at or above peg, 12% at 10% below peg (linear between)

Each path is 60 days of hourly steps on a $100,000 protocol book (50/50 at
the open). Daily turnover is 35% of TVL for xTOMB and 25% for xSHARE,
scaled up with realized volatility. Phase 1 used 8 seeds per scenario;
refinement used 12.

### xTOMB price scenarios

Calm mean-reversion around $1; repeated −10% depegs; −30% depegs; +20%
pumps; a Fire-Tax grind (`fire_cascade`); 8% spoof spikes that revert
(`manipulate`); **sustained selling** for ~26 days; a **sharp depeg and
fast recovery** (−28% then high kappa); **pooled-user deposit/redeem
waves**; and **redemptions during a depeg**.

Pooled users deposit $50,000 into a fixed ±15% Genesis-style band around
$1 (plus an extra $25,000 mid-path in the deposit-wave scenario). They
redeem in waves — including 50% the first time price prints below $0.88 —
and convert withdrawn xTOMB to USDG by selling through the pool (Fire Tax
plus 30 bp + impact). Remaining inventory is redeemed at the horizon.

A mild endogenous pull toward peg (stronger when more USDG sits under the
book) lets time-below-peg differ slightly by strategy; the advertised
pressure path is still the main driver.

### xSHARE price scenarios (tuned separately)

80–150% annualized GBM: chop, high-vol, bull trend, a crash to ~45% of
spot, and spoof spikes. No peg metrics.

### Strategies compared (xTOMB only)

| Strategy | Band |
| --- | --- |
| `follow` | Symmetric ±width around **spot** (live contract) |
| `fixed` | Symmetric ±width around **$1**, never recenters |
| `peg_anchor` | Follows spot, but lower ≤ min(spot, $1)×(1−down) and upper ≥ max(spot, $1)×(1+up), so the recovery path back to $1 stays inside the position |

### Metrics

Fees, time in range, rebalance count and inventory-swap cost, IL vs HODL,
net PnL, depth / slippage for a $2,000 sell, **recovery-path depth**
(xTOMB sitting on `[spot, $1] ∩ range`), **recovery-path coverage**,
**time below peg**, **remaining USDG reserves** (average of ending quote
and quote during depegs), and **user redemption value** after Fire Tax and
sell costs (USDG received / USDG deposited).

Score (xTOMB) weights ending inventory, vs-HODL (median and p10), recovery
depth/coverage, USDG reserves, user redemption value, time below peg, and
near-peg slippage — not just time in range. Score (xSHARE) weights median
and p10 vs-HODL, time in range, slippage, and rebalance cost.

## Chosen live-contract defaults

The shipped manager is still `follow`. Defaults now live under
`policy.rangeLevel` and `policy.rangeSquare` so the two pools can differ.

| Pool | Half-width | Recenter | Cooldown | Max TWAP deviation |
| --- | --- | --- | --- | --- |
| xTOMB / USDG | **2000 bps (±20%)** | **1600 bps (±16%)** | 1800s | 300 bps |
| xSHARE / USDG | **800 bps (±8%)** | **640 bps (±6.4%)** | 1800s | 300 bps |

**xTOMB.** A −10% depeg stays inside the original band and does not
trigger a recenter (16% inner band), so the position keeps covering $1.
Tighter follow settings chase depegs and thin out recovery-path depth
near peg. Wider than ±20% earned slightly less and barely moved; ±37%
“follow” that never recentered behaved like a wide fixed book and sat
outside the 500–3000 config bounds.

On the follow width curve (companion knobs held at the chosen optimum):
±20% median vs-HODL about +4.5%, user redemption about 0.80, recovery-path
coverage about 0.97.

**xSHARE.** ±8% / recenter ±6.4% was the robust winner among widths that
are legal in config (500–3000). It kept ~99.5% time in range with a median
~29 rebalances / 60 days and about +3.3% vs HODL (p10 about −28% on crash
paths). Widths of ±3–5% produced unstable vs-HODL outliers and are not
used. A calmer fallback if live volume is thinner than the 25% daily
turnover assumption is ±15% / recenter ±10%.

Cooldown between 15 minutes and 4 hours did not separate at hourly
resolution — the recenter threshold dominates. 30 minutes is kept as the
manipulation buffer (an 8% one-hour spoof stays outside a 3% TWAP band).

## Strategy comparison (xTOMB)

Best of each family, 60-day Monte Carlo including the new redemption and
depeg scenarios (median unless noted):

| Strategy | Settings | End inventory | vs HODL | Recovery depth | Path coverage | USDG reserves | User redeem | Rebalances |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fixed around $1 | ±8% | $103,894 | +4.0% | **$23,158** | 0.95 | $43,001 | 0.785 | 0 |
| Peg-anchored | −18% / +10%, recenter 6.66% | $102,917 | +3.2% | $5,426 | **1.00** | **$56,367** | **0.802** | 306 |
| Follow (live) | ±20% / 16% (chosen) | ~$103,951 | +4.5% | ~$3,092–$4,041 | 0.97 | see curve | ~0.80 | low |
| Follow (sweep best in-family) | ±37% / 27.75% | $103,196 | +3.7% | $5,075 | 1.00 | $49,712 | 0.792 | 0 |

Fixed ±8% to ±15% around $1 scored highest on recovery-path depth because
liquidity stays parked at peg instead of trailing a depeg. That is the
right shape if the only goal is depth on the walk back to $1.

Peg-anchor is the better *moving* design: it follows down so the book does
not go idle in a −30% print, but the upper edge still reaches $1, so
buyers can walk price back up through protocol xTOMB. It also left the
most USDG in the protocol book and paid users back the most after costs.
It recenters often; that is cheap only because rebalance sells of xTOMB
are Fire-Tax-exempt (below).

Follow (what is shipped) needs a **wide** band and a **high** recenter
threshold so a routine −10% depeg does not yank liquidity off $1. That is
why xTOMB is ±20% / 16% rather than the previous ±15% / 10%.

Peg-anchor and fixed-around-peg were **not** implemented — they need a
different `bandTicks` than today's symmetric-around-spot helper. Worth a
follow-up if Jesse wants the manager to prioritize recovery-path depth
over following.

## Fire Tax on the rebalance swap

`MasonryTaxHook.beforeSwap` returns a zero tax delta when
`sender == rangeManager`. After `bindRangeManager`, the manager's own
inventory swap (including a sell of xTOMB to refill USDG after a depeg)
pays the **0.30% pool LP fee only**, never Fire Tax, and does not recurse
into `nudge`.

If that bind were missing, the same sell would be taxed at the live Fire
Tax (3–12%, higher exactly when recentering below peg). In the sweep that
hypothetical cost was:

- Wide follow that rarely recenters: median **$0** (mean about 0.02% of TVL)
- Peg-anchor (−18%/+10%): median about **$2,514** (2.5% of the $100k book;
  mean about 4.3%) because it sells xTOMB on the way down many times

The exemption should stay. Do not remove `bindRangeManager`. A further cap
is unnecessary while the hook skip is in place; without the bind, frequent
follow strategies would leak a material share of inventory to tax.

## Rebalance event accounting

`RangeRebalanced` now reports, separately:

- withdrawn **principal0 / principal1**
- **fees0 / fees1** collected from the old band (`modifyLiquidity`'s
  `feesAccrued`)
- inventory-swap legs **swap0 / swap1** (PoolManager delta; 0 if no swap)

Covered by `MasonryRangeManager.t.sol` on both official pool shapes.

## Sensitivity

- xTOMB follow width: ±8–15% earns similar fees but covers less of a deep
  depeg's path back to $1; ±25–30% holds more USDG and almost never
  recenters. ±20% is the compromise inside the 500–3000 bound.
- Recenter as a fraction of width: 0.80 (the pick) avoids chasing −10%
  prints; 0.50–0.67 follows earlier and thins peg depth.
- xSHARE widths below ±8% looked numerically extreme (median vs-HODL of
  several hundred percent at ±3%) and are discarded. ±8% beat ±12–30% on
  robust vs-HODL even though crash p10 stays roughly −28% to −40%.
- Chart: `/workspace/v4-assess/shots/range-pnl-vs-width.png` (median vs-HODL
  against half-width, companion knobs held at each token's chosen optimum).
- Raw tables: `docs/sim/range_sweep_results.json`.

## Caveats

This is a simulation, not a mainnet backtest. Prices are mostly exogenous
(with only a mild depth-based pull to peg). Turnover, the 30% external
full-range book, and the $50k Genesis-style user LP book are assumptions.
Uniswap impact during a rebalance is modeled as constant-product against
residual liquidity after the protocol position is pulled. Recalibrate
width, recenter, and cooldown with observed Robinhood volume, user LP
share, and actual depeg paths after launch.


## Local prototype (not launched)

`MasonryRangeLib` now exposes the two xTOMB baselines next to the live
follow helper:

- `fixedPegTicks` — band around the peg sqrt price (does not follow spot)
- `pegAnchorTicks` — follows spot but always spans the path between spot
  and peg (lower wing from `min(spot, peg)`, upper wing from `max(spot, peg)`)

`MasonryPooledRangeVault` is a local, share-based prototype (not wired into
the launch config) where several users sit in one band and can redeem.
Tests cover two-user deposits, a redemption wave during a depeg (remaining
USDG stays in the vault), follow abandoning $1 after a deep depeg
rebalance, and a fixed band that stays on peg.

The live `MasonryRangeManager` is unchanged: it still follows spot, with
the per-pool defaults in the table above.
