import { useRef } from "react";

import { formatBps } from "@/lib/format";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { TAX, scheduleBps } from "@/lib/protocol";

/**
 * The sell-tax schedule as a step chart: 12% below a 1.12 TWAP, 6% from 1.12,
 * 3% from 1.20 (PegDefenseHook.taxTiersTwaps / taxTiersRates). The marker sits
 * at the price the hook is taxing against right now, and its height is the
 * rate a sell would actually pay — which can sit above the step under it while
 * a 7-hour recovery window is still open.
 */

const W = 520;
const H = 210;
const PADL = 40;
const PADR = 14;
const PADT = 16;
const PADB = 30;
const X0 = 0.95;
const X1 = 1.3;

const x = (v: number) => PADL + ((Math.min(X1, Math.max(X0, v)) - X0) / (X1 - X0)) * (W - PADL - PADR);
const y = (bps: number) => PADT + (1 - bps / 1400) * (H - PADT - PADB);

export function TaxLadder({ price, rateBps, enabled }: { price: number | null; rateBps: number | null; enabled: boolean | null }) {
  const root = useRef<HTMLDivElement>(null);
  const steps = TAX.tiers.map((t, i) => ({ from: Math.max(X0, t.from), to: TAX.tiers[i + 1]?.from ?? X1, bps: t.bps }));
  const path = steps.map((s, i) => `${i ? "L" : "M"} ${x(s.from).toFixed(1)} ${y(s.bps).toFixed(1)} L ${x(s.to).toFixed(1)} ${y(s.bps).toFixed(1)}`).join(" ");
  const area = `${path} L ${x(X1).toFixed(1)} ${y(0).toFixed(1)} L ${x(X0).toFixed(1)} ${y(0).toFixed(1)} Z`;
  const live = price !== null && rateBps !== null;
  const mx = live ? x(price!) : null;
  const my = live ? y(rateBps!) : null;
  const ratchet = live && rateBps! > scheduleBps(price!);

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const line = root.current?.querySelector<SVGPathElement>(".tl-curve");
      if (line) {
        const len = line.getTotalLength();
        gsap.fromTo(line, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.1, ease: "power2.out" });
      }
      gsap.from(".tl-area", { opacity: 0, duration: 0.9, delay: 0.3 });
    },
    { scope: root },
  );
  useGSAP(
    () => {
      const marker = root.current?.querySelector<SVGGElement>(".tl-marker");
      if (!marker || mx === null || my === null) return;
      if (prefersReducedMotion()) {
        gsap.set(marker, { x: mx, y: my });
        return;
      }
      gsap.to(marker, { x: mx, y: my, duration: 1, ease: EASE.settle });
    },
    { scope: root, dependencies: [mx, my] },
  );

  return (
    <div ref={root}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Sell tax by TWAP: 12 percent below 1.12, 6 percent from 1.12, 3 percent from 1.20">
        <defs>
          <linearGradient id="tl-stroke" x1="0" x2="1">
            <stop offset="0" stopColor="rgb(var(--blue-rgb))" />
            <stop offset=".5" stopColor="rgb(var(--indigo-rgb))" />
            <stop offset="1" stopColor="rgb(var(--iris-soft-rgb))" />
          </linearGradient>
          <linearGradient id="tl-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgb(var(--indigo-rgb))" stopOpacity=".28" />
            <stop offset="1" stopColor="rgb(var(--indigo-rgb))" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[300, 600, 1200].map((bps) => (
          <g key={bps}>
            <line x1={PADL} x2={W - PADR} y1={y(bps)} y2={y(bps)} stroke="rgba(255,255,255,0.06)" strokeDasharray="3 5" />
            <text x={PADL - 8} y={y(bps) + 4} textAnchor="end" fontSize="11" fontFamily="JetBrains Mono Variable, monospace" fill="rgb(var(--ash-rgb))">
              {bps / 100}%
            </text>
          </g>
        ))}
        {[1.0, 1.12, 1.2, 1.3].map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={H - PADB} y2={H - PADB + 5} stroke="rgba(255,255,255,0.25)" />
            <text x={x(v)} y={H - 8} textAnchor="middle" fontSize="11" fontFamily="JetBrains Mono Variable, monospace" fill="rgb(var(--ash-rgb))">
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        <path className="tl-area" d={area} fill="url(#tl-fill)" />
        <path className="tl-curve" d={path} fill="none" stroke="url(#tl-stroke)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {live && (
          <g className="tl-marker" transform={`translate(${x(1)} ${y(TAX.maxBps)})`}>
            <circle r="13" fill="rgb(var(--iris-rgb))" opacity=".25" />
            <circle r="6" fill="rgb(var(--void-rgb))" stroke="rgb(var(--bone-rgb))" strokeWidth="2.5" />
          </g>
        )}
      </svg>
      <p className="mt-2 text-[12.5px] leading-relaxed text-bone-dim" data-testid="tax-ladder-caption">
        {!live ? (
          <>Schedule from the contract. The live rate appears here once the protocol is deployed.</>
        ) : enabled === false ? (
          <>
            The tax switch is <span className="text-bone">off</span>: sells are not taxed right now. If it is switched on, a sell at this price would pay {formatBps(rateBps)}.
          </>
        ) : (
          <>
            A sell right now pays <span className="font-semibold text-bone">{formatBps(rateBps)}</span> (TWAP {price!.toFixed(4)}).
            {ratchet && " That is above the step for this price: the rate rose earlier and only falls after a 7-hour recovery window."}
          </>
        )}
      </p>
    </div>
  );
}
