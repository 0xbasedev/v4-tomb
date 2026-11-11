import { useRef, useState } from "react";

import { DEFENSE, EPOCH_SECONDS, EXPANSION, SQUARE_ROUTING, pct } from "@/lib/launch";
import { stepDefense } from "@/lib/market";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { Stage, useEnter } from "./kit";

/* ------------------------------------------------------------------------ */
/* Epoch wheel — 12 six-hour checkpoints, each judged on its own reading     */
/* ------------------------------------------------------------------------ */

const EPOCHS = 12;
const READINGS: { twap: number; fresh: boolean }[] = [
  { twap: 1.004, fresh: true },
  { twap: 1.018, fresh: true },
  { twap: 1.026, fresh: true },
  { twap: 1.02, fresh: false },
  { twap: 0.97, fresh: true },
  { twap: 0.88, fresh: true },
  { twap: 0.94, fresh: true },
  { twap: 1.012, fresh: true },
  { twap: 1.003, fresh: true },
  { twap: 1.014, fresh: true },
  { twap: 1.017, fresh: true },
  { twap: 1.03, fresh: true },
];

/** Replays the readings through the defense state machine so each epoch knows its mode. */
function timeline() {
  let d = { active: false, checkpoints: 0 };
  return READINGS.map((r) => {
    d = stepDefense(d, r.twap, r.fresh);
    const kind = !r.fresh ? "stale" : d.active ? "defense" : r.twap > EXPANSION.gate ? "expansion" : r.twap >= 1 ? "band" : "tax";
    return { ...r, kind, defense: { ...d } };
  });
}
const KIND: Record<string, { label: string; color: string; does: (e: ReturnType<typeof timeline>[number]) => string }> = {
  expansion: { label: "Eligible", color: "#ff6a2b", does: () => `Fresh TWAP above $${EXPANSION.gate.toFixed(2)}: this epoch may mint up to ${pct(EXPANSION.maxPerEpochBps)} of circulating xTOMB (planned).` },
  band: { label: "Band", color: "#b9b5ac", does: () => "Inside the band: nothing mints, the Fire Tax sits at its baseline." },
  tax: { label: "Below peg", color: "#b48cff", does: () => "Below $1: nothing mints and sells pay a higher Fire Tax." },
  defense: { label: "Defense", color: "#ff3b5c", does: (e) => `Critical Defense: new xSHARE tax buys and burns xTOMB. Recovery ${e.defense.checkpoints}/${DEFENSE.recoveryEpochs} checkpoints above $${DEFENSE.exitAbove.toFixed(2)}.` },
  stale: { label: "Stale", color: "#ffb547", does: () => "No fresh validated TWAP: no expansion, no catch-up later, sells rejected, defense keeps its mode." },
};

