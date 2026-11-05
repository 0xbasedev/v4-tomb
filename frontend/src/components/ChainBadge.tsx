import { useState } from "react";

/**
 * Chain badge. The chain's own icon loads from the public DefiLlama icon CDN
 * at runtime (nothing is redrawn or bundled here); where it can't load —
 * offline, a sandboxed demo — an original monogram badge stands in.
 */
const SLUG: Record<number, string> = {
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  130: "unichain",
  137: "polygon",
  43114: "avalanche",
  480: "world chain",
  57073: "ink",
  196: "xlayer",
  42220: "celo",
  143: "monad",
  999: "hyperliquid",
  1: "ethereum",
  // xSHARE bridge networks (Hyperlane)
  4663: "robinhood",
  56: "binance",
  369: "pulse",
  146: "sonic",
};

const HUES = [18, 200, 280, 330, 160, 45, 230, 0, 120, 260, 300, 190, 60];

export function ChainBadge({ id, name, size = 40, lit = true }: { id: number; name: string; size?: number; lit?: boolean }) {
  const [failed, setFailed] = useState(false);
  const slug = SLUG[id];
  const hue = HUES[Math.abs(id) % HUES.length];
  const initials = name
    .replace(/(One|Mainnet|PoS|C-Chain)$/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full transition-[filter,opacity] duration-500 ${lit ? "" : "opacity-40 grayscale"}`}
      style={{ width: size, height: size, background: `hsla(${hue},70%,55%,0.14)`, boxShadow: `inset 0 0 0 1px hsla(${hue},80%,65%,0.45)` }}
      title={name}
    >
      {slug && !failed ? (
        <img
          src={`https://icons.llamao.fi/icons/chains/rsz_${slug}.jpg`}
          alt={name}
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="font-display font-semibold" style={{ fontSize: size * 0.34, color: `hsl(${hue},85%,72%)` }} aria-label={name}>
          {initials}
        </span>
      )}
    </span>
  );
}
