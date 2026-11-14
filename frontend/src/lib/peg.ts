/**
 * The peg. xTOMB targets $1, quoted in the chain's reference token
 * (USDG on Robinhood Chain; USDC on expansion chains that list it).
 *
 * `priceDecimals` must match how Treasury/Oracle express the TWAP
 * (`tombPriceOne`). Oracle.consult(xTOMB, 1e18) returns a quote-token amount.
 */
import networks from "@config/frontend-networks.json" with { type: "json" };

const primary = (networks.networks as Array<Record<string, any>>).find((n) => n.id === networks.primaryChainId);
const reference = primary?.referenceToken;
// Fail closed: a missing or malformed peg token must not silently become "USDC, 6 decimals".
if (!reference || typeof reference.symbol !== "string" || !Number.isInteger(reference.decimals)
  || reference.decimals < 0 || reference.decimals > 36 || !/^0x[0-9a-fA-F]{40}$/.test(reference.address ?? "")) {
  throw new Error(`frontend-networks.json: primary chain ${networks.primaryChainId} has no valid referenceToken (symbol, decimals, address)`);
}

export const PEG = {
  symbol: reference.symbol as string,
  unit: "$",
  /** Decimals of the quote token itself (USDG/USDC = 6). */
  quoteDecimals: Number(reference.decimals),
  /** Decimals of Treasury price reads (tombPriceOne = 10 ** priceDecimals). */
  priceDecimals: Number(reference.decimals),
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

/** Replace leftover USDC wording with the active chain's peg symbol. */
export function labelPeg(text: string): string {
  return text.replaceAll("USDC", PEG.symbol);
}

export function pegPair(asset: string): string {
  return `${asset}/${PEG.symbol}`;
}
