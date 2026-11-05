import { useState } from "react";

import { fmtDuration, genesisClock } from "@/lib/genesis";
import { GENESIS_POLICY, PASSES, PASS_ORDER, type PassTier } from "@/lib/launch";
import { PHASE_META, marketPhase } from "@/lib/market";
import { GENESIS_MOMENTS, usePreview, type GenesisMoment } from "@/lib/preview";

/**
 * PreviewDock — the simulator's controls. Everything here changes sample data
 * only; nothing reaches a wallet. Boundary buttons put the clock one second
 * either side of Day 2 and of Genesis end so the transitions can be checked.
 */

const PRICES: { label: string; price: number }[] = [
  { label: "Defense", price: 0.88 },
  { label: "Below", price: 0.95 },
  { label: "Peg", price: 1.0 },
  { label: "Above gate", price: 1.03 },
];

const MOMENTS: { id: GenesisMoment; label: string }[] = [
  { id: "pre", label: "Before" },
  { id: "early", label: "Ultra early" },
  { id: "day1", label: "Day 1" },
  { id: "day2", label: "Day 2+" },
  { id: "ended", label: "Ended" },
];

export function PreviewDock() {
  const p = usePreview();
  const [open, setOpen] = useState(false);
  if (!p.enabled) return null;
  const c = genesisClock(p.start, p.now);
  const phase = marketPhase({ twap: p.twap, fresh: p.oracleFresh, defenseActive: p.defense.active });
  const lp = GENESIS_POLICY.lpDelaySeconds;
  const end = GENESIS_POLICY.durationSeconds;

  return (
    <div className="fixed bottom-24 left-4 z-[55] md:bottom-6 md:left-6">
      {open ? (
        <div className="max-h-[70vh] w-[310px] overflow-y-auto rounded-2xl border border-white/10 bg-basalt-2/95 p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl">
          <div className="mb-3 flex items-center justify-between">
            <span className="chip chip-warn h-6">Preview · sample data</span>
            <button type="button" onClick={() => setOpen(false)} className="text-lg leading-none text-ash hover:text-bone" aria-label="Close preview controls">
              ×
            </button>
          </div>

          <div className="label mb-1">Genesis clock</div>
          <div className="mb-2 font-mono text-[11px] text-bone-dim">
            {!p.scheduled ? "not scheduled · start = 0" : c.phase === "pre" ? `starts in ${fmtDuration(c.secondsToStart)}${c.ultraEarly ? " · Ultra early window" : ""}` : c.phase === "ended" ? `ended ${fmtDuration(c.secondsSinceEnd)} ago` : `Day ${c.day} · ${c.lpOpen ? "LP open" : `LP in ${fmtDuration(c.secondsToLp)}`}`}
          </div>
          <button
            type="button"
            onClick={p.unschedule}
            aria-pressed={!p.scheduled}
            className={`mb-1 w-full rounded-lg border px-1 py-1.5 text-[10.5px] ${!p.scheduled ? "border-warn/60 text-warn" : "border-white/[0.08] text-ash hover:text-bone"}`}
          >
            Deployed · start unset (schedule from Admin)
          </button>
          <div className="mb-2 grid grid-cols-5 gap-1">
            {MOMENTS.map((m) => (
              <button key={m.id} type="button" onClick={() => p.setOffset(GENESIS_MOMENTS[m.id])} className="rounded-lg border border-white/[0.08] px-1 py-1.5 text-[10.5px] text-ash hover:text-bone">
                {m.label}
              </button>
            ))}
          </div>
          <div className="mb-3 grid grid-cols-4 gap-1 font-mono text-[10px]">
            {[
              ["D2 −1s", lp - 1],
              ["D2 +0", lp],
              ["End −1s", end - 1],
              ["End +0", end],
            ].map(([l, s]) => (
              <button key={l} type="button" onClick={() => p.setOffset(s as number)} className="rounded-lg border border-white/[0.08] py-1 text-ash hover:text-bone">
                {l}
              </button>
            ))}
          </div>

          <div className="mb-1 flex items-baseline justify-between">
            <span className="label">xTOMB TWAP</span>
            <span className="num text-lg text-bone">${p.twap.toFixed(4)}</span>
          </div>
          <input type="range" min={0.8} max={1.12} step={0.001} value={p.twap} onChange={(e) => p.setTwap(parseFloat(e.target.value))} className="w-full accent-[#ff6a2b]" aria-label="Simulated xTOMB TWAP" />
          <div className="mt-2 grid grid-cols-4 gap-1">
            {PRICES.map((x) => (
              <button key={x.label} type="button" onClick={() => p.setTwap(x.price)} className="rounded-lg border border-white/[0.08] px-1 py-1.5 text-[10.5px] text-ash hover:text-bone">
                {x.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px]">
            <span className={`chip h-6 ${PHASE_META[phase].chip}`}>{PHASE_META[phase].label}</span>
            <button type="button" onClick={p.checkpoint} className="font-mono text-ash hover:text-bone" title="Advance one six-hour defense checkpoint at this TWAP">
              +1 checkpoint ({p.defense.checkpoints}/2)
            </button>
          </div>

          <label className="mt-3 flex items-center justify-between text-[12px] text-bone-dim">
            Oracle fresh
            <input type="checkbox" checked={p.oracleFresh} onChange={(e) => p.setOracleFresh(e.target.checked)} />
          </label>
          <label className="mt-1.5 flex items-center justify-between text-[12px] text-bone-dim">
            Sample wallet
            <input type="checkbox" checked={p.sampleWallet} onChange={(e) => p.setSampleWallet(e.target.checked)} />
          </label>
          <label className="mt-1.5 flex items-center justify-between text-[12px] text-bone-dim">
            Owner (sees Admin)
            <input type="checkbox" checked={p.owner} onChange={(e) => p.setOwner(e.target.checked)} />
          </label>
          <div className="mt-3">
            <span className="label">Genesis pass</span>
            <div className="mt-1 grid grid-cols-4 gap-1">
              {[null, ...PASS_ORDER].map((t) => (
                <button
                  key={t ?? "none"}
                  type="button"
                  onClick={() => p.setPass(t as PassTier | null)}
                  className={`rounded-lg border px-1 py-1.5 text-[10.5px] ${p.pass === t ? "border-ember/60 text-ember-hot" : "border-white/[0.08] text-ash hover:text-bone"}`}
                >
                  {t ? PASSES[t as PassTier].name : "None"}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-3 text-[10.5px] leading-snug text-ash-dim">Sample data only. Preview never asks a wallet to sign or send.</p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Preview controls · simulated TWAP $${p.twap.toFixed(3)}`}
          className="group flex h-10 items-center gap-2 rounded-full border border-warn/40 bg-basalt-2/90 px-3 font-mono text-[11px] text-warn shadow-[0_10px_30px_-12px_rgba(0,0,0,0.9)] backdrop-blur hover:border-warn/70"
        >
          <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-warn" />
          <span>Sim</span>
          <span className="hidden max-w-0 overflow-hidden whitespace-nowrap transition-[max-width] duration-300 group-hover:max-w-[140px] group-focus-visible:max-w-[140px] sm:inline">· ${p.twap.toFixed(3)} · controls</span>
        </button>
      )}
    </div>
  );
}
