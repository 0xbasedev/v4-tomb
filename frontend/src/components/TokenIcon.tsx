/**
 * Token glyphs. Each token has a shape AND a heat, so they're distinguishable
 * in greyscale and at 16px:
 *   xTOMB  — pyramid, ember          (the peg)
 *   xSHARE — faceted shard, spectre  (the claim on seigniorage)
 *   xBOND  — hex seal, amethyst      (the IOU)
 *   USDC   — ring + bar, blue        (the peg quote)
 *   ETH/WETH — diamond, neutral
 * LP tokens render as their two halves, overlapped — they're first-class
 * tokens, so they get a real mark rather than a generic "LP" chip.
 */

import { TOKENS, type TokenId } from "@/lib/tokens";

export type TokenSymbol = TokenId | "LP" | string;

const TONES: Record<string, { fg: string; bg: string; ring: string }> = {
  xTOMB: { fg: "#ff8a4c", bg: "rgba(255,106,43,0.12)", ring: "rgba(255,106,43,0.45)" },
  xSHARE: { fg: "#6ff0ff", bg: "rgba(62,231,255,0.10)", ring: "rgba(62,231,255,0.40)" },
  xBOND: { fg: "#c9adff", bg: "rgba(180,140,255,0.12)", ring: "rgba(180,140,255,0.45)" },
  USDC: { fg: "#5b9dff", bg: "rgba(39,117,202,0.16)", ring: "rgba(91,157,255,0.45)" },
  ETH: { fg: "#c9ced8", bg: "rgba(201,206,216,0.08)", ring: "rgba(201,206,216,0.30)" },
  WETH: { fg: "#c9ced8", bg: "rgba(201,206,216,0.08)", ring: "rgba(201,206,216,0.30)" },
  cbBTC: { fg: "#f7a33b", bg: "rgba(247,163,59,0.12)", ring: "rgba(247,163,59,0.40)" },
  cbETH: { fg: "#7aa2ff", bg: "rgba(0,82,255,0.14)", ring: "rgba(122,162,255,0.40)" },
};

function Glyph({ symbol, color }: { symbol: string; color: string }) {
  switch (symbol) {
    case "xTOMB":
      return (
        <>
          <path d="M12 4.5 19.5 18h-15Z" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M12 13.4 15.2 18H8.8Z" fill={color} />
        </>
      );
    case "xSHARE":
      return (
        <>
          <path d="M12 3.5 18 9.5 12 20.5 6 9.5Z" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M6 9.5h12M12 3.5v17" stroke={color} strokeWidth="1.2" opacity=".6" />
        </>
      );
    case "xBOND":
      return (
        <>
          <path d="M12 3.8 19 7.9v8.2l-7 4.1-7-4.1V7.9Z" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="2.6" fill={color} />
        </>
      );
    case "USDC":
      return (
        <>
          <circle cx="12" cy="12" r="7.2" fill="none" stroke={color} strokeWidth="1.8" />
          <path d="M14.4 9.6c-.5-.9-1.4-1.3-2.4-1.3-1.4 0-2.4.7-2.4 1.8 0 2.5 4.9 1.3 4.9 3.9 0 1.1-1.1 1.9-2.5 1.9-1.1 0-2.1-.5-2.6-1.4M12 6.8v1.5M12 15.8v1.4" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    case "cbBTC":
      return (
        <>
          <circle cx="12" cy="12" r="7.2" fill="none" stroke={color} strokeWidth="1.8" />
          <path d="M10 8h3a1.8 1.8 0 0 1 0 3.6H10Zm0 3.6h3.4a1.9 1.9 0 0 1 0 3.8H10ZM10 8v7.4M11 6.6V8m0 7.4v1.4" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
        </>
      );
    case "cbETH":
      return (
        <>
          <circle cx="12" cy="12" r="7.6" fill="none" stroke={color} strokeWidth="1.4" />
          <path d="M12 6.2 15.6 12 12 17.8 8.4 12Z" fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        </>
      );
    default:
      return <path d="M12 3.5 18.5 12 12 20.5 5.5 12Z" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />;
  }
}

function Single({ symbol, size, className = "" }: { symbol: string; size: number; className?: string }) {
  const tone = TONES[symbol] ?? TONES.ETH;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{ width: size, height: size, background: tone.bg, boxShadow: `inset 0 0 0 1px ${tone.ring}` }}
      aria-hidden
    >
      <svg width={size * 0.72} height={size * 0.72} viewBox="0 0 24 24">
        <Glyph symbol={symbol} color={tone.fg} />
      </svg>
    </span>
  );
}

export function TokenIcon({ symbol, size = 22, className = "" }: { symbol: TokenSymbol; size?: number; className?: string }) {
  const def = TOKENS[symbol as TokenId];
  const pair = def?.pair ?? (symbol === "LP" ? (["xTOMB", "USDC"] as const) : undefined);
  if (pair) {
    const s = Math.round(size * 0.78);
    return (
      <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: size * 1.35, height: size }} aria-hidden>
        <Single symbol={pair[0]} size={s} className="absolute left-0 top-0 z-10 ring-2 ring-basalt" />
        <Single symbol={pair[1]} size={s} className="absolute bottom-0 right-0" />
      </span>
    );
  }
  return <Single symbol={symbol} size={size} className={className} />;
}

export function TokenTag({ symbol, className = "" }: { symbol: TokenSymbol; className?: string }) {
  const label = TOKENS[symbol as TokenId]?.symbol ?? symbol;
  return (
    <span className={`inline-flex items-center gap-2 font-mono text-[13px] font-medium tracking-wide text-bone ${className}`}>
      <TokenIcon symbol={symbol} size={20} />
      {label}
    </span>
  );
}
