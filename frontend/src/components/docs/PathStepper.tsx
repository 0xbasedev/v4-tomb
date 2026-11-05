import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { PendingBadge, PlannedBadge } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { GENESIS_DAYS, LP_DAY } from "@/lib/genesis";
import { EXPANSION, FARM_POLICY, GENESIS_POLICY, PASSES, pct } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import type { TokenId } from "@/lib/tokens";
import { Segmented, Stage } from "./kit";

/**
 * Four ways in, as a stepper. The line fills to the current step and the
 * steps advance on their own (pause on hover); tap any step to jump. Each
 * path ends at the page where you'd do it.
 */

type PathId = "founder" | "farmer" | "member" | "bondholder";
type PathStatus = "live" | "pending" | "planned";

const H = (s: number) => `${s / 3600}h`;

const PATHS: Record<PathId, { title: string; who: string; icon: TokenId; to: string; cta: string; status: PathStatus; steps: string[] }> = {
  founder: {
    title: "Founder",
    who: `In during the ${GENESIS_DAYS}-day Genesis`,
    icon: "xTOMB",
    to: "/genesis",
    cta: "Open Genesis",
    status: "live",
    steps: [
      `Buy one soulbound pass in USDC: Genesis ${PASSES.genesis.priceUsdc}, Pro ${PASSES.pro.priceUsdc} or Ultra ${PASSES.ultra.priceUsdc}. Same reward weighting for all.`,
      "Day 1: stake in the standard pool, which takes every emission. Ultra can stake 24h before start.",
      `Day ${LP_DAY}: add xTOMB/USDC liquidity and stake it. The LP pool takes 75% of emissions from here.`,
      `Claim or compound every ${H(GENESIS_POLICY.compoundCooldownSeconds)}. Half of each reward is liquid, half vests.`,
      `After Genesis: release the ${GENESIS_POLICY.installments} vested installments, one every ${H(GENESIS_POLICY.installmentSeconds)} after each claim.`,
    ],
  },
  farmer: {
    title: "Farmer",
    who: "Wants xSHARE emissions",
    icon: "xTOMB-USDC",
    to: "/farm",
    cta: "Open the Farm",
    status: "pending",
    steps: [
      "Add xTOMB/USDC or xSHARE/USDC liquidity",
      `Stake the LP to earn xSHARE over ${FARM_POLICY.emissionDays} days`,
      `Compound at most every ${H(FARM_POLICY.compoundCooldownSeconds)}`,
      "Farm contracts aren't in the merge branch yet — this page shows the plan only",
    ],
  },
  member: {
    title: "Member",
    who: "Wants a cut of expansion",
    icon: "xSHARE-USDC",
    to: "/masonry",
    cta: "Open the Masonry",
    status: "pending",
    steps: [
      "Pair xSHARE with USDC and stake the LP in the Masonry (planned stake asset)",
      `When a fresh TWAP sits above $${EXPANSION.gate.toFixed(2)}, an epoch may mint up to ${pct(EXPANSION.maxPerEpochBps)} of circulating xTOMB`,
      "Expansion xTOMB is shared across stakers",
      "Staking, locks and the expansion mint aren't bound in the contracts yet",
    ],
  },
  bondholder: {
    title: "Bondholder",
    who: "Believes the peg recovers",
    icon: "xBOND",
    to: "/bonds",
    cta: "Open Bonds",
    status: "planned",
    steps: ["xBOND is a planned preview", "Issuance and redemption are disabled", "No rates, caps or returns are set", "Once live, the page shows the contract's quote and why an action is blocked"],
  },
};

export function PathStepper() {
  const [path, setPath] = useState<PathId>("founder");
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const p = PATHS[path];

  useEffect(() => setStep(0), [path]);
  useEffect(() => {
    if (paused || prefersReducedMotion()) return;
    const id = window.setInterval(() => setStep((s) => (s + 1) % p.steps.length), 2600);
    return () => window.clearInterval(id);
  }, [paused, p.steps.length]);

  useGSAP(
    () => {
      if (!fill.current) return;
      const h = `${(step / Math.max(1, p.steps.length - 1)) * 100}%`;
      if (prefersReducedMotion()) gsap.set(fill.current, { height: h });
      else gsap.to(fill.current, { height: h, duration: 0.6, ease: EASE.settle });
      gsap.fromTo(`.ps-step-${step}`, { x: -6 }, { x: 0, duration: 0.4, ease: EASE.rise });
    },
    { scope: root, dependencies: [step, path] },
  );

  return (
    <Stage>
      <div ref={root} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
        <Segmented options={(Object.keys(PATHS) as PathId[]).map((id) => ({ id, label: PATHS[id].title }))} value={path} onChange={setPath} />
        <div className="mt-4 flex items-center gap-3">
          <TokenIcon symbol={p.icon} size={34} />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-semibold text-bone">The {p.title}</span>
              {p.status === "pending" && <PendingBadge />}
              {p.status === "planned" && <PlannedBadge />}
            </div>
            <div className="text-[12px] text-ash">{p.who}</div>
          </div>
        </div>
        <ol className="relative mt-4 space-y-1 pl-9">
          <div className="absolute bottom-4 left-[13px] top-4 w-0.5 rounded bg-white/[0.07]">
            <div ref={fill} className="w-full rounded bg-gradient-to-b from-ember to-ember-hot" style={{ height: 0 }} />
          </div>
          {p.steps.map((s, i) => {
            const done = i < step;
            const now = i === step;
            return (
              <li key={s} className={`ps-step-${i} relative`}>
                <button type="button" onClick={() => setStep(i)} className="w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]">
                  <span
                    className={`absolute -left-9 top-2 flex h-7 w-7 items-center justify-center rounded-full border font-mono text-[11px] transition-colors ${
                      now ? "border-ember bg-ember text-void shadow-ember" : done ? "border-ember/60 bg-basalt-3 text-ember-hot" : "border-white/10 bg-basalt-2 text-ash"
                    }`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span className={`text-[13.5px] leading-snug ${now ? "text-bone" : "text-bone-dim"}`}>{s}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-3 flex items-center justify-between">
          <span className="font-mono text-[10px] text-ash">{paused ? "paused" : "auto-advancing · hover to pause"}</span>
          <Link to={p.to} className="btn btn-primary h-10 px-4 text-[13px]">
            {p.cta} →
          </Link>
        </div>
      </div>
    </Stage>
  );
}
