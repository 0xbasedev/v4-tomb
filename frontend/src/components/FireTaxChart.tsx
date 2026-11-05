import { useRef } from "react";

import { DRIVER_LABEL, targetBps, type TaxQuote, type TaxedAsset } from "@/lib/fireTax";
import { FIRE, pct } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";

/**
 * Fire Tax curve: the target rate against price ÷ reference — 1% at or
 * above the reference, rising quadratically to the 12% cap at 0.85. The
 * Genesis floor (3% xTOMB, 6% xSHARE) is drawn as a dashed line while
 * Genesis runs, and a marker sits at the current TWAP with the one rate a
 * sell would pay right now.
 */

const W = 520;
const H = 210;
const PADL = 40;
const PADR = 14;
const PADT = 14;
const PADB = 30;
const X0 = 0.8;
const X1 = 1.05;

const x = (v: number) => PADL + ((v - X0) / (X1 - X0)) * (W - PADL - PADR);
const y = (bps: number) => PADT + (1 - bps / 1300) * (H - PADT - PADB);

export function FireTaxChart({
  asset,
  ratio,
  quote,
  genesisActive,
  simulated,
}: {
  asset: TaxedAsset;
  /** Current TWAP ÷ reference (null = no valid TWAP). */
  ratio: number | null;
  quote: TaxQuote | null;
  genesisActive: boolean;
  simulated?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const pts = Array.from({ length: 101 }, (_, i) => X0 + ((X1 - X0) * i) / 100);
  const path = pts.map((v, i) => `${i ? "L" : "M"} ${x(v).toFixed(1)} ${y(targetBps(v)).toFixed(1)}`).join(" ");
  const floor = FIRE.genesisFloorBps[asset];
  const rate = quote?.rateBps ?? null;
  const markerX = ratio !== null ? x(Math.min(X1, Math.max(X0, ratio))) : null;

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const line = root.current?.querySelector<SVGPathElement>(".ft-curve");
      if (line) {
        const len = line.getTotalLength();
        gsap.fromTo(line, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.1, ease: "power2.out" });
      }
    },
    { scope: root },
  );
  useGSAP(
    () => {
      if (prefersReducedMotion() || markerX === null) return;
      gsap.to(".ft-marker", { x: markerX, duration: 0.6, ease: EASE.settle });
      gsap.to(".ft-dot", { y: y(rate ?? FIRE.baselineBps), duration: 0.6, ease: EASE.settle });
    },
    { scope: root, dependencies: [markerX, rate] },
  );

  return (
    <div ref={root} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${asset} Fire Tax curve`}>
        {[100, 300, 600, 1200].map((b) => (
          <g key={b}>
            <line x1={PADL} x2={W - PADR} y1={y(b)} y2={y(b)} stroke="rgba(255,255,255,0.05)" />
            <text x={PADL - 6} y={y(b) + 3} textAnchor="end" fontSize="9.5" fill="#7c7a74" fontFamily="JetBrains Mono Variable, monospace">
              {b / 100}%
            </text>
          </g>
        ))}
        {[0.8, 0.85, 0.9, 0.95, 1.0, 1.05].map((v) => (
          <text key={v} x={x(v)} y={H - 10} textAnchor="middle" fontSize="9.5" fill={v === 1 ? "#ece8df" : "#7c7a74"} fontFamily="JetBrains Mono Variable, monospace">
            {v.toFixed(2)}
          </text>
        ))}
        <line x1={x(FIRE.fullTaxAt)} x2={x(FIRE.fullTaxAt)} y1={PADT} y2={H - PADB} stroke="rgba(255,59,92,0.25)" strokeDasharray="3 4" />
        <path d={`${path} L ${x(X1)} ${y(0)} L ${x(X0)} ${y(0)} Z`} fill="rgba(255,106,43,0.06)" />
        <path className="ft-curve" d={path} fill="none" stroke="#ff6a2b" strokeWidth="2.2" />
        {genesisActive && (
          <g>
            <line x1={PADL} x2={W - PADR} y1={y(floor)} y2={y(floor)} stroke={asset === "xTOMB" ? "#ffb547" : "#3ee7ff"} strokeDasharray="6 5" strokeWidth="1.4" />
            <text x={W - PADR} y={y(floor) - 5} textAnchor="end" fontSize="9.5" fill={asset === "xTOMB" ? "#ffb547" : "#3ee7ff"} fontFamily="JetBrains Mono Variable, monospace">
              Genesis floor {pct(floor)}
            </text>
          </g>
        )}
        {markerX !== null && (
          <g className="ft-marker" transform={`translate(${prefersReducedMotion() ? markerX : 0},0)`}>
            <line x1={0} x2={0} y1={PADT} y2={H - PADB} stroke="rgba(236,232,223,0.35)" />
            <circle className="ft-dot" cx={0} cy={prefersReducedMotion() ? y(rate ?? FIRE.baselineBps) : 0} r="5.5" fill="#050507" stroke="#ece8df" strokeWidth="2" />
          </g>
        )}
        <text x={PADL} y={PADT + 2} fontSize="9.5" fill="#7c7a74" fontFamily="JetBrains Mono Variable, monospace">
          price ÷ reference →
        </text>
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <span className="text-ash">
          {asset} sell now{simulated ? " · simulated" : ""}:{" "}
          <span aria-label={`Current ${asset} Fire Tax`} className={rate === null ? "text-warn" : "num text-bone"}>
            {rate === null ? "sells rejected (no valid TWAP)" : pct(rate)}
          </span>
          {quote?.driver && rate !== null && <span className="text-ash"> · {DRIVER_LABEL[quote.driver]}</span>}
        </span>
        <span className="font-mono text-[10.5px] text-ash-dim">
          baseline {pct(FIRE.baselineBps)} · cap {pct(FIRE.capBps)} at {FIRE.fullTaxAt.toFixed(2)} · recovery {FIRE.recoverySeconds / 3600}h
        </span>
      </div>
    </div>
  );
}
