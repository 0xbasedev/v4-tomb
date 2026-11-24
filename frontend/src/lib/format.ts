import { formatUnits } from "viem";

/**
 * Display helpers. Every on-chain amount stays a bigint until it is drawn, and
 * an unknown value is always "—" — never a zero that could be read as live data.
 */

type Amount = bigint | null | undefined;

function group(fixed: string): string {
  const [int, frac] = fixed.split(".");
  const sep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${sep}.${frac}` : sep;
}

/** Token amount with magnitude-aware precision ("11,000", "1.50", "0.5400", "0.000123"). */
export function formatToken(value: Amount, decimals = 18, dp?: number): string {
  if (value === undefined || value === null) return "—";
  if (value === 0n) return "0";
  const num = Number(formatUnits(value, decimals));
  if (!Number.isFinite(num)) return "—";
  const places = dp ?? (num >= 1000 ? 0 : num >= 1 ? 2 : num >= 0.01 ? 4 : 6);
  const fixed = num.toFixed(places);
  // A non-zero amount must never render as "0.00".
  if (Number(fixed) === 0) return `<${(10 ** -places).toFixed(places)}`;
  return group(fixed);
}

/** bigint → number for charts and gauges only (never for transaction amounts). */
export function toNumber(value: Amount, decimals = 18): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(formatUnits(value, decimals));
  return Number.isFinite(n) ? n : null;
}

/** A 1e18-scaled price as a 4-decimal string; 0 means "not observable yet". */
export function formatPrice(value: Amount): string {
  if (value === undefined || value === null || value === 0n) return "—";
  return Number(formatUnits(value, 18)).toFixed(4);
}

/** Basis points as a percent ("12%", "0.3%"). */
export function formatBps(bps: number | bigint | null | undefined): string {
  if (bps === undefined || bps === null) return "—";
  return `${+(Number(bps) / 100).toFixed(2)}%`;
}

export function formatNumber(n: number | null | undefined, dp = 2): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return group(n.toFixed(dp));
}

/** Seconds as "2d 4h", "5h 12m", "3m 09s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

export function formatDate(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const shortAddress = (a: string | null | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
