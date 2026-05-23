import { useState } from "react";

import { RuleTrio } from "@/components/RuleTrio";
import { StatTile } from "@/components/StatTile";
import { SwapCard } from "@/components/SwapCard";
import { TabBar } from "@/components/TabBar";
import { TaxScheduleTable, tierAt } from "@/components/TaxScheduleTable";

/**
 * The Exchange — V4 swap with PegDefenseHook tax surface.
 *
 * Two pools available (both anchored to WETH):
 *   I.  MONEY-WETH — peg pool, PegDefenseHook attached, 0.30% base fee +
 *       dynamic tax (0–30%) when MONEY trades below par
 *   II. ESTATE-WETH — share pool, no hook, plain 0.30% fee
 *
 * Layout:
 *   1. Heading — Roman IV, "The Exchange" title
 *   2. Pool tabs — MONEY/WETH | ESTATE/WETH
 *   3. SwapCard — directional input → output with flip button + quote rows.
 *      Tax tier badge shows current schedule entry when MONEY-out (sells)
 *      below peg.
 *   4. Pool state — 4 tiles (Spot, Liquidity, 24h Volume, Hook State)
 *   5. TaxScheduleTable — visible only when MONEY-WETH selected; highlights
 *      active tier from current price
 *   6. The Mechanism — explanatory panel
 */

type PoolId = "money-weth" | "estate-weth";

interface PoolView {
  id: PoolId;
  numeral: "I" | "II";
  base: string;
  quote: string;
  /** Current spot price (quote per 1 base, e.g. 1 MONEY = 0.97 WETH). */
  spotPrice: number;
  /** Pool liquidity in WETH-equivalent terms (placeholder). */
  liquidity: string;
  /** 24h volume in WETH-equivalent terms (placeholder). */
  volume24h: string;
  /** Hook state label. */
  hookState: string;
  /** Base fee bps. 30 = 0.30% — V4 LP fee, separate from hook tax. */
  baseFeeBps: number;
}

const POOLS: Record<PoolId, PoolView> = {
  "money-weth": {
    id: "money-weth",
    numeral: "I",
    base: "MONEY",
    quote: "WETH",
    spotPrice: 1.0,
    liquidity: "0",
    volume24h: "0",
    hookState: "Active · Above Peg",
    baseFeeBps: 30,
  },
  "estate-weth": {
    id: "estate-weth",
    numeral: "II",
    base: "ESTATE",
    quote: "WETH",
    spotPrice: 0.001,
    liquidity: "0",
    volume24h: "0",
    hookState: "—",
    baseFeeBps: 30,
  },
};

export function Swap() {
  const [activeId, setActiveId] = useState<PoolId>("money-weth");
  // Direction: when true, base → quote (sell). When false, quote → base (buy).
  const [sellingBase, setSellingBase] = useState(true);

  const pool = POOLS[activeId];
  const tokenIn = sellingBase ? pool.base : pool.quote;
  const tokenOut = sellingBase ? pool.quote : pool.base;
  // Rate from tokenIn → tokenOut, derived from spot.
  const rate = sellingBase ? pool.spotPrice : 1 / pool.spotPrice;

  // Tax only applies when selling MONEY into the money-weth pool and price < 1.0.
  const tier =
    activeId === "money-weth" && sellingBase
      ? tierAt(pool.spotPrice)
      : { label: "No Tax", bps: 0 };

  return (
    <div className="bg-deco-ground">
      {/* ===== Heading ===== */}
      <section className="relative px-6 pt-16 pb-12 md:px-12 md:pt-20 md:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">
            A Pavilion of The Trust · The Trading Floor
          </div>
          <div
            className="font-ornament mb-4 text-3xl font-bold text-deco-gold"
            style={{ letterSpacing: "0.2em" }}
          >
            IV
          </div>
          <h1 className="gold-text font-display italic text-section">The Exchange</h1>
          <RuleTrio className="mb-6 mt-8" />
          <p
            className="mx-auto max-w-2xl font-headline text-lg italic text-deco-ivory-soft md:text-xl"
            style={{ letterSpacing: "0.04em" }}
          >
            Trade upon the Uniswap V4 venue. The Hook defends the peg with a
            fourteen-tier tax. Above par, you pay only the base fee.
          </p>
        </div>
      </section>

      {/* ===== Pool Tabs ===== */}
      <section className="px-6 pb-10 md:px-12 md:pb-10">
        <TabBar
          active={activeId}
          onChange={(id) => setActiveId(id as PoolId)}
          items={[
            { id: "money-weth", numeral: "I", label: "MONEY · WETH", sublabel: "Peg Pool" },
            {
              id: "estate-weth",
              numeral: "II",
              label: "ESTATE · WETH",
              sublabel: "Share Pool",
            },
          ]}
        />
      </section>

      {/* ===== Swap Card ===== */}
      <section className="px-6 pb-14 md:px-12 md:pb-16">
        <SwapCard
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          maxIn="0"
          rate={rate}
          hookFeeBps={pool.baseFeeBps}
          taxBps={tier.bps}
          tierLabel={tier.label}
          onFlip={() => setSellingBase((b) => !b)}
        />
      </section>

      {/* ===== Pool State ===== */}
      <section className="px-6 pb-14 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The State of The Pool
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
            <StatTile
              label="Spot Quotation"
              value={pool.spotPrice.toFixed(4)}
              hint={`WETH per 1 ${pool.base}`}
            />
            <StatTile
              label="Liquidity"
              value={pool.liquidity}
              hint="WETH · Pool Depth"
            />
            <StatTile
              label="Volume · 24h"
              value={pool.volume24h}
              hint="WETH · Trailing"
            />
            <StatTile
              label="Hook State"
              value={pool.hookState}
              hint={activeId === "money-weth" ? "PegDefenseHook" : "No Hook Attached"}
            />
          </div>
        </div>
      </section>

      {/* ===== Tax Schedule (MONEY-WETH only) ===== */}
      {activeId === "money-weth" && (
        <section className="px-6 pb-14 md:px-12 md:pb-16">
          <div className="mx-auto max-w-3xl">
            <TaxScheduleTable activePriceEth={pool.spotPrice} />
          </div>
        </section>
      )}

      {/* ===== The Mechanism ===== */}
      <section className="px-6 pb-20 md:px-12 md:pb-28">
        <div className="mx-auto max-w-3xl">
          <div className="deco-panel">
            <div className="label-deco mb-3 text-deco-gold-dark">The Mechanism</div>
            <h2
              className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl"
              style={{ letterSpacing: "0.06em" }}
            >
              The Hook and The Fee
            </h2>
            <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
            <div className="grid grid-cols-1 gap-6 text-left md:grid-cols-2">
              <div className="border-l border-deco-gold/40 pl-5">
                <div className="label-deco mb-2 text-deco-gold">Base Fee</div>
                <p className="font-body text-sm italic text-deco-ivory-soft">
                  Three-tenths of one per cent on every swap. Paid to providers of
                  liquidity. The standard rate of the Uniswap venue.
                </p>
              </div>
              <div className="border-l border-deco-gold/40 pl-5">
                <div className="label-deco mb-2 text-deco-gold">Peg Defense</div>
                <p className="font-body text-sm italic text-deco-ivory-soft">
                  When MONEY trades below par, the Hook intercepts each outgoing sale
                  and levies the schedule's tax. During contraction, the proceeds are
                  burned outright; otherwise they accrue to The Treasury.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
