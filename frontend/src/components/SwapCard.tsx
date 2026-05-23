import { useState, useMemo } from "react";

/**
 * SwapCard — token in / token out / flip / quote / CTA.
 *
 * Pure presentational. The parent owns the active pool, token symbols, current
 * pool price, and the submit handler. Sprint B wires the V4 quoter / router
 * here to compute the actual output amount + price impact + tax delta.
 *
 * Layout (Art Deco, centered axis):
 *   ┌───────────────────────────────────┐
 *   │  YOU PROVIDE      Max · 0          │
 *   │  [ 0.00     ]  ◆ MONEY            │
 *   │                                    │
 *   │              ◇  (flip button)      │
 *   │                                    │
 *   │  YOU RECEIVE      Net of Tax       │
 *   │  [ 0.00     ]  ◆ WETH             │
 *   │                                    │
 *   │  ─── ◆ ─── ◆ ─── ◆ ───            │
 *   │                                    │
 *   │  Rate         1.00 MONEY · WETH    │
 *   │  Hook Fee     0.30%                │
 *   │  Tax Tier     0 % (above peg)      │
 *   │  Net Out      0.00 WETH            │
 *   │                                    │
 *   │  [   AUTHORIZE · SWAP   ]          │
 *   └───────────────────────────────────┘
 */

interface SwapCardProps {
  tokenIn: string;
  tokenOut: string;
  maxIn: string;
  /** Spot price (tokenOut per 1 tokenIn). */
  rate: number;
  /** Hook fee in basis points (0.30% = 30 bps). */
  hookFeeBps: number;
  /** Tomb-style tax in basis points on tokenIn = MONEY when price < peg. 0 otherwise. */
  taxBps: number;
  /** Label for the current tier ("Above Peg" / "Tier 7 · 12% Tax" / etc.). */
  tierLabel: string;
  /** Direction is fixed in the parent; flip swaps tokenIn/tokenOut. */
  onFlip: () => void;
  /** Submit handler. */
  onSubmit?: (amount: string) => void;
  /** Disable the CTA (wallet disconnected, no liquidity, etc.). */
  disabled?: boolean;
  /** Reason shown when disabled. */
  disabledReason?: string;
}

export function SwapCard({
  tokenIn,
  tokenOut,
  maxIn,
  rate,
  hookFeeBps,
  taxBps,
  tierLabel,
  onFlip,
  onSubmit,
  disabled = false,
  disabledReason,
}: SwapCardProps) {
  const [amount, setAmount] = useState("");

  // Gross out = amount * rate. Net out subtracts hook fee + tax (both bps on out).
  const { grossOut, netOut } = useMemo(() => {
    const num = parseFloat(amount);
    if (!num || isNaN(num)) return { grossOut: "0.00", netOut: "0.00" };
    const gross = num * rate;
    const feeMultiplier = (10000 - hookFeeBps - taxBps) / 10000;
    return {
      grossOut: gross.toFixed(4),
      netOut: (gross * feeMultiplier).toFixed(4),
    };
  }, [amount, rate, hookFeeBps, taxBps]);

  const hookFeePct = (hookFeeBps / 100).toFixed(2);
  const taxPct = (taxBps / 100).toFixed(2);

  return (
    <div className="deco-panel mx-auto max-w-lg">
      {/* You Provide */}
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="label-deco text-deco-gold-dark">You Provide</span>
        <button
          type="button"
          onClick={() => setAmount(maxIn)}
          disabled={disabled}
          className="label-deco text-deco-gold transition-colors hover:text-deco-gold-light disabled:opacity-40"
        >
          Max · {maxIn}
        </button>
      </div>
      <div className="mb-4 flex items-center border border-deco-gold/50 bg-deco-ground">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={disabled}
          className="font-display w-full bg-transparent px-4 py-3 text-right text-2xl text-deco-ivory placeholder:text-deco-gold-dark/40 focus:outline-none disabled:opacity-50"
        />
        <div className="mr-4 flex items-center gap-2">
          <span className="text-deco-gold">◆</span>
          <span
            className="font-ornament text-sm text-deco-gold"
            style={{ letterSpacing: "0.2em" }}
          >
            {tokenIn}
          </span>
        </div>
      </div>

      {/* Flip button */}
      <div className="mb-4 flex justify-center">
        <button
          type="button"
          onClick={onFlip}
          disabled={disabled}
          aria-label="Reverse swap direction"
          className="group flex h-10 w-10 items-center justify-center border border-deco-gold/50 bg-deco-ground-soft text-deco-gold transition-colors hover:border-deco-gold hover:text-deco-gold-light disabled:opacity-40"
        >
          <span className="text-lg leading-none">◇</span>
        </button>
      </div>

      {/* You Receive */}
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="label-deco text-deco-gold-dark">You Receive</span>
        <span className="label-deco text-deco-gold-dark">Net of Tax</span>
      </div>
      <div className="mb-6 flex items-center border border-deco-gold/30 bg-deco-ground-soft">
        <div className="font-display w-full px-4 py-3 text-right text-2xl text-deco-ivory-soft">
          {netOut}
        </div>
        <div className="mr-4 flex items-center gap-2">
          <span className="text-deco-gold">◆</span>
          <span
            className="font-ornament text-sm text-deco-gold"
            style={{ letterSpacing: "0.2em" }}
          >
            {tokenOut}
          </span>
        </div>
      </div>

      {/* Divider */}
      <div className="mb-5 flex items-center justify-center gap-2 text-deco-gold/60">
        <span className="h-px flex-1 bg-deco-gold/40" />
        <span className="text-xs">◆</span>
        <span className="h-px flex-1 bg-deco-gold/40" />
      </div>

      {/* Quote rows */}
      <dl className="mb-6 space-y-3">
        <div className="flex justify-between">
          <dt className="label-deco text-deco-gold-dark">Rate</dt>
          <dd className="font-display text-base italic text-deco-ivory">
            1 {tokenIn} ·{" "}
            <span className="text-deco-ivory-soft">
              {rate.toFixed(6)} {tokenOut}
            </span>
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="label-deco text-deco-gold-dark">Hook Fee</dt>
          <dd className="font-display text-base italic text-deco-ivory">{hookFeePct}%</dd>
        </div>
        <div className="flex justify-between">
          <dt className="label-deco text-deco-gold-dark">Tax Tier</dt>
          <dd
            className={`font-display text-base italic ${taxBps > 0 ? "text-deco-ruby" : "text-deco-emerald"}`}
          >
            {tierLabel} · {taxPct}%
          </dd>
        </div>
        <div className="border-t border-deco-gold/20 pt-3">
          <div className="flex items-baseline justify-between">
            <dt className="label-deco text-deco-gold">Gross Out</dt>
            <dd className="font-display text-base italic text-deco-ivory-soft">
              {grossOut} {tokenOut}
            </dd>
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <dt className="label-deco text-deco-gold">Net Out</dt>
            <dd className="font-display text-xl italic text-deco-ivory">
              {netOut} {tokenOut}
            </dd>
          </div>
        </div>
      </dl>

      <button
        type="button"
        onClick={() => onSubmit?.(amount)}
        disabled={disabled || !amount}
        className="btn-deco btn-deco-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-40"
      >
        Authorize · Swap
      </button>
      {disabled && disabledReason && (
        <p className="mt-3 text-center font-body text-xs italic text-deco-gold-dark">
          {disabledReason}
        </p>
      )}
    </div>
  );
}
