import { useState } from "react";

import { maskDecimalInput } from "@/lib/util/decimal";

/**
 * SlippageChips — Art Deco chip selector for swap slippage tolerance.
 *
 * Three presets (0.5 / 1.0 / 5.0 percent) plus a Custom field that accepts
 * any decimal percent value. The value is reported as basis points (50, 100,
 * 500) so the consumer's downstream math stays in integer space.
 *
 * Style: gold-bordered rectangles, no rounding. Active chip fills with gold +
 * inverts text color (matches TabBar). Custom input mirrors the BondForm
 * input style — single-line gold-bordered well with right-aligned number.
 */

const PRESETS = [
  { label: "0.5%", bps: 50 },
  { label: "1.0%", bps: 100 },
  { label: "5.0%", bps: 500 },
] as const;

interface SlippageChipsProps {
  /** Current slippage in basis points (100 = 1%). */
  valueBps: number;
  onChange: (bps: number) => void;
  /** Optional cap on user-entered slippage, in bps. Default 5000 (50%). */
  maxBps?: number;
}

export function SlippageChips({ valueBps, onChange, maxBps = 5000 }: SlippageChipsProps) {
  const [customRaw, setCustomRaw] = useState("");

  // "Custom" is active when valueBps doesn't match any preset.
  const isCustomActive = !PRESETS.some((p) => p.bps === valueBps);

  function handleCustom(raw: string) {
    const masked = maskDecimalInput(raw);
    setCustomRaw(masked);
    if (masked === "" || masked === ".") return;
    const pct = parseFloat(masked);
    if (!isFinite(pct) || pct < 0) return;
    const bps = Math.min(Math.round(pct * 100), maxBps);
    onChange(bps);
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {PRESETS.map((p) => {
        const active = p.bps === valueBps;
        return (
          <button
            key={p.bps}
            type="button"
            onClick={() => {
              onChange(p.bps);
              setCustomRaw("");
            }}
            aria-pressed={active}
            className={`label-deco border px-3 py-1.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-deco-gold ${
              active
                ? "border-deco-gold bg-deco-gold text-deco-ground"
                : "border-deco-gold/40 text-deco-gold hover:border-deco-gold"
            }`}
          >
            {p.label}
          </button>
        );
      })}
      <div
        className={`flex items-center border bg-deco-ground ${
          isCustomActive ? "border-deco-gold" : "border-deco-gold/40"
        }`}
      >
        <input
          type="text"
          inputMode="decimal"
          placeholder="Custom"
          value={customRaw}
          onChange={(e) => handleCustom(e.target.value)}
          aria-label="Custom slippage tolerance (percent)"
          className="font-display w-20 bg-transparent px-3 py-1 text-right text-sm text-deco-ivory placeholder:text-deco-gold-dark/40 focus:outline-none"
        />
        <span
          className="font-ornament mr-2 text-xs text-deco-gold"
          style={{ letterSpacing: "0.2em" }}
        >
          %
        </span>
      </div>
    </div>
  );
}
