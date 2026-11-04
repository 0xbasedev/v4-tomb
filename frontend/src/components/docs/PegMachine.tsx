import { useRef, useState } from "react";

import { targetBps } from "@/lib/fireTax";
import { DEFENSE, EXPANSION, FIRE, pct as fmtPct } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { Slider, Stage, useEnter } from "./kit";

/**
 * The peg machine — drag the validated TWAP and watch which force switches
 * on: the Fire Tax target (every price), Critical Defense (≤ $0.90, fresh
 * TWAP), and the planned expansion gate (> $1.01, fresh TWAP).
 */

const MIN = 0.8;
const MAX = 1.1;
const ZONES = [
  { from: MIN, to: DEFENSE.enterAt, cls: "from-bad/70 to-bad/50", label: "Critical Defense" },
  { from: DEFENSE.enterAt, to: 1, cls: "from-amethyst-deep/70 to-amethyst/60", label: "Tax rising" },
  { from: 1, to: EXPANSION.gate, cls: "from-bone/50 to-bone/40", label: "Band" },
  { from: EXPANSION.gate, to: MAX, cls: "from-ember-deep/70 to-ember/70", label: "Expansion gate" },
];
const pct = (v: number) => ((v - MIN) / (MAX - MIN)) * 100;

export function PegMachine() {
  const [price, setPrice] = useState(0.94);
  const root = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);

  const expanding = price > EXPANSION.gate;
  const defending = price <= DEFENSE.enterAt;
  const tax = targetBps(price);
  const forces = [
    {
      id: "tax",
      name: "Fire Tax",
      who: "xTOMB/USDC hook",
      on: true,
      tone: "bad",
      text: `${fmtPct(tax)} target on sells at this TWAP (${fmtPct(FIRE.baselineBps)} at peg, ${fmtPct(FIRE.capBps)} at $${FIRE.fullTaxAt.toFixed(2)}); buys pay 0%`,
    },
    {
      id: "def",
      name: "Critical Defense",
      who: "MasonryCriticalDefense",
      on: defending,
      tone: "amethyst",
      text: defending ? "100% of new xSHARE sell tax buys and burns xTOMB" : `Off — enters at a fresh TWAP ≤ $${DEFENSE.enterAt.toFixed(2)}`,
    },
    {
      id: "mint",
      name: "Expansion (planned)",
      who: "Treasury mint not bound yet",
      on: expanding,
      tone: "ember",
      text: expanding ? `An eligible epoch may mint up to ${fmtPct(EXPANSION.maxPerEpochBps)} of circulating xTOMB` : `Off — needs a fresh TWAP above $${EXPANSION.gate.toFixed(2)}`,
    },
  ];

  useEnter(root, (tl) => {
    tl.from(".pm-zone", { scaleX: 0, transformOrigin: "left", duration: 0.7, stagger: 0.1, ease: EASE.settle }).from(
      ".pm-forces",
      { y: 16, autoAlpha: 0, duration: 0.5, ease: EASE.rise },
      "-=0.3",
    );
  });

  useGSAP(
    () => {
      if (!marker.current) return;
      const left = `${pct(price)}%`;
      if (prefersReducedMotion()) gsap.set(marker.current, { left });
      else gsap.to(marker.current, { left, duration: 0.35, ease: "power3.out", overwrite: true });
      gsap.to(".pm-force[data-on='true']", { scale: 1, opacity: 1, duration: 0.4, ease: EASE.snap });
      gsap.to(".pm-force[data-on='false']", { scale: 0.97, opacity: 0.45, duration: 0.4 });
    },
    { scope: root, dependencies: [price] },
  );

  return (
    <Stage caption="Drag the validated TWAP. The Fire Tax works at every price; Critical Defense and expansion each need a fresh TWAP on their side of the band.">
      <div ref={root}>
        <div className="relative pb-7 pt-10">
          <div className="flex h-4 overflow-hidden rounded-full">
            {ZONES.map((z) => (
              <div key={z.label} className={`pm-zone h-full bg-gradient-to-r ${z.cls}`} style={{ width: `${pct(z.to) - pct(z.from)}%` }} />
            ))}
          </div>
          <div ref={marker} className="absolute top-0 -translate-x-1/2" style={{ left: `${pct(price)}%` }}>
            <div className="num whitespace-nowrap rounded-md bg-bone px-1.5 py-0.5 text-[11px] font-semibold text-void">${price.toFixed(2)}</div>
            <div className="mx-auto h-9 w-0.5 bg-bone" />
          </div>
          <div className="absolute inset-x-0 bottom-0 flex justify-between font-mono text-[10px] text-ash">
            {[0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1].map((v) => (
              <span key={v}>${v.toFixed(2)}</span>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <Slider id="pm-price" label="xTOMB TWAP" value={price} min={MIN} max={MAX} step={0.01} onChange={setPrice} display={`$${price.toFixed(2)}`} />
        </div>
        <div className="pm-forces mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {forces.map((f) => (
            <div
              key={f.id}
              data-on={String(f.on)}
              className={`pm-force rounded-xl border p-3 ${
                f.on
                  ? f.tone === "bad"
                    ? "border-bad/40 bg-bad/[0.06]"
                    : f.tone === "ember"
                      ? "border-ember/45 bg-ember/[0.07]"
                      : "border-amethyst/45 bg-amethyst/[0.08]"
                  : "border-white/[0.06] bg-black/20"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${f.on ? (f.tone === "bad" ? "bg-bad" : f.tone === "ember" ? "bg-ember" : "bg-amethyst") : "bg-ash-dim"} ${f.on ? "animate-breathe" : ""}`} />
                <span className="text-[13px] font-semibold text-bone">{f.name}</span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-ash">{f.who}</div>
              <div className="mt-1.5 text-[12px] leading-snug text-bone-dim">{f.text}</div>
            </div>
          ))}
        </div>
      </div>
    </Stage>
  );
}
