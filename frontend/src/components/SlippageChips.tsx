import { useState } from "react";

import { maskDecimalInput } from "@/lib/util/decimal";

/**
 * SlippageChips — presets + custom. Values above 5% turn the chip amber and
 * name the risk, because high slippage is how users get sandwiched.
 */

const PRESETS = [
  { label: "0.5%", bps: 50 },
  { label: "1%", bps: 100 },
  { label: "3%", bps: 300 },
] as const;

interface SlippageChipsProps {
  valueBps: number;
  onChange: (bps: number) => void;
  /** Hard cap for custom entry (bps). Testnet pools are shallow, so allow high values — but warn. */
  maxBps?: number;
}

export function SlippageChips({ valueBps, onChange, maxBps = 9_900 }: SlippageChipsProps) {
  const [customRaw, setCustomRaw] = useState("");
  const isCustom = !PRESETS.some((p) => p.bps === valueBps);
  const risky = valueBps > 500;

  function handleCustom(raw: string) {
    const masked = maskDecimalInput(raw);
    setCustomRaw(masked);
    if (masked === "" || masked === ".") return;
    const pct = parseFloat(masked);
    if (!isFinite(pct) || pct < 0) return;
    onChange(Math.min(Math.round(pct * 100), maxBps));
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
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
              className={`h-8 rounded-lg px-3 font-mono text-[12px] transition-colors ${
                active ? "bg-white/10 text-bone" : "text-ash hover:bg-white/[0.04] hover:text-bone-dim"
              }`}
            >
              {p.label}
            </button>
          );
        })}
        <label
          className={`flex h-8 items-center rounded-lg border px-2 ${
            isCustom ? (risky ? "border-warn/50" : "border-white/15") : "border-white/[0.06]"
          }`}
        >
          <input
            type="text"
            inputMode="decimal"
            placeholder="Custom"
            value={customRaw}
            onChange={(e) => handleCustom(e.target.value)}
            aria-label="Custom slippage tolerance (percent)"
            className="num w-16 bg-transparent text-right text-[12px] text-bone outline-none"
          />
          <span className="ml-1 font-mono text-[11px] text-ash">%</span>
        </label>
      </div>
      {risky && (
        <p className="mt-2 text-[12px] text-warn/90">
          ▲ {(valueBps / 100).toFixed(1)}% slippage invites sandwich attacks. Only use on shallow testnet pools.
        </p>
      )}
    </div>
  );
}
