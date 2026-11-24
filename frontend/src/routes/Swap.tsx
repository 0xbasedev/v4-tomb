import { pegReserves } from "../../../config/schema.mjs";
import { useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";

import { RuleTrio } from "@/components/RuleTrio";
import { StatTile } from "@/components/StatTile";
import { SwapCard } from "@/components/SwapCard";
import { TabBar } from "@/components/TabBar";
import { TaxScheduleTable, tierLabel } from "@/components/TaxScheduleTable";

import { useDeployment, usePoolPrice, usePoolReserves, useSwap } from "@/lib/hooks";
import { erc20Abi } from "@/lib/abis";
import { useToast } from "@/components/ToastProvider";
import { maskDecimalInput } from "@/lib/util/decimal";
import { formatToken, formatTokenAuto } from "@/lib/format";

/** LPFeeLibrary.DYNAMIC_FEE_FLAG — the V4 fee value used for hook-controlled pools. */
const DYNAMIC_FEE_FLAG = 0x800000;
const PEG_POOL_TICK_SPACING = 60;

/**
 * The Exchange — V4 swap with PegDefenseHook tax surface.
 *
 * Two pools available (both anchored to WETH):
 *   I.  xTOMB-WETH — peg pool, PegDefenseHook attached, 0.30% base fee +
 *       dynamic tax (0–30%) when xTOMB trades below par
 *   II. xSHARE-WETH — share pool, no hook, plain 0.30% fee
 *
 * Layout:
 *   1. Heading — Roman IV, "The Exchange" title
 *   2. Pool tabs — xTOMB/WETH | xSHARE/WETH
 *   3. SwapCard — directional input → output with flip button + quote rows.
 *      Tax tier badge shows current schedule entry when xTOMB-out (sells)
 *      below peg.
 *   4. Pool state — 4 tiles (Spot, Liquidity, 24h Volume, Hook State)
 *   5. TaxScheduleTable — visible only when xTOMB-WETH selected; highlights
 *      active tier from current price
 *   6. The Mechanism — explanatory panel
 */

type PoolId = "peg-weth" | "share-weth";

interface PoolView {
  id: PoolId;
  numeral: "I" | "II";
  base: string;
  quote: string;
  /** Current spot price (quote per 1 base, e.g. 1 xTOMB = 0.97 WETH). */
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
  "peg-weth": {
    id: "peg-weth",
    numeral: "I",
    base: "xTOMB",
    quote: "WETH",
    spotPrice: 1.0,
    liquidity: "0",
    volume24h: "0",
    hookState: "Active · Above Peg",
    baseFeeBps: 30,
  },
  "share-weth": {
    id: "share-weth",
    numeral: "II",
    base: "xSHARE",
    quote: "WETH",
    spotPrice: 0.001,
    liquidity: "0",
    volume24h: "0",
    hookState: "—",
    baseFeeBps: 30,
  },
};

export function Swap() {
  const [activeId, setActiveId] = useState<PoolId>("peg-weth");
  // Direction: when true, base → quote (sell). When false, quote → base (buy).
  const [sellingBase, setSellingBase] = useState(true);

  const poolMeta = POOLS[activeId];
  const liveHook = usePoolPrice();
  const deployment = useDeployment();
  const { address } = useAccount();
  const swap = useSwap();
  const toast = useToast();

  // Read xTOMB + WETH balances so the SwapCard's MAX has something to fill
  // and the disabled state can gate on actual funds.
  const balances = useReadContracts({
    allowFailure: false,
    contracts:
      deployment && address
        ? [
            { address: deployment.peg, abi: erc20Abi, functionName: "balanceOf", args: [address] },
            { address: deployment.weth, abi: erc20Abi, functionName: "balanceOf", args: [address] },
          ]
        : [],
    query: { enabled: !!deployment && !!address, refetchInterval: 15_000 },
  });
  const pegBal = balances.data?.[0] ?? 0n;
  const wethBal = balances.data?.[1] ?? 0n;

  // Pool depth — read from V4 PoolManager state via extsload. This gives
  // OUR pool's reserves exactly, not all V4 pools on the chain.
  // PoolKey for xTOMB-WETH; computed live from deployment addresses.
  const pegWethPoolKey = deployment
    ? (() => {
        const wethIsToken0 =
          (deployment.weth as string).toLowerCase() < (deployment.peg as string).toLowerCase();
        return {
          currency0: wethIsToken0 ? deployment.weth : deployment.peg,
          currency1: wethIsToken0 ? deployment.peg : deployment.weth,
          fee: DYNAMIC_FEE_FLAG,
          tickSpacing: PEG_POOL_TICK_SPACING,
          hooks: deployment.hook,
        };
      })()
    : null;
  const reserves = usePoolReserves(pegWethPoolKey);
  const orderedReserves = deployment
    ? pegReserves(deployment.peg, deployment.weth, reserves.amount0, reserves.amount1)
    : { weth: 0n, peg: 0n };
  const poolWeth = orderedReserves.weth;
  const poolPeg = orderedReserves.peg;

  // For xTOMB-WETH the spot price comes from the hook's lastTick. xSHARE-WETH
  // is not bound to any of our hooks, so for now we keep its spot at the
  // hardcoded placeholder — a future turn ships a generic V4 PoolManager
  // getSlot0 reader for non-hooked pools.
  const liveSpot =
    activeId === "peg-weth" && liveHook.bound && liveHook.price > 0n
      ? Number(formatUnits(liveHook.price, 18))
      : poolMeta.spotPrice;

  const tokenIn = sellingBase ? poolMeta.base : poolMeta.quote;
  const tokenOut = sellingBase ? poolMeta.quote : poolMeta.base;
  const rate = sellingBase ? liveSpot : 1 / liveSpot;

  // Active-direction tokenIn balance — drives the MAX button and the
  // disabled state. Only xTOMB-WETH is wired; xSHARE-WETH tokenIn is
  // currently xSHARE which we don't read here (the panel is disabled
  // for xSHARE-WETH anyway).
  const tokenInBalance =
    activeId === "peg-weth" ? (sellingBase ? pegBal : wethBal) : 0n;
  const maxInDisplay = formatToken(tokenInBalance, 6);

  // Tax tier: only meaningful on xTOMB-WETH, when selling xTOMB, and when the
  // hook actually has autoCalculateTax enabled. The schedule itself still
  // renders below — it's informational regardless of the on/off state.
  // The rate comes from the hook itself: it taxes against the oracle TWAP, so
  // re-deriving a tier from the spot price here would quote the wrong amount.
  const taxActive = activeId === "peg-weth" && sellingBase && liveHook.taxOn;
  const tier = taxActive
    ? { label: tierLabel(liveHook.taxRateBps), bps: liveHook.taxRateBps }
    : { label: "No Tax", bps: 0 };
  const taxPriceEth =
    liveHook.taxPrice > 0n ? Number(formatUnits(liveHook.taxPrice, 18)) : liveSpot;

  const hookStateLabel =
    activeId !== "peg-weth"
      ? "—"
      : !liveHook.bound
        ? "Awaiting Pool Init"
        : liveHook.taxOn
          ? `Tax Active · ${tier.label}`
          : "Tax Disabled";

  // Compose the V4 swap pipeline. xTOMB-WETH only — xSHARE-WETH isn't a deployed pool yet.
  function handleSwapSubmit(amountStr: string, slippageBps: number) {
    if (activeId !== "peg-weth") {
      toast.push({
        variant: "info",
        title: "Pool not yet live",
        message: "xSHARE-WETH is not deployed. Trade xTOMB-WETH on the I tab instead.",
        durationMs: 6_000,
      });
      return;
    }
    if (!deployment) {
      toast.push({
        variant: "error",
        title: "Wallet not connected",
        message: "Connect on a configured network to swap.",
      });
      return;
    }

    const clean = maskDecimalInput(amountStr);
    let amountIn: bigint;
    try {
      amountIn = parseUnits(clean || "0", 18);
    } catch {
      return;
    }
    if (amountIn <= 0n) return;

    // V4 sorts currencies by address on every chain.
    const wethIsToken0 = (deployment.weth as string).toLowerCase() < (deployment.peg as string).toLowerCase();
    const currency0: Address = wethIsToken0 ? deployment.weth : deployment.peg;
    const currency1: Address = wethIsToken0 ? deployment.peg : deployment.weth;

    // zeroForOne: are we swapping currency0 → currency1?
    // sellingBase = true → selling xTOMB → we want xTOMB -> WETH.
    //   If xTOMB is currency1, then currency1 -> currency0, so zeroForOne = false.
    const sellingPeg = sellingBase;
    const zeroForOne = wethIsToken0 ? !sellingPeg : sellingPeg;

    const tokenIn: Address = zeroForOne ? currency0 : currency1;

    // Compute amountOutMinimum from live spot, hook fee, current tax tier, and
    // user's slippage tolerance. All three deductions are in bps.
    //
    //   netRate = rate * (10000 - hookFee - taxBps) / 10000
    //   expectedOut_wei = amountIn * netRate (using bigint math to preserve precision)
    //   amountOutMinimum = expectedOut * (10000 - slippageBps) / 10000
    //
    // We do the rate multiplication via the ETH-scaled price to stay in bigint
    // throughout (no float drift on large amountIn values).
    const rateBps = BigInt(Math.floor(rate * 1e6)); // micro-units for precision
    const grossOut = (amountIn * rateBps) / 1_000_000n;
    const netOut = (grossOut * BigInt(10_000 - poolMeta.baseFeeBps - tier.bps)) / 10_000n;
    const amountOutMinimum = (netOut * BigInt(10_000 - slippageBps)) / 10_000n;

    swap.submit({
      poolKey: {
        currency0,
        currency1,
        fee: DYNAMIC_FEE_FLAG,
        tickSpacing: PEG_POOL_TICK_SPACING,
        hooks: deployment.hook,
      },
      zeroForOne,
      tokenIn: tokenIn as Address,
      amountIn,
      amountOutMinimum,
      onSuccess: () => {
        liveHook.refetch();
      },
    });
  }

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
            tax on sales that eases as the peg strengthens: 12%, then 6% from
            1.12, then 3% from 1.20.
          </p>
        </div>
      </section>

      {/* ===== Pool Tabs ===== */}
      <section className="px-6 pb-10 md:px-12 md:pb-10">
        <TabBar
          active={activeId}
          onChange={(id) => setActiveId(id as PoolId)}
          items={[
            { id: "peg-weth", numeral: "I", label: "xTOMB · WETH", sublabel: "Peg Pool" },
            {
              id: "share-weth",
              numeral: "II",
              label: "xSHARE · WETH",
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
          maxIn={maxInDisplay}
          rate={rate}
          hookFeeBps={poolMeta.baseFeeBps}
          taxBps={tier.bps}
          tierLabel={tier.label}
          onFlip={() => setSellingBase((b) => !b)}
          onSubmit={handleSwapSubmit}
          disabled={
            swap.isInFlight ||
            activeId !== "peg-weth" ||
            (activeId === "peg-weth" && tokenInBalance === 0n)
          }
          disabledReason={
            activeId !== "peg-weth"
              ? "xSHARE-WETH pool is not yet deployed."
              : swap.isInFlight
                ? "Swap in flight…"
                : tokenInBalance === 0n
                  ? `No ${tokenIn} in your wallet.`
                  : undefined
          }
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
              value={liveSpot.toFixed(4)}
              hint={`WETH per 1 ${poolMeta.base}`}
            />
            <StatTile
              label="Pool · xTOMB"
              value={activeId === "peg-weth" ? formatTokenAuto(poolPeg) : "—"}
              hint="$xTOMB held by V4 PoolManager"
            />
            <StatTile
              label="Pool · WETH"
              value={activeId === "peg-weth" ? formatTokenAuto(poolWeth) : "—"}
              hint="$WETH held by V4 PoolManager"
            />
            <StatTile
              label="Hook State"
              value={hookStateLabel}
              hint={activeId === "peg-weth" ? "PegDefenseHook" : "No Hook Attached"}
            />
          </div>
        </div>
      </section>

      {/* ===== Tax Schedule (xTOMB-WETH only) ===== */}
      {activeId === "peg-weth" && (
        <section className="px-6 pb-14 md:px-12 md:pb-16">
          <div className="mx-auto max-w-3xl">
            <TaxScheduleTable activePriceEth={taxPriceEth} />
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
                  When xTOMB trades below par, the Hook intercepts each outgoing sale
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
