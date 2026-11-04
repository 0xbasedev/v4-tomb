import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";

import { sellTax, type TaxedAsset } from "@/lib/fireTax";
import { compoundSplit, cumulativeEmitted, genesisClock, walletClaim, type Tranche } from "@/lib/genesis";
import { DEPLOYMENTS, GENESIS_POLICY, PASSES, type PassTier } from "@/lib/launch";
import { stepDefense } from "@/lib/market";
import type { TokenId } from "@/lib/tokens";

/**
 * Preview — a simulated chain for review and demos, on whenever no verified
 * deployment exists (config/masonry-deployments.json is empty today), or with
 * `?preview=1`. Every value it produces is SAMPLE data and every screen says
 * so. It never asks a wallet to sign or send anything: actions mutate this
 * in-memory state and post a "Simulated" toast.
 *
 * URL controls (also on the dock):
 *   ?genesis=pre|early|day1|day2|ended   or   ?t=<seconds since Genesis start>
 *   ?price=0.96         xTOMB TWAP          ?oracle=stale     no valid TWAP
 *   ?defense=1          Critical Defense    ?pass=genesis|pro|ultra|none
 *   ?wallet=0           sample wallet off   ?owner=0          view as a non-owner
 */

export const PREVIEW_ADDRESS = "0x7a11ce00000000000000000000000000000c0ffe" as Address;
/** The keeper address Pro/Ultra opt into in Preview (sample). */
export const PREVIEW_KEEPER = "0x000000000000000000000000000000000000c0de" as Address;

const q = () => (typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search));

export const GENESIS_MOMENTS = {
  pre: -2 * 86_400,
  early: -6 * 3_600,
  day1: 6 * 3_600,
  day2: 3.5 * 86_400,
  ended: 7 * 86_400 + 8 * 3_600,
} as const;
export type GenesisMoment = keyof typeof GENESIS_MOMENTS;

function initialOffset(): number {
  const p = q();
  const t = Number(p.get("t"));
  if (p.get("t") !== null && Number.isFinite(t)) return t;
  const g = p.get("genesis");
  if (g === "lp-open") return GENESIS_MOMENTS.day2;
  if (g && g in GENESIS_MOMENTS) return GENESIS_MOMENTS[g as GenesisMoment];
  return GENESIS_MOMENTS.day2;
}

function initialPass(): PassTier | null {
  const t = q().get("pass") ?? q().get("tier");
  if (t === "none") return null;
  if (t === "genesis" || t === "entry") return "genesis";
  if (t === "pro" || t === "ultra") return t;
  return "pro";
}

function initialEnabled(): boolean {
  const p = q().get("preview");
  if (p === "0") return false;
  if (p === "1") return true;
  if (import.meta.env.VITE_PREVIEW === "1") return true;
  return DEPLOYMENTS.length === 0;
}

/** Sample market depth for the projected post-sale price (constant product). */
export const SIM_POOLS: Record<TaxedAsset, { asset: number; usdc: number; feeBps: number }> = {
  xTOMB: { asset: 1_200_000, usdc: 1_200_000, feeBps: 30 },
  xSHARE: { asset: 4_500, usdc: 540_000, feeBps: 30 },
};
export const SIM_SQUARE_REFERENCE = 120;
const SIM_BUDGET = 1_050_000;
const SIM_TOTALS = { 0: 2_400_000, 1: 480_000 } as const;

export interface SimPosition {
  shares: number;
  /** Emissions already settled into `pending` up to this cumulative mark. */
  paidMark: number;
  /** Settled-but-unclaimed (positions.pending). */
  stored: number;
}

export interface SimTx {
  id: number;
  label: string;
  at: number;
}

export interface PreviewState {
  enabled: boolean;
  now: number;
  start: number;
  offset: number;
  setOffset: (s: number) => void;
  twap: number;
  setTwap: (n: number) => void;
  oracleFresh: boolean;
  setOracleFresh: (b: boolean) => void;
  defense: { active: boolean; checkpoints: number };
  setDefense: (d: { active: boolean; checkpoints: number }) => void;
  /** Advance one six-hour checkpoint at the current TWAP (defense state machine). */
  checkpoint: () => void;
  squareRatio: number;
  setSquareRatio: (n: number) => void;
  raised: Record<TaxedAsset, { bps: number; at: number }>;
  sampleWallet: boolean;
  setSampleWallet: (b: boolean) => void;
  pass: PassTier | null;
  setPass: (t: PassTier | null) => void;
  owner: boolean;
  setOwner: (b: boolean) => void;
  balances: Record<TokenId, number>;
  positions: Record<0 | 1, SimPosition>;
  pending: Record<0 | 1, number>;
  nextCompoundAt: Record<0 | 1, number>;
  keeper: { executor: Address | null; minNetShares: number };
  tranches: Tranche[];
  log: SimTx[];
  act: {
    purchase: (t: PassTier) => void;
    deposit: (pool: 0 | 1, amount: number) => void;
    withdraw: (pool: 0 | 1, amount: number) => void;
    claim: (pool: 0 | 1) => void;
    compound: (pool: 0 | 1, automated: boolean) => void;
    setKeeper: (executor: Address | null, minNetShares: number) => void;
    release: (index: number) => void;
    swap: (input: TokenId, output: TokenId, amountIn: number, amountOut: number, sold?: { asset: TaxedAsset; valueUsd: number; rateBps: number }) => void;
    addLiquidity: (lp: "xTOMB-USDC" | "xSHARE-USDC", assetAmount: number, usdcAmount: number, shares: number) => void;
    redeem: (lp: "xTOMB-USDC" | "xSHARE-USDC", shares: number) => void;
    note: (label: string) => void;
  };
}

