import { useId, type ReactNode } from "react";
import { formatUnits, parseUnits } from "viem";

import { formatToken } from "@/lib/format";
import { maskDecimalInput } from "@/lib/util/decimal";

/** Parse a typed amount. Returns null for anything that is not a positive number. */
export function parseAmount(raw: string, decimals = 18): bigint | null {
  const clean = maskDecimalInput(raw);
  if (!clean || clean === ".") return null;
  try {
    const v = parseUnits(clean, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * The one amount input: a recessed well, the token on the right, and the
 * balance underneath with a Max button. Max fills the exact balance — the
 * amount sent is never a rounded display value.
 */
export function AmountField({
  label,
  value,
  onChange,
  symbol,
  icon,
  balance,
  balanceLabel = "Balance",
  decimals = 18,
  disabled = false,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  symbol: string;
  icon?: ReactNode;
  balance?: bigint | null;
  balanceLabel?: string;
  decimals?: number;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label">
          {label}
        </label>
        {balance !== undefined && (
          <span className="flex items-center gap-2 font-mono text-[11px] text-ash">
            {balanceLabel} <span className="text-bone-dim">{formatToken(balance, decimals)}</span>
            {!readOnly && (
              <button
                type="button"
                disabled={disabled || !balance}
                onClick={() => balance && onChange(formatUnits(balance, decimals))}
                className="rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-iris-hot transition-colors hover:border-iris/50 disabled:cursor-not-allowed disabled:text-ash-dim"
              >
                Max
              </button>
            )}
          </span>
        )}
      </div>
      <div className={`well px-4 py-3 ${disabled ? "opacity-60" : ""}`}>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          onChange={(e) => onChange(maskDecimalInput(e.target.value))}
          className="num w-full text-[22px] text-bone disabled:cursor-not-allowed"
        />
        <span className="flex shrink-0 items-center gap-2 font-mono text-[13px] font-medium text-bone">
          {icon}
          <span className="max-w-[9rem] truncate">{symbol}</span>
        </span>
      </div>
    </div>
  );
}
