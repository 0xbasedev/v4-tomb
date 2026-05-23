import { useState } from "react";
import { formatUnits } from "viem";

import { maskDecimalInput } from "@/lib/util/decimal";

/**
 * ActionPanel — a single user-facing action (Stake / Withdraw / Claim).
 *
 * Art Deco grammar: frame-within-frame deco-panel, centered axis, gold label
 * header, Cormorant input with right-aligned numeric value, formal CTA button.
 *
 * The component is purely presentational — the parent owns the action handler,
 * the lockup state, and any post-tx feedback. In Sprint B these get wired to
 * wagmi useWriteContract.
 */

interface ActionPanelProps {
  /** Ornament numeral above the title (Roman). */
  numeral?: string;
  /** Title in the Art Deco display serif. */
  title: string;
  /** One-line gloss in italic Cormorant. */
  blurb: string;
  /** Asset label shown next to the input field, e.g. "ESTATE". */
  asset: string;
  /** Display string shown on the MAX button label (e.g. "0.0540"). */
  maxAvailable: string;
  /**
   * Exact balance in wei. When provided, the MAX button click fills the input
   * with the precise unrounded value (formatUnits(maxWei, 18)) so the
   * downstream parseUnits never asks for more than the user holds. Without
   * this, the display string would be rounded and trigger 'insufficient
   * balance' reverts on full-balance deposits.
   */
  maxWei?: bigint;
  /** CTA button label. */
  cta: string;
  /** If true, the action is disabled — show the gate reason. */
  disabled?: boolean;
  /** Reason shown below the button when disabled. */
  disabledReason?: string;
  /** Click handler — placeholder for now; Sprint B wires wagmi useWriteContract. */
  onSubmit?: (amount: string) => void;
  /** Skip the amount input entirely — for Claim (no input, just a single button). */
  noInput?: boolean;
}

export function ActionPanel({
  numeral,
  title,
  blurb,
  asset,
  maxAvailable,
  maxWei,
  cta,
  disabled = false,
  disabledReason,
  onSubmit,
  noInput = false,
}: ActionPanelProps) {
  const [amount, setAmount] = useState("");

  function handleMax() {
    // Prefer the wei-precise value when available; fall back to the display
    // string for callers that haven't been migrated yet.
    if (maxWei !== undefined) {
      setAmount(formatUnits(maxWei, 18));
    } else {
      setAmount(maxAvailable);
    }
  }

  function handleSubmit() {
    if (onSubmit) onSubmit(amount);
  }

  return (
    <div className="deco-panel flex h-full flex-col text-center">
      {numeral && (
        <div
          className="font-ornament mb-3 text-2xl font-bold text-deco-gold"
          style={{ letterSpacing: "0.2em" }}
        >
          {numeral}
        </div>
      )}
      <h3
        className="mb-3 font-display text-2xl text-deco-ivory md:text-3xl"
        style={{ letterSpacing: "0.06em" }}
      >
        {title}
      </h3>
      <div className="mx-auto mb-5 h-[1px] w-12 bg-deco-gold" aria-hidden />
      <p className="mb-7 px-2 font-body text-sm italic text-deco-ivory-soft">{blurb}</p>

      {!noInput && (
        <>
          <div className="mb-2 flex items-baseline justify-between px-1">
            <span className="label-deco text-deco-gold-dark">Amount</span>
            <button
              type="button"
              onClick={handleMax}
              disabled={disabled}
              aria-label={`Set amount to maximum (${maxAvailable} ${asset})`}
              className="label-deco rounded-none text-deco-gold transition-colors hover:text-deco-gold-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-deco-gold disabled:opacity-40"
            >
              Max · {maxAvailable}
            </button>
          </div>
          <div className="mb-5 flex items-center border border-deco-gold/50 bg-deco-ground focus-within:border-deco-gold">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(maskDecimalInput(e.target.value))}
              disabled={disabled}
              aria-label={`${title} · amount in ${asset}`}
              className="font-display w-full bg-transparent px-4 py-3 text-right text-2xl text-deco-ivory placeholder:text-deco-gold-dark/40 focus:outline-none disabled:opacity-50"
            />
            <span
              className="font-ornament mr-4 text-sm text-deco-gold"
              style={{ letterSpacing: "0.2em" }}
            >
              {asset}
            </span>
          </div>
        </>
      )}

      <div className="mt-auto">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled}
          className="btn-deco btn-deco-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-40"
        >
          {cta}
        </button>
        {disabled && disabledReason && (
          <p className="mt-3 font-body text-xs italic text-deco-gold-dark">{disabledReason}</p>
        )}
      </div>
    </div>
  );
}