const PreviewContext = createContext<PreviewState | null>(null);

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [enabled] = useState(initialEnabled);
  const mountedAt = useRef(Math.floor(Date.now() / 1000));
  const [now, setNow] = useState(mountedAt.current);
  const [offset, setOffsetState] = useState(initialOffset);
  // Genesis start is anchored so that `now - start === offset` at the moment it's set.
  const [start, setStart] = useState(() => mountedAt.current - initialOffset());
  const [twap, setTwap] = useState(() => {
    const p = Number(q().get("price"));
    return Number.isFinite(p) && p > 0 ? p : 1.0;
  });
  const [oracleFresh, setOracleFresh] = useState(() => q().get("oracle") !== "stale");
  const [defense, setDefense] = useState(() => ({ active: q().get("defense") === "1" || twap <= 0.9, checkpoints: 0 }));
  const [squareRatio, setSquareRatio] = useState(1);
  const [sampleWallet, setSampleWallet] = useState(() => q().get("wallet") !== "0");
  const [pass, setPass] = useState<PassTier | null>(initialPass);
  const [owner, setOwner] = useState(() => q().get("owner") !== "0");
  const [balances, setBalances] = useState<Record<TokenId, number>>({
    xTOMB: 812.4,
    xSHARE: 3.6,
    USDC: 4_250,
    "xTOMB-USDC": 44.2,
    "xSHARE-USDC": 1.8,
    ETH: 1.42,
    xBOND: 0,
  });
  const [raised, setRaised] = useState<Record<TaxedAsset, { bps: number; at: number }>>({
    xTOMB: { bps: 100, at: 0 },
    xSHARE: { bps: 100, at: 0 },
  });
  const [positions, setPositions] = useState<Record<0 | 1, SimPosition>>({
    0: { shares: 1_200, paidMark: 0, stored: 0 },
    1: { shares: 120, paidMark: 0, stored: 0 },
  });
  const [lastSettle, setLastSettle] = useState<Record<0 | 1, number>>({ 0: 0, 1: 0 });
  const [keeper, setKeeperState] = useState<{ executor: Address | null; minNetShares: number }>({ executor: null, minNetShares: 0 });
  const [tranches, setTranches] = useState<Tranche[]>([]);
  const [log, setLog] = useState<SimTx[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);

  const clock = genesisClock(start, now);
  const end = clock.end;

  // Sample positions only accrue once Genesis starts; the LP position only from Day 2.
  const marks = useMemo(
    () => ({ 0: cumulativeEmitted(0, SIM_BUDGET, clock), 1: cumulativeEmitted(1, SIM_BUDGET, clock) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [start, now],
  );
  const pending = useMemo(() => {
    const out = { 0: 0, 1: 0 } as Record<0 | 1, number>;
    for (const p of [0, 1] as const) {
      const pos = positions[p];
      const share = pos.shares / SIM_TOTALS[p];
      out[p] = pos.stored + Math.max(0, marks[p] - pos.paidMark) * share;
    }
    return out;
  }, [marks, positions]);

  const push = useCallback((label: string) => {
    setLog((l) => [{ id: ++seq.current, label, at: Math.floor(Date.now() / 1000) }, ...l].slice(0, 12));
  }, []);

  const setOffset = useCallback((s: number) => {
    const t = Math.floor(Date.now() / 1000);
    setNow(t);
    setStart(t - s);
    setOffsetState(s);
    setLastSettle({ 0: 0, 1: 0 });
    setPositions((p) => ({ 0: { ...p[0], paidMark: 0, stored: 0 }, 1: { ...p[1], paidMark: 0, stored: 0 } }));
    // Seed vested tranches once Genesis is over so the release flow can be reviewed.
    setTranches(
      s >= GENESIS_POLICY.durationSeconds
        ? [
            { amount: 200, nextRelease: t - s + GENESIS_POLICY.durationSeconds + GENESIS_POLICY.installmentSeconds, releasedInstallments: 0 },
            { amount: 86.4, nextRelease: t - s + GENESIS_POLICY.durationSeconds + GENESIS_POLICY.installmentSeconds, releasedInstallments: 0 },
          ]
        : [],
    );
  }, []);

  // Seed tranches for the initial moment too.
  useEffect(() => {
    setOffset(offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settle = useCallback(
    (pool: 0 | 1) => {
      const reward = pending[pool];
      setPositions((p) => ({ ...p, [pool]: { ...p[pool], paidMark: marks[pool], stored: 0 } }));
      setLastSettle((l) => ({ ...l, [pool]: now }));
      return reward;
    },
    [pending, marks, now],
  );

  const raise = useCallback((asset: TaxedAsset, rateBps: number) => {
    setRaised((r) => {
      const cur = r[asset];
      const t = Math.floor(Date.now() / 1000);
      if (rateBps > cur.bps || (t - cur.at >= 25_200 && rateBps > 100)) return { ...r, [asset]: { bps: rateBps, at: t } };
      return r;
    });
  }, []);

  const act: PreviewState["act"] = {
    purchase: (t) => {
      setPass(t);
      setBalances((b) => ({ ...b, USDC: b.USDC - PASSES[t].priceUsdc }));
      push(`Buy ${PASSES[t].name} pass · ${PASSES[t].priceUsdc} USDC`);
    },
    deposit: (pool, amount) => {
      const net = pool === 1 ? amount * (1 - GENESIS_POLICY.lpBurnFeeBps / 10_000) : amount;
      setPositions((p) => {
        const pos = p[pool];
        const share = pos.shares / SIM_TOTALS[pool];
        const stored = pos.stored + Math.max(0, marks[pool] - pos.paidMark) * share;
        return { ...p, [pool]: { shares: pos.shares + net, paidMark: marks[pool], stored } };
      });
      setBalances((b) => ({ ...b, [pool === 0 ? "USDC" : "xTOMB-USDC"]: b[pool === 0 ? "USDC" : "xTOMB-USDC"] - amount }));
      push(pool === 0 ? `Stake ${amount.toLocaleString()} USDC` : `Stake ${amount.toFixed(4)} LP · ${(amount - net).toFixed(4)} LP burn fee`);
    },
    withdraw: (pool, amount) => {
      setPositions((p) => {
        const pos = p[pool];
        const share = pos.shares / SIM_TOTALS[pool];
        const stored = pos.stored + Math.max(0, marks[pool] - pos.paidMark) * share;
        return { ...p, [pool]: { shares: Math.max(0, pos.shares - amount), paidMark: marks[pool], stored } };
      });
      setBalances((b) => ({ ...b, [pool === 0 ? "USDC" : "xTOMB-USDC"]: b[pool === 0 ? "USDC" : "xTOMB-USDC"] + amount }));
      push(`Withdraw ${amount.toLocaleString()} from pool ${pool}`);
    },
    claim: (pool) => {
      const reward = settle(pool);
      const c = walletClaim(reward);
      setBalances((b) => ({ ...b, xTOMB: b.xTOMB + c.toWallet }));
      setTranches((t) => [...t, { amount: c.vested, nextRelease: end + GENESIS_POLICY.installmentSeconds, releasedInstallments: 0 }]);
      push(`Claim ${reward.toFixed(2)} xTOMB · ${c.toWallet.toFixed(2)} to wallet · ${c.vested.toFixed(2)} vested`);
    },
    compound: (pool, automated) => {
      const reward = settle(pool);
      const tax = sellTax({ asset: "xTOMB", twap: oracleFresh ? twap : null, projected: twap, raisedBps: raised.xTOMB.bps, raisedAt: raised.xTOMB.at, now, genesisActive: clock.active });
      const s = compoundSplit(reward, { automated, taxBps: tax.rateBps ?? 0 });
      const lpPrice = 2 * twap;
      const shares = (s.net * twap) / lpPrice;
      setPositions((p) => {
        const pos = p[1];
        const share = pos.shares / SIM_TOTALS[1];
        const stored = pos.stored + Math.max(0, marks[1] - pos.paidMark) * share;
        return { ...p, 1: { shares: pos.shares + shares, paidMark: marks[1], stored: pool === 1 ? 0 : stored } };
      });
      setTranches((t) => [...t, { amount: s.vested, nextRelease: end + GENESIS_POLICY.installmentSeconds, releasedInstallments: 0 }]);
      if (tax.rateBps) raise("xTOMB", tax.rateBps);
      push(`${automated ? "Keeper compound" : "Compound"} ${reward.toFixed(2)} xTOMB → ${shares.toFixed(4)} LP (net)`);
    },
    setKeeper: (executor, minNetShares) => {
      setKeeperState({ executor, minNetShares });
      push(executor ? `Opt in to keeper compounding · min ${minNetShares} LP` : "Opt out of keeper compounding");
    },
    release: (index) => {
      const t = tranches[index];
      if (!t) return;
      const per = t.amount / GENESIS_POLICY.installments;
      const net = per * (1 - GENESIS_POLICY.walletFeeBps / 10_000);
      const at = Math.floor(Date.now() / 1000);
      setBalances((b) => ({ ...b, xTOMB: b.xTOMB + net }));
      setTranches((list) => list.map((x, i) => (i === index ? { ...x, releasedInstallments: x.releasedInstallments + 1, nextRelease: at + GENESIS_POLICY.installmentSeconds } : x)));
      push(`Release installment ${t.releasedInstallments + 1}/16 from tranche #${index + 1} · ${net.toFixed(2)} xTOMB`);
    },
    swap: (input, output, amountIn, amountOut, sold) => {
      setBalances((b) => ({ ...b, [input]: b[input] - amountIn, [output]: b[output] + amountOut }));
      if (sold) raise(sold.asset, sold.rateBps);
      push(`Swap ${amountIn} ${input} → ${amountOut.toFixed(4)} ${output}`);
    },
    addLiquidity: (lp, assetAmount, usdcAmount, shares) => {
      const asset = lp === "xTOMB-USDC" ? "xTOMB" : "xSHARE";
      setBalances((b) => ({ ...b, [asset]: b[asset] - assetAmount, USDC: b.USDC - usdcAmount, [lp]: b[lp] + shares }));
      push(`Add liquidity · ${shares.toFixed(4)} ${lp} shares`);
    },
    redeem: (lp, shares) => {
      const prices = simPrices({ twap, squareRatio });
      const asset = lp === "xTOMB-USDC" ? "xTOMB" : "xSHARE";
      const half = (shares * prices[lp]) / 2;
      setBalances((b) => ({ ...b, [lp]: b[lp] - shares, [asset]: b[asset] + half / prices[asset], USDC: b.USDC + half }));
      push(`Redeem ${shares} ${lp} shares for ${asset} + USDC`);
    },
    note: (label) => push(label),
  };

  const value: PreviewState = {
    enabled,
    now,
    start,
    offset: now - start,
    setOffset,
    twap,
    setTwap: (n) => {
      setTwap(n);
      setDefense((d) => (n <= 0.9 && oracleFresh ? { active: true, checkpoints: 0 } : d));
    },
    oracleFresh,
    setOracleFresh,
    defense,
    setDefense,
    checkpoint: () => setDefense((d) => stepDefense(d, twap, oracleFresh)),
    squareRatio,
    setSquareRatio,
    raised,
    sampleWallet,
    setSampleWallet,
    pass,
    setPass,
    owner,
    setOwner,
    balances,
    positions,
    pending,
    nextCompoundAt: { 0: lastSettle[0] ? lastSettle[0] + GENESIS_POLICY.compoundCooldownSeconds : 0, 1: lastSettle[1] ? lastSettle[1] + GENESIS_POLICY.compoundCooldownSeconds : 0 },
    keeper,
    tranches,
    log,
    act,
  };
  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

export function usePreview(): PreviewState {
  const ctx = useContext(PreviewContext);
  if (!ctx) throw new Error("usePreview outside PreviewProvider");
  return ctx;
}

/** Simulated prices — every one of them is sample data. */
export function simPrices(p: Pick<PreviewState, "twap" | "squareRatio">): Record<TokenId, number> {
  const xshare = SIM_SQUARE_REFERENCE * p.squareRatio;
  return {
    xTOMB: p.twap,
    xSHARE: xshare,
    USDC: 1,
    // Vault shares, in range near the centre: ~1 asset-dollar + 1 USDC each.
    "xTOMB-USDC": 2 * p.twap,
    "xSHARE-USDC": 2 * Math.sqrt(xshare) * 1,
    ETH: 3_480,
    xBOND: 0,
  };
}

// ---------------------------------------------------------------------------
// Simulated writes — the same toast choreography as a real transaction.
// ---------------------------------------------------------------------------

interface ToastApi {
  push: (t: { variant: "pending" | "success" | "error" | "info"; title: string; message?: string; durationMs?: number }) => string;
  update: (id: string, patch: { variant?: "pending" | "success" | "error" | "info"; title?: string; message?: string }) => void;
}

export function simulateTx(toast: ToastApi, label: string, onDone?: () => void) {
  const id = toast.push({ variant: "pending", title: label, message: "Simulated · no wallet request" });
  window.setTimeout(() => {
    toast.update(id, { variant: "success", title: `${label} · Simulated`, message: "Preview mode — no transaction was requested or sent." });
    onDone?.();
  }, 900);
}
