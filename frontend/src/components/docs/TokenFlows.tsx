import { useRef, useState } from "react";
import { Link } from "react-router-dom";

import { SQUARE_SUPPLY } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { Segmented, Stage, useEnter } from "./kit";

/**
 * Token flows — the three tokens as a circuit. Value moves along the wires:
 * LP farms pay xSHARE (pending), xSHARE stakers share expansion xTOMB
 * (pending), and xBOND is a planned preview. Pick a token to light its wires.
 */

type Tok = "xBOND" | "xTOMB" | "xSHARE";

const NODES: Record<Tok, { x: number; color: string; role: string; get: string; use: string; to: string; cta: string }> = {
  xBOND: {
    x: 70,
    color: "#b48cff",
    role: "Planned preview",
    get: "Not issued yet. Issuance and redemption stay disabled until the bond contract ships.",
    use: "No rates, caps or returns are set. Once live, the Bonds page shows the contract's own quote.",
    to: "/bonds",
    cta: "Bonds",
  },
  xTOMB: {
    x: 260,
    color: "#ff6a2b",
    role: "The peg · $1 USDC",
    get: "Earned in Genesis, or bought on Swap — buys and wallet transfers pay 0% Fire Tax.",
    use: "Pair it with USDC for the xTOMB/USDC LP, the pool that takes 75% of Genesis emissions from Day 2.",
    to: "/swap",
    cta: "Swap",
  },
  xSHARE: {
    x: 450,
    color: "#3ee7ff",
    role: `The share · ${SQUARE_SUPPLY.cap.toLocaleString("en-US")} cap`,
    get: `${SQUARE_SUPPLY.farming.toLocaleString("en-US")} are reserved for LP farming (pending). Trades against USDC in the official xSHARE/USDC pool.`,
    use: "Pair it with USDC and stake the LP in the Masonry for a share of expansion xTOMB (pending). Its sell tax funds protocol liquidity and reserves.",
    to: "/masonry",
    cta: "Masonry",
  },
};

const EDGES: { id: string; d: string; label: string; lx: number; ly: number; touches: Tok[]; color: string }[] = [
  { id: "farm", d: "M 294 136 Q 355 62 416 136", label: "LP farms earn xSHARE", lx: 355, ly: 80, touches: ["xTOMB", "xSHARE"], color: "#3ee7ff" },
  { id: "masonry", d: "M 416 164 Q 355 238 294 164", label: "stakers share expansion", lx: 355, ly: 232, touches: ["xTOMB", "xSHARE"], color: "#ff6a2b" },
  { id: "burn", d: "M 226 136 Q 165 62 104 136", label: "bond · planned", lx: 165, ly: 80, touches: ["xTOMB", "xBOND"], color: "#b48cff" },
  { id: "redeem", d: "M 104 164 Q 165 238 226 164", label: "redeem · planned", lx: 165, ly: 232, touches: ["xTOMB", "xBOND"], color: "#ff6a2b" },
];

export function TokenFlows() {
  const [sel, setSel] = useState<Tok>("xTOMB");
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);

  useEnter(root, (tl) => {
    tl.from(".tf-node", { scale: 0, transformOrigin: "center", duration: 0.6, stagger: 0.1, ease: EASE.snap }).from(
      ".tf-wire",
      { strokeDashoffset: 300, autoAlpha: 0, duration: 0.8, stagger: 0.08, ease: "power2.out" },
      "-=0.2",
    );
  });

  // Current flowing along every wire, faster on the selected token's wires.
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.utils.toArray<SVGPathElement>(".tf-flow", root.current).forEach((p) => {
        const hot = p.dataset.touches?.split(",").includes(sel);
        gsap.killTweensOf(p);
        gsap.fromTo(p, { strokeDashoffset: 0 }, { strokeDashoffset: -28, duration: hot ? 0.7 : 2.2, repeat: -1, ease: "none" });
        gsap.to(p, { opacity: hot ? 1 : 0.25, duration: 0.4 });
      });
      if (card.current) gsap.fromTo(card.current, { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.4, ease: EASE.rise });
    },
    { scope: root, dependencies: [sel] },
  );

  const n = NODES[sel];
  return (
    <Stage>
      <div ref={root}>
        <div className="mb-3">
          <Segmented options={(["xTOMB", "xSHARE", "xBOND"] as Tok[]).map((t) => ({ id: t, label: t }))} value={sel} onChange={setSel} />
        </div>
        <svg viewBox="0 52 520 200" className="w-full" role="img" aria-label="How value moves between xTOMB, xSHARE and xBOND">
          <defs>
            {EDGES.map((e) => (
              <marker key={e.id} id={`tf-arrow-${e.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={e.color} />
              </marker>
            ))}
            <filter id="tf-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="8" />
            </filter>
          </defs>
          {EDGES.map((e) => {
            const hot = e.touches.includes(sel);
            return (
              <g key={e.id}>
                <path className="tf-wire" d={e.d} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" strokeDasharray="300" />
                <path
                  className="tf-flow"
                  data-touches={e.touches.join(",")}
                  d={e.d}
                  fill="none"
                  stroke={e.color}
                  strokeWidth="2.4"
                  strokeDasharray="6 8"
                  markerEnd={`url(#tf-arrow-${e.id})`}
                />
                <text x={e.lx} y={e.ly} textAnchor="middle" fontSize="11" fill={hot ? "#ece8df" : "#7c7a74"} fontFamily="JetBrains Mono Variable, monospace">
                  {e.label}
                </text>
              </g>
            );
          })}
          {(Object.keys(NODES) as Tok[]).map((t) => {
            const node = NODES[t];
            const on = t === sel;
            return (
              <g key={t} className="tf-node cursor-pointer" onClick={() => setSel(t)} role="button" aria-label={t}>
                {on && <circle cx={node.x} cy={150} r={40} fill={node.color} opacity="0.35" filter="url(#tf-glow)" />}
                <circle cx={node.x} cy={150} r={34} fill="#0b0c10" stroke={node.color} strokeWidth={on ? 2.5 : 1.2} />
                <text x={node.x} y={154} textAnchor="middle" fontSize="11.5" fontWeight="700" fill={on ? "#ece8df" : "#b9b5ac"} fontFamily="Unbounded Variable, Unbounded, sans-serif">
                  {t}
                </text>
              </g>
            );
          })}
        </svg>
        <div ref={card} className="mt-2 grid grid-cols-1 gap-3 rounded-xl border border-white/[0.06] bg-black/25 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
          <div>
            <div className="label mb-1" style={{ color: n.color }}>
              {n.role}
            </div>
            <div className="text-[13px] leading-snug text-bone-dim">
              <span className="text-bone">Get it: </span>
              {n.get}
            </div>
          </div>
          <div className="text-[13px] leading-snug text-bone-dim">
            <span className="text-bone">Use it: </span>
            {n.use}
          </div>
          <Link to={n.to} className="btn h-10 px-4 text-[13px]">
            {n.cta} →
          </Link>
        </div>
      </div>
    </Stage>
  );
}
