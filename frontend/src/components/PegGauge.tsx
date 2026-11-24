import { useRef } from "react";

import { AnimatedNumber } from "@/components/fx/AnimatedNumber";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { PHASE_META, type MarketPhase } from "@/lib/protocol";

/**
 * PegGauge — the protocol on one dial.
 *
 * The sweep runs 0.90 → 1.30 (TWAP, in the paired asset) and is painted by what
 * the contracts DO in each zone:
 *   blue      ≤ 1.01        no expansion · sells pay 12%
 *   indigo    1.01 – 1.12   expansion on  · sells still pay 12%
 *   violet    1.12 – 1.20   expansion on  · sells pay 6%
 *   lilac     ≥ 1.20        expansion on  · sells pay 3%
 * The marker orbits to the TWAP on every refresh (GSAP elastic), so movement
 * itself is information — and it rides the arc, so it never covers the readout.
 */

const MIN = 0.9;
const MAX = 1.3;
const SWEEP = 115; // degrees either side of vertical
const CX = 200;
const CY = 188;
const R = 158;

function angleFor(v: number): number {
  const t = (Math.min(MAX, Math.max(MIN, v)) - MIN) / (MAX - MIN);
  return -SWEEP + t * SWEEP * 2;
}
function polar(r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return { x: CX + r * Math.sin(a), y: CY - r * Math.cos(a) };
}
function arc(r: number, from: number, to: number) {
  const a0 = angleFor(from);
  const a1 = angleFor(to);
  const p0 = polar(r, a0);
  const p1 = polar(r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

const ZONES: { from: number; to: number; stroke: string; label: string }[] = [
  { from: MIN, to: 1.006, stroke: "rgb(var(--blue-rgb))", label: "No expansion · 12% sell tax" },
  { from: 1.014, to: 1.116, stroke: "rgb(var(--indigo-rgb))", label: "Expansion · 12% sell tax" },
  { from: 1.124, to: 1.196, stroke: "rgb(var(--violet-rgb))", label: "Expansion · 6% sell tax" },
  { from: 1.204, to: MAX, stroke: "rgb(var(--iris-hot-rgb))", label: "Expansion · 3% sell tax" },
];

const TICKS = Array.from({ length: 17 }, (_, i) => MIN + i * 0.025);
const LABELS = [0.9, 1.0, 1.1, 1.2, 1.3];

interface PegGaugeProps {
  /** TWAP in the paired asset; null = no reading. */
  price: number | null;
  phase: MarketPhase;
  /** Chip text while the TWAP is unknown. */
  idleLabel?: string;
  /** Unit under the readout (the paired asset's symbol when it is known). */
  unit?: string;
  className?: string;
}

export function PegGauge({ price: reading, phase, idleLabel = "No reading", unit, className = "" }: PegGaugeProps) {
  const root = useRef<HTMLDivElement>(null);
  const needle = useRef<SVGGElement>(null);
  const known = reading !== null && reading > 0;
  const price = known ? reading : 0;
  const meta = PHASE_META[phase];

  // Arc draw-in on mount.
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const zones = gsap.utils.toArray<SVGPathElement>(".pg-zone", root.current);
      zones.forEach((z) => {
        const len = z.getTotalLength();
        gsap.fromTo(
          z,
          { strokeDasharray: len, strokeDashoffset: len },
          { strokeDashoffset: 0, duration: 1.1, ease: "power2.inOut", delay: 0.15 },
        );
      });
      gsap.from(".pg-tick", { opacity: 0, duration: 0.6, stagger: 0.015, delay: 0.3 });
    },
    { scope: root },
  );

  // Needle follows price.
  useGSAP(
    () => {
      if (!needle.current) return;
      const target = angleFor(known ? price : 1.0);
      if (prefersReducedMotion()) {
        gsap.set(needle.current, { rotation: target, svgOrigin: `${CX} ${CY}` });
        return;
      }
      gsap.to(needle.current, {
        rotation: target,
        svgOrigin: `${CX} ${CY}`,
        duration: 1.6,
        ease: EASE.needle,
        overwrite: true,
      });
    },
    { dependencies: [price, known], scope: root },
  );

  const deviation = known ? (price - 1) * 100 : 0;

  return (
    <div ref={root} className={`relative mx-auto w-full max-w-[460px] [container-type:inline-size] ${className}`}>
      <svg viewBox="0 0 400 268" className="w-full overflow-visible" role="img" aria-label={known ? `xTOMB TWAP ${price.toFixed(4)}` : "xTOMB TWAP: no reading"}>
        <defs>
          <filter id="pg-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        {/* track */}
        <path d={arc(R, MIN, MAX)} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="18" strokeLinecap="round" />

        {/* zones */}
        {ZONES.map((z) => (
          <path
            key={z.label}
            className="pg-zone"
            d={arc(R, z.from, z.to)}
            fill="none"
            stroke={z.stroke}
            strokeWidth="10"
            strokeLinecap="round"
            opacity={0.9}
          />
        ))}

        {/* ticks */}
        {TICKS.map((v) => {
          const major = Math.abs((v * 10) % 1) < 0.001 || Math.abs((v * 10) % 1) > 0.999;
          const a = angleFor(v);
          const p0 = polar(R + 16, a);
          const p1 = polar(R + (major ? 26 : 21), a);
          return (
            <line
              key={v.toFixed(3)}
              className="pg-tick"
              x1={p0.x}
              y1={p0.y}
              x2={p1.x}
              y2={p1.y}
              stroke={major ? "rgb(var(--bone-rgb) / 0.55)" : "rgb(var(--bone-rgb) / 0.18)"}
              strokeWidth={major ? 1.6 : 1}
            />
          );
        })}
        {LABELS.map((v) => {
          const p = polar(R + 40, angleFor(v));
          return (
            <text
              key={v}
              className="pg-tick"
              x={p.x}
              y={p.y + 4}
              textAnchor="middle"
              fontFamily="JetBrains Mono Variable, JetBrains Mono, monospace"
              fontSize="11"
              fill={v === 1.0 ? "rgb(var(--bone-rgb))" : "rgb(var(--ash-rgb))"}
            >
              {v.toFixed(2)}
            </text>
          );
        })}

        {/* marker — orbits the arc instead of sweeping across the readout */}
        <g ref={needle}>
          {known && <circle cx={CX} cy={CY - R} r="16" fill="rgb(var(--iris-rgb))" opacity="0.5" filter="url(#pg-glow)" />}
          <path
            d={`M ${CX} ${CY - R + 14} L ${CX - 7} ${CY - R + 27} L ${CX + 7} ${CY - R + 27} Z`}
            fill={known ? "rgb(var(--bone-rgb))" : "rgb(var(--ash-dim-rgb))"}
          />
          <circle cx={CX} cy={CY - R} r="7" fill="#050507" stroke={known ? "rgb(var(--bone-rgb))" : "rgb(var(--ash-dim-rgb))"} strokeWidth="2.5" />
          <circle cx={CX} cy={CY - R} r="2.5" fill={known ? "rgb(var(--iris-rgb))" : "rgb(var(--ash-dim-rgb))"} />
        </g>
      </svg>

      {/* readout */}
      <div className="pointer-events-none absolute inset-x-0 top-[37%] flex flex-col items-center text-center">
        <span className="label mb-2">TWAP</span>
        <div className="flex items-baseline gap-2">
          <AnimatedNumber
            value={known ? price : null}
            format={(n) => n.toFixed(4)}
            className="font-display text-[clamp(26px,10.5cqw,46px)] font-semibold leading-none tracking-[-0.04em] text-bone"
          />
          {unit && known && <span className="hidden max-w-[5rem] truncate font-mono text-xs text-ash sm:inline">{unit}</span>}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className={`chip ${meta.chip}`}>
            <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-current" />
            {known ? meta.label : idleLabel}
          </span>
          {known && (
            <span className={`num text-xs ${deviation >= 0 ? "text-iris-hot" : "text-spectre"}`}>
              {deviation >= 0 ? "+" : ""}
              {deviation.toFixed(2)}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
