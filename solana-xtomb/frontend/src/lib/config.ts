// Single source of truth: ~/workspace/solana-xtomb/config/xtomb.config.json
// (copied into src/lib at scaffold time — keep in sync; never hard-code economics here).
import cfg from "./xtomb.config.json";

export const config = cfg as typeof cfg;
export const PROGRAM_ID =
  process.env.NEXT_PUBLIC_XTOMB_PROGRAM_ID ||
  cfg.meta.program_id_devnet;
export const NETWORK =
  process.env.NEXT_PUBLIC_SOLANA_NETWORK || "devnet";

// No program is deployed yet: every on-chain number in the UI is Simulated.
export const DEPLOYED = false;
export const SIM_NOTE = "Simulated — no program deployed yet";

export const TOKENS = [
  { symbol: "xTOMB", name: "xTOMB peg asset", color: "#ff6a2b" },
  { symbol: "xSHARE", name: "xSHARE capped share", color: "#b48cff" },
  { symbol: "xBOND", name: "xBOND discount bond", color: "#ffc24b" },
  { symbol: "USDC", name: "USD Coin", color: "#3ee7ff" },
  { symbol: "SOL", name: "Solana", color: "#34e3a0" },
  { symbol: "JLP", name: "Jupiter LP", color: "#ff4d6a" },
  { symbol: "WETH", name: "Wrapped ETH (Wormhole)", color: "#9ca3af" },
  { symbol: "WBTC", name: "Wrapped BTC (Wormhole)", color: "#ffb547" },
  { symbol: "xTOMB·USDC LP", name: "xTOMB/USDC LP", color: "#ff6a2b" },
  { symbol: "xSHARE·USDC LP", name: "xSHARE/USDC LP", color: "#b48cff" },
] as const;
export type TokenSymbol = (typeof TOKENS)[number]["symbol"];

/**
 * Withdrawal Fire Tax — mirrors the on-chain model (2026-11-08):
 * per-token baseline (xTOMB 3%, xSHARE 6%) plus ONE shared quadratic
 * increment (+11 pts at 85% of peg), clamped at the 12% cap. xSHARE
 * caps sooner (~$0.89) only because its baseline is higher.
 */
export function fireTaxPercent(twap: number, isXshare = false): number {
  const ref = cfg.tokens.xTOMB.peg_reference_usdc;
  const ft = cfg.withdrawal_fire_tax;
  const base = isXshare ? ft.baseline_percent_xshare : ft.baseline_percent_xtomb;
  if (twap >= ref) return base;
  const floor = 0.85 * ref;
  if (twap <= floor) return ft.max_percent;
  const t = (ref - twap) / (ref - floor); // 0 at peg -> 1 at floor
  const pct = Math.min(base + 11 * t * t, ft.max_percent);
  return Math.round(pct * 100) / 100;
}
