import { useRef, useState } from "react";

import { AnimatedNumber } from "@/components/fx/AnimatedNumber";
import { GENESIS_DAYS, LP_DAY, emissionShare, walletClaim } from "@/lib/genesis";
import { GENESIS_POLICY, PASSES, PASS_ORDER, pct } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { Slider, Stage, useEnter } from "./kit";

/** Who gets Genesis emissions, day by day: two pools, 100% / 0% on Day 1, then 25% / 75%. */
export function EmissionsTimeline() {
  const root = useRef<HTMLDivElement>(null);
  const [day, setDay] = useState(LP_DAY);
  const split = (d: number) => {
    const phase = d === 1 ? "day1" : "lp";
    return [
      { id: "LP pool", share: emissionShare(1, { phase }), color: "#ff6a2b" },
      { id: "Standard pool", share: emissionShare(0, { phase }), color: "#2a8cff" },
    ].filter((x) => x.share > 0);
  };
  useEnter(root, (tl) => {
    tl.from(".et-seg", { scaleY: 0, transformOrigin: "bottom", duration: 0.55, stagger: { each: 0.03, from: "start" }, ease: EASE.settle });
  });
  return (
    <Stage caption={`Day 1 the standard pool gets every emission. From Day ${LP_DAY} the xTOMB/USDC LP pool takes 75% — separate from the 50/50 liquid/vested split of each reward.`}>
      <div ref={root}>
        <div className="flex h-44 items-end gap-2">
          {Array.from({ length: GENESIS_DAYS }, (_, i) => i + 1).map((d) => (
            <button
              key={d}
              type="button"
              onMouseEnter={() => setDay(d)}
              onFocus={() => setDay(d)}
              onClick={() => setDay(d)}
              className={`flex h-full flex-1 flex-col-reverse overflow-hidden rounded-lg border transition-colors ${d === day ? "border-bone/40" : "border-transparent"}`}
              aria-label={`Day ${d}`}
            >
              {split(d).map((x) => (
                <span key={x.id} className="et-seg block w-full" style={{ height: `${x.share * 100}%`, background: x.color, opacity: d === day ? 1 : 0.7 }} />
              ))}
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2 font-mono text-[10px] text-ash">
          {Array.from({ length: GENESIS_DAYS }, (_, i) => (
            <span key={i} className={`flex-1 text-center ${i + 1 === day ? "text-bone" : ""}`}>
              D{i + 1}
            </span>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5">
          {split(day).map((x) => (
            <div key={x.id} className="flex items-center gap-2 text-[12px]">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: x.color }} />
              <span className="text-bone-dim">{x.id}</span>
              <span className="num text-bone">{Math.round(x.share * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    </Stage>
  );
}

/** A reward splits: liquid half (2% fee to Treasury), vested half in 16 claim-gated installments. */
export function HarvestSplitter() {
  const root = useRef<HTMLDivElement>(null);
  const [reward, setReward] = useState(400);
  const c = walletClaim(reward);
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.fromTo(".hs-inst", { scaleY: 0.2, autoAlpha: 0.3 }, { scaleY: 1, autoAlpha: 1, transformOrigin: "bottom", duration: 0.35, stagger: 0.04, ease: EASE.rise });
    },
    { scope: root, dependencies: [reward] },
  );
  return (
    <Stage caption={`A wallet claim: half is liquid (minus ${pct(GENESIS_POLICY.walletFeeBps)} to Treasury), half vests. Each installment opens ${GENESIS_POLICY.installmentSeconds / 3600}h after you claim the previous one, starting ${GENESIS_POLICY.installmentSeconds / 3600}h after Genesis ends.`}>
      <div ref={root}>
        <Slider id="hs-reward" label="Reward claimed" value={reward} min={20} max={2000} step={20} onChange={setReward} display={`${reward} xTOMB`} />
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-ember/[0.08] p-3">
            <div className="label mb-1 text-ember">To wallet</div>
            <AnimatedNumber value={c.toWallet} format={(n) => n.toFixed(2)} className="num text-lg text-bone" />
          </div>
          <div className="rounded-xl bg-warn/[0.08] p-3">
            <div className="label mb-1 text-warn">To Treasury</div>
            <AnimatedNumber value={c.treasury} format={(n) => n.toFixed(2)} className="num text-lg text-bone" />
          </div>
          <div className="rounded-xl bg-amethyst/[0.08] p-3">
            <div className="label mb-1 text-amethyst">Vested</div>
            <AnimatedNumber value={c.vested} format={(n) => n.toFixed(2)} className="num text-lg text-bone" />
          </div>
        </div>
        <div className="mt-4 flex h-16 items-end gap-1">
          {Array.from({ length: GENESIS_POLICY.installments }, (_, i) => (
            <span key={i} className="hs-inst flex-1 rounded-t bg-amethyst/70" style={{ height: `${40 + (i % 4) * 8}%` }} title={`Installment ${i + 1}`} />
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-ash">
          <span>end + 6h</span>
          <span>
            {GENESIS_POLICY.installments} × {(c.vested / GENESIS_POLICY.installments).toFixed(2)}
          </span>
          <span>claim-gated</span>
        </div>
      </div>
    </Stage>
  );
}

/** The three passes as a feature matrix — reads the same on a phone. Same reward weighting for all. */
export function TierMatrix() {
  const root = useRef<HTMLDivElement>(null);
  useEnter(root, (tl) => {
    tl.from(".tm-head", { y: 14, autoAlpha: 0, duration: 0.5, stagger: 0.08, ease: EASE.rise }).from(".tm-mark", { scale: 0, autoAlpha: 0, duration: 0.3, stagger: 0.03, ease: EASE.snap }, "-=0.2");
  });
  const rows: [string, (t: (typeof PASSES)["genesis"]) => boolean][] = [
    ["Stake, claim, compound by hand", () => true],
    ["Same reward weighting", () => true],
    ["Keeper compounding (opt-in)", (t) => t.keeper],
    ["24h early standard staking", (t) => t.earlyStandardStaking],
  ];
  return (
    <Stage caption="Soulbound, one per wallet, paid in USDC to Treasury. No deposit fees, no upgrades.">
      <div ref={root} role="table" aria-label="Genesis passes compared" className="grid grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))] items-center gap-x-2 gap-y-0">
        <div role="row" className="contents">
          <span role="columnheader" className="label self-end pb-2">Pass</span>
          {PASS_ORDER.map((id) => {
            const t = PASSES[id];
            const ultra = id === "ultra";
            return (
              <div key={id} role="columnheader" className={`tm-head rounded-t-xl border-x border-t px-2 pb-2 pt-3 text-center ${ultra ? "border-spectre/30 bg-spectre/[0.05]" : "border-white/[0.06] bg-black/20"}`}>
                <div className="text-[12px] font-semibold text-bone">{t.name}</div>
                <div className={`font-display text-lg font-semibold sm:text-xl ${ultra ? "spectre-text" : "text-bone"}`}>{t.priceUsdc}</div>
                <div className="font-mono text-[9px] text-ash">USDC</div>
              </div>
            );
          })}
        </div>
        {rows.map(([k, f], ri) => (
          <div key={k} role="row" className="contents">
            <span role="rowheader" className="border-t border-white/[0.05] py-2.5 pr-1 text-[11.5px] leading-snug text-bone-dim sm:text-[12.5px]">
              {k}
            </span>
            {PASS_ORDER.map((id) => {
              const on = f(PASSES[id]);
              const ultra = id === "ultra";
              const last = ri === rows.length - 1;
              return (
                <span
                  key={id}
                  role="cell"
                  aria-label={on ? "included" : "not included"}
                  className={`flex h-full items-center justify-center border-x border-t border-t-white/[0.05] py-2.5 ${last ? "rounded-b-xl border-b" : ""} ${ultra ? "border-x-spectre/30 border-b-spectre/30 bg-spectre/[0.05]" : "border-x-white/[0.06] border-b-white/[0.06] bg-black/20"}`}
                >
                  <span className={`tm-mark text-[13px] ${on ? (ultra ? "text-spectre" : "text-ok") : "text-ash-dim"}`}>{on ? "✓" : "–"}</span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </Stage>
  );
}