export function EpochWheel() {
  const root = useRef<HTMLDivElement>(null);
  const hand = useRef<SVGGElement>(null);
  const tween = useRef<gsap.core.Tween | null>(null);
  const [active, setActive] = useState(0);
  const [pinned, setPinned] = useState<number | null>(null);
  const tl = timeline();
  const R = 92;
  const CX = 110;
  const CY = 110;
  const seg = (i: number) => {
    const a0 = (i / EPOCHS) * Math.PI * 2 - Math.PI / 2 + 0.03;
    const a1 = ((i + 1) / EPOCHS) * Math.PI * 2 - Math.PI / 2 - 0.03;
    const p = (a: number, r: number) => `${(CX + r * Math.cos(a)).toFixed(2)} ${(CY + r * Math.sin(a)).toFixed(2)}`;
    return `M ${p(a0, R)} A ${R} ${R} 0 0 1 ${p(a1, R)} L ${p(a1, R - 22)} A ${R - 22} ${R - 22} 0 0 0 ${p(a0, R - 22)} Z`;
  };
  useEnter(root, (t) => {
    t.from(".ew-seg", { autoAlpha: 0, scale: 0.85, transformOrigin: "110px 110px", duration: 0.4, stagger: 0.05, ease: EASE.snap });
  });
  useGSAP(
    () => {
      if (!hand.current || prefersReducedMotion()) return;
      const state = { e: 0 };
      tween.current = gsap.to(state, {
        e: EPOCHS,
        duration: EPOCHS * 1.4,
        ease: `steps(${EPOCHS * 6})`,
        repeat: -1,
        onUpdate: () => {
          gsap.set(hand.current, { rotation: (state.e / EPOCHS) * 360, svgOrigin: `${CX} ${CY}` });
          setActive(Math.min(EPOCHS - 1, Math.floor(state.e)));
        },
      });
      return () => tween.current?.kill();
    },
    { scope: root },
  );
  const shown = pinned ?? active;
  const e = tl[shown];
  const k = KIND[e.kind];
  return (
    <Stage caption={`Three days of ${EPOCH_SECONDS / 3600}-hour checkpoints with sample readings. No epoch mints unconditionally — there's no bootstrap — and a missed or stale epoch is never made up later.`}>
      <div ref={root} className="grid grid-cols-1 items-center gap-5 sm:grid-cols-[220px_1fr]">
        <svg viewBox="0 0 220 220" className="mx-auto w-[220px]" role="img" aria-label="Epoch wheel">
          {tl.map((x, i) => (
            <path
              key={i}
              className="ew-seg cursor-pointer"
              d={seg(i)}
              fill={KIND[x.kind].color}
              opacity={i === shown ? 1 : 0.35}
              onClick={() => {
                setPinned(pinned === i ? null : i);
                if (pinned === i) tween.current?.resume();
                else tween.current?.pause();
              }}
            />
          ))}
          <g ref={hand}>
            <line x1={CX} y1={CY} x2={CX} y2={CY - R + 26} stroke="#ece8df" strokeWidth="2" strokeLinecap="round" />
          </g>
          <circle cx={CX} cy={CY} r="34" fill="#0b0c10" stroke="rgba(255,255,255,0.1)" />
          <text x={CX} y={CY - 2} textAnchor="middle" fontSize="18" fontWeight="600" fill="#ece8df" fontFamily="Unbounded Variable, Unbounded, sans-serif">
            #{shown + 1}
          </text>
          <text x={CX} y={CY + 14} textAnchor="middle" fontSize="9" fill="#7c7a74" fontFamily="JetBrains Mono Variable, monospace">
            6H EPOCH
          </text>
        </svg>
        <div>
          <div className="label mb-1" style={{ color: k.color }}>
            Epoch {shown + 1} · {k.label}
          </div>
          <div className="num text-2xl text-bone">
            TWAP ${e.twap.toFixed(3)}
            {!e.fresh && <span className="ml-2 text-[12px] text-warn">stale</span>}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-bone-dim">{k.does(e)}</p>
          <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {Object.entries(KIND).map(([key, v]) => (
              <div key={key} className="flex items-center gap-2 text-[11.5px] text-ash">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: v.color }} />
                {v.label}
              </div>
            ))}
          </div>
          <div className="mt-2 font-mono text-[10px] text-ash">{pinned !== null ? "pinned · tap again to resume" : "tap a segment to pin it"}</div>
        </div>
      </div>
    </Stage>
  );
}

/* ------------------------------------------------------------------------ */
/* xSHARE fee routing — one source, flows sized by share, current running    */
/* ------------------------------------------------------------------------ */

type Lane = { k: string; sub: string; share: number; color: string };

