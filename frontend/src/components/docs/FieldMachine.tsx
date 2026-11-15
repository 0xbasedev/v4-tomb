import { useRef, useState } from "react";

import { DEFENSE, EPOCH_SECONDS, EXPANSION, FIRE, POLICY, pct } from "@/lib/launch";
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { PEG } from "@/lib/peg";

/**
 * The machine and the defense routes, ported from the Masonry field guide:
 * a three-stop loop (Genesis → Farm → Masonry) with orbiting dots and a
 * flowing ring, and two sell-tax route diagrams with dashes running down the
 * pipes. Copy and numbers are xTOMB's own, read from the launch config.
 */

const EMBER = "rgb(var(--ember-rgb))";
const HOT = "rgb(var(--ember-hot-rgb))";
const SPECTRE = "#3ee7ff";
const HOURS = EPOCH_SECONDS / 3600;

interface StageDef {
  node: string;
  nodeNote: string;
  status: string;
  title: string;
  body: string;
  provide: string;
  earn: string;
  next: string;
}

const STAGES: StageDef[] = [
  {
    node: "Genesis",
    nodeNote: "Earn xTOMB",
    status: "Pass-gated · 7 days",
    title: "It starts with Genesis.",
    body: `Seven days, open to Genesis pass holders. Stake ${PEG.symbol} in the standard pool from Day 1, or xTOMB/${PEG.symbol} LP from Day 2. Every reward is half liquid and half vested.`,
    provide: `A pass, then ${PEG.symbol} or xTOMB/${PEG.symbol} LP`,
    earn: "xTOMB",
    next: "Next: put LP to work in the Farm.",
  },
  {
    node: "Farm",
    nodeNote: "LP → xSHARE",
    status: "After Genesis",
    title: "Put liquidity to work.",
    body: "Stake LP in the Farm and earn xSHARE as it streams. Farm-earned xSHARE is never paid to a wallet: Send to Masonry turns it into xSHARE/WETH LP and stakes it for you.",
    provide: "Farm LP",
    earn: "xSHARE",
    next: "Next: Send to Masonry, which stakes xSHARE/WETH LP.",
  },
  {
    node: "Masonry",
    nodeNote: "LP → xTOMB",
    status: "Stake and repeat",
    title: "Enter the inner chamber.",
    body: `Stake xSHARE/WETH LP to earn expansion xTOMB. An epoch lasts ${HOURS} hours and only starts when someone pays the $${POLICY.epochAdvanceFeeUsd} fee; it mints up to ${pct(EXPANSION.maxPerEpochBps)} when a fresh TWAP is above $${EXPANSION.gate.toFixed(2)}. Deposits pay a 0.5% fee.`,
    provide: "xSHARE/WETH LP",
    earn: "xTOMB",
    next: `Repeat: pair earned xTOMB with ${PEG.symbol} and go back to the Farm.`,
  },
];

const NODE_POS = ["left-1/2 top-[7%] -translate-x-1/2", "right-[6%] bottom-[14%]", "left-[6%] bottom-[14%]"];

