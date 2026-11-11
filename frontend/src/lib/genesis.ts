import { GENESIS_POLICY as G } from "@/lib/launch";

/**
 * Genesis — schedule, emissions and settlement, mirroring
 * MasonryGenesisSchedule, MasonryGenesisStaking and MasonryGenesisSettlement.
 *
 *   Schedule    seven days from `start`; the LP pool (pool 1) opens at
 *               start + 24h ("Day 2") and closes with Genesis. Ultra may
 *               pre-stake in the standard pool (pool 0) in the 24 hours
 *               before start; rewards begin at start for everyone.
 *   Emissions   linear over the seven days. Day 1: all to the standard pool.
 *               From Day 2: 75% to the LP pool, 25% to the standard pool.
 *   Settlement  every reward splits 50/50 into liquid xTOMB and a vested
 *               tranche (odd unit to the tranche). A wallet claim pays 2% of
 *               the liquid half to the DAO wallet. Tranches release in 16 claim-gated
 *               installments: the first opens at Genesis end + 6h, each next one
 *               6h after the previous is claimed; each release also pays 2%.
 *   Compound    the liquid half (minus a 2% keeper fee when automated) sells
 *               part of itself for USDC — paying the Fire Tax on that sell leg —
 *               and mints xTOMB/USDC vault shares; the 0.5% LP fee (to the DAO wallet) is taken
 *               once from the gross shares. Claims and compounds share one
 *               3-hour clock per source pool.
 */

export type GenesisPhase = "pre" | "day1" | "lp" | "ended";

export interface GenesisClock {
  phase: GenesisPhase;
  start: number;
  lpOpens: number;
  end: number;
  now: number;
  /** 1-based day while running (1…7), 0 before, 8 after. */
  day: number;
  totalDays: number;
  active: boolean;
  lpOpen: boolean;
  /** Ultra-only standard-pool pre-stake window (24h before start). */
  ultraEarly: boolean;
  secondsToStart: number;
  secondsToLp: number;
  secondsToEnd: number;
  secondsSinceEnd: number;
  progress: number;
}

export const GENESIS_DAYS = G.durationSeconds / 86_400;
export const LP_DAY = 1 + G.lpDelaySeconds / 86_400;

export function genesisClock(start: number, now: number): GenesisClock {
  const lpOpens = start + G.lpDelaySeconds;
  const end = start + G.durationSeconds;
  const active = now >= start && now < end;
  const lpOpen = now >= lpOpens && now < end;
  const phase: GenesisPhase = now < start ? "pre" : now < lpOpens ? "day1" : now < end ? "lp" : "ended";
  return {
    phase,
    start,
    lpOpens,
    end,
    now,
    day: now < start ? 0 : now >= end ? GENESIS_DAYS + 1 : Math.floor((now - start) / 86_400) + 1,
    totalDays: GENESIS_DAYS,
    active,
    lpOpen,
    ultraEarly: now < start && start - now <= G.ultraEarlySeconds,
    secondsToStart: Math.max(0, start - now),
    secondsToLp: Math.max(0, lpOpens - now),
    secondsToEnd: Math.max(0, end - now),
    secondsSinceEnd: Math.max(0, now - end),
    progress: Math.min(1, Math.max(0, (now - start) / G.durationSeconds)),
  };
}

/** Share of emissions each pool receives right now. */
export function emissionShare(pool: 0 | 1, c: Pick<GenesisClock, "phase">): number {
  if (c.phase === "pre" || c.phase === "ended") return 0;
  if (c.phase === "day1") return pool === 0 ? 1 : 0;
  return pool === 1 ? G.lpEmissionShare : 1 - G.lpEmissionShare;
}

/** Cumulative emitted to a pool by `now`, for a reward budget (MasonryGenesisStaking._cumulative). */
export function cumulativeEmitted(pool: 0 | 1, budget: number, c: Pick<GenesisClock, "start" | "lpOpens" | "end" | "now">): number {
  if (c.now <= c.start) return 0;
  const elapsed = Math.min(c.now, c.end) - c.start;
  const total = (budget * elapsed) / (c.end - c.start);
  const dayOne = (budget * (c.lpOpens - c.start)) / (c.end - c.start);
  const lp = total > dayOne ? (total - dayOne) * G.lpEmissionShare : 0;
  return pool === 1 ? lp : total - lp;
}

const fee = (amount: number, bps: number) => (amount * bps) / 10_000;

/** A wallet claim of `reward`: 400 → 196 to the claimer, 4 to the DAO wallet, 200 vested. */
export function walletClaim(reward: number) {
  const liquid = reward * G.liquidShare;
  const vested = reward - liquid;
  const treasury = fee(liquid, G.walletFeeBps);
  return { reward, liquid, toWallet: liquid - treasury, treasury, vested };
}

/**
 * A compound of `reward` into the LP pool. `sellShare` is the part of the
 * liquid budget sold for USDC to pair with the rest (≈ half at an in-range
 * price); `taxBps` is the Fire Tax on that sell leg.
 */
export function compoundSplit(reward: number, opts: { automated: boolean; sellShare?: number; taxBps: number }) {
  const liquid = reward * G.liquidShare;
  const vested = reward - liquid;
  const keeperFee = opts.automated ? fee(liquid, G.automationFeeBps) : 0;
  const budget = liquid - keeperFee;
  const sold = budget * (opts.sellShare ?? 0.5);
  const fireTax = fee(sold, opts.taxBps);
  // Value that lands as gross LP shares, before the 0.5% LP fee.
  const gross = budget - fireTax;
  const lpBurn = fee(gross, G.lpBurnFeeBps);
  return { reward, liquid, vested, keeperFee, budget, sold, fireTax, gross, lpBurn, net: gross - lpBurn };
}

export interface Tranche {
  amount: number;
  nextRelease: number;
  releasedInstallments: number;
}

export function trancheView(t: Tranche, now: number) {
  const per = t.amount / G.installments;
  const done = t.releasedInstallments >= G.installments;
  const ready = !done && now >= t.nextRelease;
  return {
    per,
    released: per * t.releasedInstallments,
    remaining: t.amount - per * t.releasedInstallments,
    done,
    ready,
    waitSeconds: done ? 0 : Math.max(0, t.nextRelease - now),
    progress: t.releasedInstallments / G.installments,
    /** What the next release pays the wallet, after the 2% fee. */
    nextNet: per - fee(per, G.walletFeeBps),
  };
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