export function RoutingSplit() {
  const root = useRef<HTMLDivElement>(null);
  const [critical, setCritical] = useState(false);
  const lanes: Lane[] = critical
    ? [{ k: "xTOMB buy-and-burn", sub: "MasonryCriticalDefense", share: 1, color: "#ff3b5c" }]
    : [
        { k: "Protocol LP", sub: "xSHARE/USDC, protocol-owned", share: SQUARE_ROUTING.polBps / 10_000, color: "#3ee7ff" },
        { k: "USDC reserve", sub: "sold to USDC", share: SQUARE_ROUTING.usdcReserveBps / 10_000, color: "#5b9dff" },
        { k: "xSHARE reserve", sub: "held as xSHARE", share: SQUARE_ROUTING.squareReserveBps / 10_000, color: "#b48cff" },
      ];
  // Geometry: the source column is split exactly by share; destination boxes get a
  // minimum height so every label fits, with the leftover space shared by share.
  const W = 520;
  const top = 14;
  const span = 152;
  const gap = 10;
  const minH = 34;
  const free = span - gap * (lanes.length - 1) - minH * lanes.length;
  let srcY = top;
  let dstY = top;
  const geo = lanes.map((l) => {
    const sh = l.share * span;
    const dh = minH + Math.max(0, free) * l.share;
    const g = { ...l, s0: srcY, s1: srcY + sh, d0: dstY, d1: dstY + dh };
    srcY += sh;
    dstY += dh + gap;
    return g;
  });
  const X0 = 112;
  const X1 = 318;
  const flow = (g: (typeof geo)[number]) => {
    const m = (X0 + X1) / 2;
    return `M ${X0} ${g.s0} C ${m} ${g.s0}, ${m} ${g.d0}, ${X1} ${g.d0} L ${X1} ${g.d1} C ${m} ${g.d1}, ${m} ${g.s1}, ${X0} ${g.s1} Z`;
  };
  const centre = (g: (typeof geo)[number]) => {
    const m = (X0 + X1) / 2;
    const a = (g.s0 + g.s1) / 2;
    const b = (g.d0 + g.d1) / 2;
    return `M ${X0} ${a} C ${m} ${a}, ${m} ${b}, ${X1} ${b}`;
  };

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.fromTo(".rs-band", { autoAlpha: 0, scaleX: 0.2, transformOrigin: `${X0}px 50%` }, { autoAlpha: 1, scaleX: 1, duration: 0.7, stagger: 0.08, ease: EASE.settle });
      gsap.fromTo(".rs-dst", { x: 14, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.5, stagger: 0.08, delay: 0.25, ease: EASE.rise });
      gsap.fromTo(".rs-bar", { scaleX: 0 }, { scaleX: 1, transformOrigin: "left center", duration: 0.7, stagger: 0.08, ease: EASE.settle });
      const runs = gsap.utils.toArray<SVGPathElement>(".rs-run", root.current).map((p) =>
        gsap.fromTo(p, { strokeDashoffset: 0 }, { strokeDashoffset: -40, duration: 1.4, repeat: -1, ease: "none" }),
      );
      return () => runs.forEach((t) => t.kill());
    },
    { scope: root, dependencies: [critical] },
  );

  return (
    <Stage caption="Shares of the collected xSHARE sell tax, never of the sale. Critical Defense redirects only new eligible revenue; earlier earmarks keep their purpose.">
      <div ref={root}>
        <div className="mb-3 flex gap-1">
          {[false, true].map((c) => (
            <button
              key={String(c)}
              type="button"
              aria-pressed={critical === c}
              onClick={() => setCritical(c)}
              className={`rounded-lg border px-2.5 py-1.5 text-[12px] ${critical === c ? (c ? "border-bad/60 bg-bad/10 text-bad" : "border-spectre/60 bg-spectre/10 text-spectre") : "border-white/[0.08] text-ash"}`}
            >
              {c ? "Critical Defense" : "Normal"}
            </button>
          ))}
        </div>
        {/* Phone: the same split as labelled bars — the flow diagram's text would be too small. */}
        <ul className="space-y-3 sm:hidden">
          {lanes.map((l) => (
            <li key={l.k}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-bone">{l.k}</span>
                <span className="font-mono text-[14px] font-semibold" style={{ color: l.color }}>
                  {Math.round(l.share * 100)}%
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.05]">
                <div className="rs-bar h-full rounded-full" style={{ width: `${l.share * 100}%`, background: l.color }} />
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-ash">{l.sub}</div>
            </li>
          ))}
        </ul>
        <svg viewBox={`0 0 ${W} 180`} className="hidden w-full sm:block" role="img" aria-label={`xSHARE tax routing: ${lanes.map((l) => `${l.k} ${Math.round(l.share * 100)}%`).join(", ")}`}>
          <rect x={16} y={top} width={X0 - 16} height={span} rx={10} fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" />
          <text x={28} y={top + span / 2 - 6} fontSize="11.5" fontWeight="600" fill="#ece8df" fontFamily="Inter Variable, sans-serif">
            xSHARE
          </text>
          <text x={28} y={top + span / 2 + 9} fontSize="10" fill="#7c7a74" fontFamily="JetBrains Mono Variable, monospace">
            sell tax
          </text>
          {geo.map((g) => (
            <g key={g.k}>
              <path className="rs-band" d={flow(g)} fill={g.color} opacity={0.16} />
              <path className="rs-run" d={centre(g)} fill="none" stroke={g.color} strokeWidth={Math.max(1.5, Math.min(4, g.share * 6))} strokeDasharray="4 16" strokeLinecap="round" />
              <g className="rs-dst">
                <rect x={X1} y={g.d0} width={W - X1 - 8} height={g.d1 - g.d0} rx={8} fill={g.color} fillOpacity={0.1} stroke={g.color} strokeOpacity={0.5} />
                <text x={X1 + 12} y={(g.d0 + g.d1) / 2 - 2} fontSize="11.5" fontWeight="600" fill="#ece8df" fontFamily="Inter Variable, sans-serif">
                  {g.k}
                </text>
                <text x={X1 + 12} y={(g.d0 + g.d1) / 2 + 12} fontSize="9.5" fill="#7c7a74" fontFamily="JetBrains Mono Variable, monospace">
                  {g.sub}
                </text>
                <text x={W - 20} y={(g.d0 + g.d1) / 2 + 5} textAnchor="end" fontSize="15" fontWeight="600" fill={g.color} fontFamily="JetBrains Mono Variable, monospace">
                  {Math.round(g.share * 100)}%
                </text>
              </g>
            </g>
          ))}
        </svg>
      </div>
    </Stage>
  );
}