export function Flywheel() {
  const root = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState(0);
  const s = STAGES[stage];

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.to(".fm-dots", { rotation: 360, duration: 26, repeat: -1, ease: "none", svgOrigin: "310 275" });
      gsap.to(".fm-flow", { strokeDashoffset: -420, duration: 22, repeat: -1, ease: "none" });
    },
    { scope: root },
  );

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.fromTo(".fm-swap", { y: 9, opacity: 0.25 }, { y: 0, opacity: 1, duration: 0.4, stagger: 0.04, overwrite: true });
    },
    { scope: root, dependencies: [stage] },
  );

  return (
    <div ref={root} className="grid grid-cols-1 overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-basalt-2 to-black/40 lg:grid-cols-[1.15fr_1fr]">
      <div className="relative grid min-h-[400px] items-center" style={{ background: "radial-gradient(ellipse at center, rgb(var(--ember-rgb) / 0.14), transparent 65%)" }}>
        <svg viewBox="0 0 620 530" className="block max-h-[520px] w-full" role="img" aria-label="Genesis earns xTOMB, the Farm earns xSHARE, the Masonry earns xTOMB again">
          <defs>
            <linearGradient id="fm-loop">
              <stop stopColor={SPECTRE} />
              <stop offset=".5" stopColor={EMBER} />
              <stop offset="1" stopColor={HOT} />
            </linearGradient>
          </defs>
          <circle cx="310" cy="275" r="175" fill="none" stroke="rgba(255,255,255,0.16)" />
          <circle cx="310" cy="275" r="142" fill="none" stroke="rgba(255,255,255,0.08)" strokeDasharray="3 8" />
          <path className="fm-flow" d="M310 100 A175 175 0 1 1 309 100" fill="none" stroke="url(#fm-loop)" strokeWidth="2" strokeDasharray="12 9" />
          <g className="fm-dots">
            <circle cx="310" cy="100" r="6" fill={EMBER} />
            <circle cx="462" cy="362" r="5" fill={SPECTRE} />
            <circle cx="158" cy="362" r="5" fill={HOT} />
          </g>
          <text x="310" y="251" textAnchor="middle" fontSize="12" letterSpacing="2" fill="#9a9aa6" fontFamily="JetBrains Mono Variable, monospace">
            XTOMB
          </text>
          <text x="310" y="293" textAnchor="middle" fontSize="40" letterSpacing="-2" fill="#f0eaf8" fontWeight="500">
            Repeat.
          </text>
          <text x="310" y="325" textAnchor="middle" fontSize="13" fill="#9a9aa6">
            Put rewards back to work
          </text>
        </svg>
        {STAGES.map((st, i) => (
          <button
            key={st.node}
            type="button"
            onClick={() => setStage(i)}
            aria-pressed={i === stage}
            className={`absolute flex min-h-[96px] w-[128px] flex-col items-center justify-center rounded-xl border shadow-[0_10px_35px_rgba(0,0,0,0.45)] transition-colors md:w-[148px] ${NODE_POS[i]} ${
              i === stage ? "border-ember/70 bg-ember/[0.16]" : "border-white/15 bg-basalt-2 hover:border-ember/50"
            }`}
          >
            <span className="font-mono text-[11px] tracking-[0.1em] text-ember-hot">0{i + 1}</span>
            <b className="my-1 font-display text-[19px] font-medium text-bone">{st.node}</b>
            <small className="text-[12px] text-ash">{st.nodeNote}</small>
          </button>
        ))}
      </div>

      <div className="border-t border-white/[0.07] bg-black/20 p-7 md:p-9 lg:border-l lg:border-t-0" aria-live="polite">
        <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.1em] text-ash">
          <span>Stage 0{stage + 1}</span>
          <span className="rounded-full border border-ember/40 px-2.5 py-1 text-[10px] text-ember-hot">{s.status}</span>
        </div>
        <div className="my-3 font-display text-[64px] font-medium leading-none text-ember opacity-70">0{stage + 1}</div>
        <h3 className="fm-swap font-display text-[26px] font-medium leading-tight tracking-[-0.03em] text-bone">{s.title}</h3>
        <p className="fm-swap mt-4 text-[14.5px] leading-relaxed text-bone-dim">{s.body}</p>
        <div className="fm-swap my-6 flex items-center gap-5 border-y border-white/[0.07] py-4">
          <div className="flex-1">
            <small className="block font-mono text-[10px] uppercase tracking-[0.08em] text-ash">You provide</small>
            <b className="text-[13.5px] font-semibold text-bone">{s.provide}</b>
          </div>
          <span className="text-ember-hot">→</span>
          <div className="flex-1">
            <small className="block font-mono text-[10px] uppercase tracking-[0.08em] text-ash">You earn</small>
            <b className="text-[13.5px] font-semibold text-bone">{s.earn}</b>
          </div>
        </div>
        <p className="text-[12.5px] leading-relaxed text-ash">{s.next}</p>
        <button type="button" onClick={() => setStage((stage + 1) % STAGES.length)} className="mt-5 text-[14px] font-semibold text-ember-hot hover:underline">
          Follow the rewards →
        </button>
      </div>
    </div>
  );
}

