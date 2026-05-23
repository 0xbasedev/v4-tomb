import { useState, useMemo } from "react";

/**
 * BondForm — input field + computed preview + CTA, used for the Trust Notes
 * acquire/redeem flows.
 *
 * Unlike ActionPanel (a simple stake/withdraw), BondForm includes a separate
 * preview row showing the asset received at the current rate. Rate is passed
 * in as a number (multiplier where 1 = 1:1); the preview multiplies the input
 * by the rate.
 *
 * Pure presentational. The parent owns the rate (read from Treasury in Sprint B)
 * and the submit handler.
 */

interface BondFormProps {
  /** Input field label. */
  inputLabel: string;
  /** Input field asset suffix, e.g. "MONEY". */
  inputAsset: string;
  /** Max amount user has of the input asset. */
  maxAvailable: string;
  /** Output asset suffix shown in the preview, e.g. "TRUSTNOTE". */
  outputAsset: string;
  /** Multiplier: outputAmount = inputAmount * rate. 1 = 1:1. */
  rate: number;
  /** Rate label shown next to the multiplier badge, e.g. "Issuance Discount". */
  rateLabel: string;
  /** CTA label. */
  cta: string;
  /** Disable everything (market closed / wallet not connected). */
  disabled?: boolean;
  /** Reason shown when disabled. */
  disabledReason?: string;
  /** Optional secondary line of guidance shown above the CTA. */
  helper?: string;
  /** Submit handler — Sprint B wires wagmi useWriteContract here. */
  onSubmit?: (amount: string) => void;
}

export function BondForm({
  inputLabel,
  inputAsset,
  maxAvailable,
  outputAsset,
  rate,
  rateLabel,
  cta,
  disabled = false,
  disabledReason,
  helper,
  onSubmit,
}: BondFormProps) {
  const [amount, setAmount] = useState("");

  const previewOut = useMemo(() => {
    const num = parseFloat(amount);
    if (!num || isNaN(num)) return "0.00";
    return (num * rate).toFixed(4);
  }, [amount, rate]);

  return (
    <div className="deco-panel">
      {/* Input row */}
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="label-deco text-deco-gold-dark">{inputLabel}</span>
        <button
          type="button"
          onClick={() => setAmount(maxAvailable)}
          disabled={disabled}
          className="label-deco text-deco-gold transition-colors hover:text-deco-gold-light disabled:opacity-40"
        >
          Max · {maxAvailable}
        </button>
      </div>
      <div className="mb-6 flex items-center border border-deco-gold/50 bg-deco-ground">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={disabled}
          className="font-display w-full bg-transparent px-4 py-3 text-right text-2xl text-deco-ivory placeholder:text-deco-gold-dark/40 focus:outline-none disabled:opacity-50"
        />
        <span
          className="font-ornament mr-4 text-sm text-deco-gold"
          style={{ letterSpacing: "0.2em" }}
        >
          {inputAsset}
        </span>
      </div>

      {/* Rate badge */}
      <div className="mb-6 flex items-center justify-center">
        <div className="inline-flex items-center gap-3 border border-deco-gold/50 px-4 py-2">
          <span className="label-deco text-deco-gold-dark">{rateLabel}</span>
          <span
            className="font-display text-lg italic text-deco-gold"
            style={{ letterSpacing: "0.05em" }}
          >
            {rate.toFixed(4)}×
          </span>
        </div>
      </div>

      {/* Preview row */}
      <div className="mb-2 px-1">
        <span className="label-deco text-deco-gold-dark">You Shall Receive</span>
      </div>
      <div className="mb-6 flex items-center border border-deco-gold/30 bg-deco-ground-soft">
        <div className="font-display w-full px-4 py-3 text-right text-2xl text-deco-ivory-soft">
          {previewOut}
        </div>
        <span
          className="font-ornament mr-4 text-sm text-deco-gold"
          style={{ letterSpacing: "0.2em" }}
        >
          {outputAsset}
        </span>
      </div>

      {helper && (
        <p className="mb-4 text-center font-body text-sm italic text-deco-gold-dark">{helper}</p>
      )}

      <button
        type="button"
        onClick={() => onSubmit?.(amount)}
        disabled={disabled || !amount}
        className="btn-deco btn-deco-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-40"
      >
        {cta}
      </button>
      {disabled && disabledReason && (
        <p className="mt-3 text-center font-body text-xs italic text-deco-gold-dark">
          {disabledReason}
        </p>
      )}
    </div>
  );
}
