/**
 * Token glyphs. Each token has a shape AND a colour, so they stay
 * distinguishable in greyscale and at 16px:
 *   xTOMB  — pyramid, violet        (the peg)
 *   xSHARE — faceted shard, blue    (the share)
 *   xROOM  — arch, lilac            (the staking room)
 *   QUOTE  — diamond, neutral       (the paired asset, whatever it is on this chain)
 * LP wrappers render as their two halves, overlapped.
 */

export type TokenSymbol = "xTOMB" | "xSHARE" | "xROOM" | "QUOTE" | "PEG-LP" | "SHARE-LP" | "PAIR-LP";

const TONES: Record<string, { fg: string; bg: string; ring: string }> = {
  xTOMB: { fg: "rgb(var(--iris-soft-rgb))", bg: "rgb(var(--iris-rgb) / 0.14)", ring: "rgb(var(--iris-rgb) / 0.5)" },
  xSHARE: { fg: "rgb(var(--spectre-rgb))", bg: "rgb(var(--blue-rgb) / 0.14)", ring: "rgb(var(--spectre-rgb) / 0.45)" },
  xROOM: { fg: "rgb(var(--amethyst-rgb))", bg: "rgb(var(--amethyst-rgb) / 0.12)", ring: "rgb(var(--amethyst-rgb) / 0.45)" },
  QUOTE: { fg: "rgb(var(--bone-dim-rgb))", bg: "rgb(var(--bone-dim-rgb) / 0.08)", ring: "rgb(var(--bone-dim-rgb) / 0.3)" },
};

const PAIRS: Partial<Record<TokenSymbol, [string, string]>> = {
  "PEG-LP": ["xTOMB", "QUOTE"],
  "SHARE-LP": ["xSHARE", "QUOTE"],
  "PAIR-LP": ["xTOMB", "xSHARE"],
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
    case "xROOM":
      return (
        <>
          <path d="M6 19.5V11a6 6 0 0 1 12 0v8.5" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
          <path d="M4.5 19.5h15M12 13v6.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    default:
      return <path d="M12 3.5 18.5 12 12 20.5 5.5 12Z" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />;
  }
}

function Single({ symbol, size, className = "" }: { symbol: string; size: number; className?: string }) {
  const tone = TONES[symbol] ?? TONES.QUOTE;
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
  const pair = PAIRS[symbol];
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