function RouteCard({ kicker, title, foot, traced, idle, children }: { kicker: string; title: string; foot: string; traced: string; idle: string; children: React.ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const [done, setDone] = useState(false);

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.to(".fm-pipe", { strokeDashoffset: -160, duration: 7, repeat: -1, ease: "none" });
    },
    { scope: root },
  );

  const trace = () => {
    setDone(true);
    if (prefersReducedMotion() || !root.current) return;
    gsap.fromTo(root.current.querySelectorAll(".fm-node"), { opacity: 0.35 }, { opacity: 1, duration: 0.45, stagger: 0.35, overwrite: true });
    gsap.fromTo(root.current.querySelectorAll(".fm-pipe"), { strokeWidth: 5 }, { strokeWidth: 2, duration: 1.8, overwrite: "auto" });
  };

  return (
    <article ref={root} className="rounded-2xl border border-white/[0.08] bg-gradient-to-br from-basalt-2 to-black/40 p-6 md:p-7">
      <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ember-hot">{kicker}</p>
      <h3 className="font-display text-[24px] font-medium tracking-[-0.03em] text-bone">{title}</h3>
      {children}
      <div className="flex flex-wrap items-center justify-between gap-3 text-[13.5px] text-bone-dim">
        <span>{foot}</span>
        <button type="button" onClick={trace} className="rounded-md border border-ember/40 bg-ember/[0.10] px-3 py-2 text-[12.5px] text-ember-hot hover:bg-ember/20">
          Trace route ↗
        </button>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ash" aria-live="polite">
        {done ? traced : idle}
      </p>
    </article>
  );
}

const NODE_FILL = "#17171f";
const note = { fontSize: 13, fill: "#9a9aa6", textAnchor: "middle" as const };
const glyph = { fontSize: 26, fill: "#e6dcf5", textAnchor: "middle" as const, fontWeight: 500 };

