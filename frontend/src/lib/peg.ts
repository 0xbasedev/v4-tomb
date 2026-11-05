/**
 * The peg. xTOMB targets $1, quoted in USDC.
 *
 * `priceDecimals` must match how Treasury/Oracle express the TWAP
 * (`tombPriceOne`). Oracle.consult(xTOMB, 1e18) returns a USDC amount, so the
 * USDC-pegged port should use 6 — set it here once and every price read,
 * format and preview value follows.
 */
export const PEG = {
  symbol: "USDC",
  unit: "$",
  /** Decimals of the quote token itself (USDC = 6). */
  quoteDecimals: 6,
  /** Decimals of Treasury price reads (tombPriceOne = 10 ** priceDecimals). */
  priceDecimals: 6,
} as const;

/** bigint price read → float USD (display + heat only, never tx math). */
export function priceToFloat(v: bigint | undefined | null): number {
  if (v === undefined || v === null) return 0;
  return Number(v) / 10 ** PEG.priceDecimals;
}

export function usd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function usdCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}k`;
  return usd(n, n < 10 ? 2 : 0);
}
