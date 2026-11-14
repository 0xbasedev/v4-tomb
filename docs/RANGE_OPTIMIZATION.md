# Protocol range optimization (8 November 2026, America/New_York)

Monte Carlo sweep of `MasonryRangeManager` knobs for the two official
Robinhood pools. xTOMB now launches in **peg-anchor** mode (−18% / +10%);
xSHARE still **follows** spot at ±8%. This note compares follow, a fixed
band around $1, peg-anchor, and the pooled-user overlay that sits in a
Genesis-style ±15% band and redeems through the pool.

Nothing here was broadcast, pushed, or launched. Recalibrate after launch
with real Robinhood volume, fee income, and user-LP mix.

## Methodology

A Python harness (`scripts/range_optimize.py`) mirrors:

- `MasonryRangeLib` band / recenter / TWAP-deviation math (tick spacing 60)
- Uniswap v3/v4 concentrated-liquidity amounts
- Official 0.30% pool fee, inventory swap against residual full-range
  liquidity (30% of starting TVL) after the protocol position is removed
- `MAX_INVENTORY_LOSS_BPS = 100`, cooldown, TWAP guard
- Fire Tax curve matching `MasonryRules.targetSellTaxBps`: 3% at or above
  peg, 12% at or below a 10% drop, **square-root** in between (not the
  leftover PegDefenseHook 20% tier table)
- No Treasury seigniorage: the harness does **not** mint the old 28 × 4.5%
  bootstrap expansion or the gated `eligibleForExpansion` mint. It is an
  inventory / fee / redemption sim only.

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
**time below peg**, **hours below $0.99 and $0.95**, **depeg depth**
(max and p50 drawdown below $1, as a fraction of $1), **remaining USDG
reserves** / ending USDG (average of ending quote and quote during depegs),
and **redemption value** = USDG received on redeem (quote side plus xTOMB
sold through the pool after Fire Tax, the 30 bp pool fee, impact, and any
rebalance costs already reflected in book depth) / USDG-marked deposit
value. That is the pooled-user metric.

Score (xTOMB) weights ending inventory, vs-HODL (median and p10), recovery
depth/coverage, USDG reserves, user redemption value, time below peg, and
near-peg slippage — not just time in range. Score (xSHARE) weights median
and p10 vs-HODL, time in range, slippage, and rebalance cost.

## Chosen live-contract defaults

Defaults live under `policy.rangeLevel` (peg-anchor) and
`policy.rangeSquare` (follow).

| Pool | Mode | Wings | Recenter | Cooldown | Max TWAP deviation |
| --- | --- | --- | --- | --- | --- |
| xTOMB / USDG | **peg-anchor** | **−18% / +10%** (1800 / 1000 bps) | **666 bps** | 1800s | 300 bps |
| xSHARE / USDG | **follow** | **±8%** (800 bps) | **640 bps** | 1800s | 300 bps |

**xTOMB.** Peg-anchor −18% / +10% was the best *moving* design in the
rerun and matches the launch config. A Foundry test
(`testPegAnchorUpperEdgeStaysAtOrAbovePegOnDeepDepeg`) checks that the
price-space high edge stays at or above $1 at spot $0.70 and $0.80 for
both token orderings, and that both peg and spot ticks stay inside the
band. The in-family follow winner (±37% / 27.75%) sits outside the
500–3000 config bounds and barely recenters — it behaves like a wide
fixed book, not a legal live follow setting.

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

Best of each family from the 8 November 2026 rerun (`--quick`: 3 phase-1
seeds, 4 refine seeds, 3 width-curve seeds; median unless noted). Hours
are hourly steps with price below the named level. Drawdown is
`max(0, 1 − price)`.

| Strategy | Settings | End inventory | vs HODL | Recovery depth | Path coverage | Ending USDG | Redemption value | Rebalances | Hours < $0.99 | Hours < $0.95 | Max drawdown | p50 drawdown |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fixed around $1 | ±8% | $104,002 | +3.86% | **$25,397** | 0.95 | $40,370 | 0.792 | 0 | 821.5 | 260.5 | 18.7% | 1.8% |
| Peg-anchored (live xTOMB) | −18% / +10%, recenter 6.66% | $102,694 | +3.02% | $5,399 | **1.00** | **$59,024** | **0.799** | 282.5 | 821.5 | 260.5 | 18.7% | 1.6% |
| Follow (sweep best in-family) | ±37% / 27.75% (outside config cap) | $103,142 | +3.60% | $5,291 | 1.00 | $49,681 | 0.786 | 0 | 821.5 | 260.5 | 18.5% | 1.6% |
| Pooled users | ±15% Genesis-style overlay on the protocol book | — | — | — | — | — | see redemption column of the host strategy | — | same path | same path | same path | same path |

Fixed ±8% to ±15% around $1 scored highest on recovery-path depth because
liquidity stays parked at peg instead of trailing a depeg. That is the
right shape if the only goal is depth on the walk back to $1.

Peg-anchor is the better *moving* design: it follows down so the book does
not go idle in a −30% print, but the upper edge still reaches $1, so
buyers can walk price back up through protocol xTOMB. It also left the
most USDG in the protocol book and paid users back the most after costs.
It recenters often; that is cheap only because rebalance sells of xTOMB
are Fire-Tax-exempt (below).

Follow still needs a **wide** band and a **high** recenter threshold so a
routine −10% depeg does not yank liquidity off $1 — that is why a legal
follow book for xTOMB was previously ±20% / 16%. The launch path now uses
peg-anchor instead, so the recovery path through $1 stays inside the
position without requiring that wide follow.

Hours below $0.99 / $0.95 are almost identical across strategies because
the advertised price path is mostly exogenous (only a mild depth-based
pull to peg). Strategy differences show up in recovery-path depth, ending
USDG, and redemption value — not in how long the printed price stays
below peg.

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
- Peg-anchor (−18%/+10%): median about **$2,085** (2.1% of the $100k book;
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
share, and actual depeg paths after launch. This rerun used the
on-chain square-root Fire Tax curve; it still does not simulate
Treasury expansion or bootstrap minting.


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

The live `MasonryRangeManager` uses `pegAnchorTicks` when the launch
config selects peg-anchor (xTOMB −18% / +10%) and `bandTicks` follow for
xSHARE ±8%.
