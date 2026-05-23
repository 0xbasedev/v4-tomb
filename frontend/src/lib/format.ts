import { formatUnits } from "viem";

/**
 * Format helpers for bigint → display-string conversions used across the UI.
 * Centralised so the Art Deco formatting voice stays consistent (commas,
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

/** Format a 1e18-scaled price as a 4-decimal price string. */
export function formatPrice(value: bigint | undefined | null): string {
  if (value === undefined || value === null || value === 0n) return "—";
  const raw = formatUnits(value, 18);
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

/** Format a seconds-remaining integer as a compact Art Deco "Dd · Hh · Mm" string. */
export function formatCountdown(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "Open Now";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d · ${h}h · ${m}m`;
  if (h > 0) return `${h}h · ${m}m`;
  return `${m}m`;
}
