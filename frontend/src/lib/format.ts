import { formatUnits } from "viem";

import { PEG } from "@/lib/peg";

/**
 * Format helpers for bigint → display-string conversions used across the UI.
 * Centralised so number formatting stays consistent (commas,
 * trailing-zero suppression, fixed precision).
 */

/**
 * Format a wei-style bigint (18 decimals) as a token amount.
 *
 * @param value      raw bigint or undefined (loading → "—")
 * @param decimals   how many decimals to display (default 2)
 * @param withCommas insert thousands separators (default true)
 */
export function formatToken(
  value: bigint | undefined | null,
  decimals: number = 2,
  withCommas: boolean = true,
): string {
  if (value === undefined || value === null) return "—";
  const raw = formatUnits(value, 18);
  const num = parseFloat(raw);
  if (!isFinite(num)) return "—";
  const fixed = num.toFixed(decimals);
  if (!withCommas) return fixed;
  const [intPart, fracPart] = fixed.split(".");
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart ? `${withSep}.${fracPart}` : withSep;
}

/**
 * Auto-precision formatter: picks decimals based on magnitude so values
 * never display as "0" when they're actually non-zero, and never bloat with
 * trailing zeros for large round numbers.
 *
 *   >= 1000   →  0 decimals  ("11,000")
 *   >= 1      →  2 decimals  ("1.50", "999.99")
 *   >= 0.01   →  4 decimals  ("0.5400", "0.1092")
 *   < 0.01    →  6 decimals  ("0.000123")
 *   == 0      →  "0"
 *   undefined →  "—"
 */
export function formatTokenAuto(value: bigint | undefined | null): string {
  if (value === undefined || value === null) return "—";
  if (value === 0n) return "0";
  const raw = formatUnits(value, 18);
  const num = parseFloat(raw);
  if (!isFinite(num)) return "—";

  let decimals: number;
  if (num >= 1000) decimals = 0;
  else if (num >= 1) decimals = 2;
  else if (num >= 0.01) decimals = 4;
  else decimals = 6;

  const fixed = num.toFixed(decimals);
  const [intPart, fracPart] = fixed.split(".");
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart ? `${withSep}.${fracPart}` : withSep;
}

/** Format a Treasury/hook price (PEG.priceDecimals) as a 4-decimal string. */
export function formatPrice(value: bigint | undefined | null): string {
  if (value === undefined || value === null || value === 0n) return "—";
  const raw = formatUnits(value, PEG.priceDecimals);
  const num = parseFloat(raw);
  if (!isFinite(num)) return "—";
  return num.toFixed(4);
}

/** Format a bigint epoch count as a plain integer string. */
export function formatEpoch(value: bigint | undefined | null): string {
  if (value === undefined || value === null) return "—";
  return value.toString();
}

/** Format a basis-point integer (e.g. 3500) as a percent string ("35.00%"). */
export function formatBps(value: bigint | undefined | null): string {
  if (value === undefined || value === null) return "—";
  const pct = Number(value) / 100;
  return `${pct.toFixed(2)}%`;
}

/** Format a seconds-remaining integer as a compact "Dd · Hh · Mm" string. */
export function formatCountdown(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "Open Now";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d · ${h}h · ${m}m`;
  if (h > 0) return `${h}h · ${m}m`;
  return `${m}m`;
}