export function DefenseRoutes() {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <RouteCard
        kicker="xTOMB sell tax"
        title="Feed the fire."
        foot="Taxed xTOMB is destroyed."
        idle={`${pct(FIRE.baselineBps)} at peg, rising to ${pct(FIRE.capBps)} at $${FIRE.fullTaxAt.toFixed(2)}. Burning cuts supply; it does not guarantee a price.`}
        traced="Route traced: the taxed part of every xTOMB sell is burned in full."
      >
        <svg viewBox="0 0 560 245" className="my-3 block w-full" role="img" aria-label="An xTOMB sale pays the Fire Tax, and the tax is burned">
          <path d="M75 120H485" stroke="rgba(255,255,255,0.12)" strokeWidth="2" fill="none" />
          <path className="fm-pipe" d="M75 120H485" stroke={EMBER} strokeWidth="2" strokeDasharray="7 9" fill="none" />
          <g className="fm-node">
            <circle cx="80" cy="120" r="44" fill={NODE_FILL} stroke={EMBER} />
            <text x="80" y="129" {...glyph}>
              ▲
            </text>
          </g>
          <g className="fm-node">
            <circle cx="280" cy="120" r="44" fill={NODE_FILL} stroke={EMBER} />
            <text x="280" y="129" {...glyph}>
              %
            </text>
          </g>
          <g className="fm-node">
            <circle cx="480" cy="120" r="44" fill="#29191b" stroke="#f87171" />
            <text x="480" y="129" {...glyph} fill="#fca5a5">
              −
            </text>
          </g>
          <text x="80" y="196" {...note}>
            xTOMB SALE
          </text>
          <text x="280" y="196" {...note}>
            FIRE TAX
          </text>
          <text x="480" y="196" {...note}>
            BURN
          </text>
        </svg>
      </RouteCard>

      <RouteCard
        kicker="xSHARE sell tax"
        title="Two destinations."
        foot={`It switches at $${DEFENSE.enterAt.toFixed(2)}.`}
        idle={`Above $${DEFENSE.enterAt.toFixed(2)} the tax is sold for ${PEG.symbol} and paid to the DAO wallet. In Critical Defense it buys xTOMB and burns it.`}
        traced={`Route traced: normal times → ${PEG.symbol} to the DAO wallet. At or below $${DEFENSE.enterAt.toFixed(2)} → buy xTOMB → burn.`}
      >
        <svg viewBox="0 0 560 245" className="my-3 block w-full" role="img" aria-label="xSHARE sell tax goes to the DAO wallet in normal times and buys and burns xTOMB in Critical Defense">
          <path d="M65 120H150L225 55H485M150 120L225 185H485" stroke="rgba(255,255,255,0.12)" strokeWidth="2" fill="none" />
          <path className="fm-pipe" d="M65 120H150L225 55H485" stroke={SPECTRE} strokeWidth="2" strokeDasharray="7 9" fill="none" />
          <path className="fm-pipe" d="M150 120L225 185H485" stroke={EMBER} strokeWidth="2" strokeDasharray="7 9" fill="none" />
          <g className="fm-node">
            <circle cx="65" cy="120" r="39" fill={NODE_FILL} stroke={SPECTRE} />
            <text x="65" y="129" {...glyph}>
              ◇
            </text>
          </g>
          <g className="fm-node">
            <rect x="236" y="25" width="150" height="60" rx="12" fill={NODE_FILL} stroke={SPECTRE} />
            <text x="311" y="50" fontSize="13" fill="#e6dcf5" textAnchor="middle">
              Sold for {PEG.symbol}
            </text>
            <text x="311" y="70" {...note} fontSize={11}>
              ABOVE ${DEFENSE.enterAt.toFixed(2)}
            </text>
            <rect x="236" y="155" width="150" height="60" rx="12" fill={NODE_FILL} stroke={EMBER} />
            <text x="311" y="180" fontSize="13" fill="#e6dcf5" textAnchor="middle">
              Buys xTOMB
            </text>
            <text x="311" y="200" {...note} fontSize={11}>
              CRITICAL DEFENSE
            </text>
          </g>
          <g className="fm-node">
            <circle cx="490" cy="55" r="34" fill={NODE_FILL} stroke={SPECTRE} />
            <text x="490" y="61" fontSize="15" fill="#e6dcf5" textAnchor="middle" fontWeight="500">
              DAO
            </text>
            <circle cx="490" cy="185" r="34" fill="#29191b" stroke="#f87171" />
            <text x="490" y="194" {...glyph} fill="#fca5a5">
              −
            </text>
          </g>
        </svg>
      </RouteCard>
    </div>
  );
}

/** The field guide's section opener: numbered kicker, two-line heading, a short aside. */
export function FieldHead({ kicker, line1, line2, children }: { kicker: string; line1: string; line2: string; children: React.ReactNode }) {
  return (
    <div className="scroll-in mb-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="mb-5 font-mono text-[12px] uppercase tracking-[0.14em] text-ember-hot">{kicker}</p>
        <h2 className="font-display text-[clamp(2.4rem,4.6vw,4.4rem)] font-medium leading-[1.06] tracking-[-0.05em] text-bone">
          {line1}
          <br />
          <span className="text-ember">{line2}</span>
        </h2>
      </div>
      <p className="max-w-sm text-[15.5px] leading-relaxed text-bone-dim">{children}</p>
    </div>
  );
}
