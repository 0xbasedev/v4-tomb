import { useRef, useState } from "react";

import { Sigil } from "@/components/brand/Sigil";
import { ChainBadge } from "@/components/ChainBadge";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { PlannedBadge, Reason } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { REGISTRY } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Bridge — the multichain plan, clearly labelled as planned.
 *
 * The plan: Ultra passes and xSHARE become bridgeable, and every new chain
 * opens with its own Genesis carrying an Ultra pool and an xSHARE pool — one
 * new Genesis a month until xTOMB is on every chain that has a Uniswap v4
 * PoolManager and native USDC. None of it is in the merge-branch contracts:
 * the Genesis pass is soulbound and xSHARE has no bridge, so this page sends
 * nothing and makes no promise about dates or order.
 */
const CHAINS = REGISTRY.chains.filter((c) => !c.testnet && c.id !== 1);

export function Bridge() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root, []);
  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Bridge · planned"
        title="xTOMB on every chain"
        lede="The plan is a new Genesis every month on a new chain — each one with Ultra and xSHARE pools — until xTOMB is everywhere Uniswap v4 and native USDC are. Ultra passes and xSHARE are planned to move between them."
        aside={
          <div className="panel p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Status</span>
              <PlannedBadge label="Planned · not in the contracts" />
            </div>
            <p className="text-[13px] leading-relaxed text-bone-dim">
              Today's Genesis pass is soulbound and xSHARE has no bridge. Bridging needs new, audited contracts (an omnichain xSHARE token and a bridgeable Ultra pass). Nothing
              here sends a transaction.
            </p>
          </div>
        }
      />
      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-12 md:px-8">
        <GenesisCadence />

        <section>
          <SectionTitle kicker="Candidate chains" title="Uniswap v4 + native USDC" right={<span className="hidden font-mono text-[11px] text-ash sm:inline">config/official-infrastructure.json</span>} />
          <div data-reveal className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {CHAINS.map((c) => (
              <div key={c.id} className="panel flex items-center gap-3 p-3">
                <ChainBadge id={c.id} name={c.name} size={34} />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-bone">{c.name}</div>
                  <div className="font-mono text-[10.5px] text-ash">chain {c.id}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-ash">Listed because each has an official Uniswap v4 PoolManager and Circle-issued USDC. The launch order isn't decided.</p>
        </section>

        <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Plan icon="xSHARE" title="xSHARE moves between chains" body="Planned: one xSHARE supply across chains, so a holder can take xSHARE to the chain running Genesis. Needs an omnichain token contract." />
          <Plan icon="xTOMB" title="Ultra passes move too" body="Planned: a bridgeable version of the Ultra pass. The current pass is soulbound by design, so this is a new contract, not a setting." />
          <Plan icon="xTOMB-USDC" title="Every expansion opens with Genesis" body="Planned: each new chain's seven-day Genesis carries an Ultra pool and an xSHARE pool next to its own xTOMB/USDC launch." />
        </section>

        <BridgeForm />
      </div>
    </div>
  );
}

function Plan({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div data-reveal className="panel p-5">
      <div className="mb-3 flex items-center gap-2">
        <TokenIcon symbol={icon} size={28} />
        <PlannedBadge />
      </div>
      <h3 className="font-display text-[16px] font-semibold text-bone">{title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-bone-dim">{body}</p>
    </div>
  );
}

/**
 * Monthly Genesis, animated: chains sit on a ring around the xTOMB sigil. Each
 * "month" a Genesis pulse travels out from the centre, a seven-segment arc
 * fills on the next chain, and the chain lights up and stays lit. When every
 * chain is lit the ring glows — xTOMB everywhere — and the cycle replays.
 * The order shown is illustrative.
 */
function GenesisCadence() {
  const root = useRef<HTMLDivElement>(null);
  const [lit, setLit] = useState(CHAINS.length);
  const [month, setMonth] = useState<number | null>(null);
  const n = CHAINS.length;
  const W = 520;
  const C = W / 2;
  const R = 196;
  const pos = (i: number) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return { x: C + R * Math.cos(a), y: C + R * Math.sin(a) };
  };

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2, onRepeat: () => setLit(0) });
      tl.call(() => (setLit(0), setMonth(null)));
      tl.set(".gc-ring", { autoAlpha: 0.15 });
      for (let i = 0; i < n; i++) {
        const { x, y } = pos(i);
        tl.call(() => setMonth(i + 1))
          .fromTo(".gc-pulse", { attr: { cx: C, cy: C, r: 6 }, autoAlpha: 1 }, { attr: { cx: x, cy: y, r: 9 }, duration: 0.7, ease: EASE.rise, immediateRender: false })
          .fromTo(`.gc-arc-${i}`, { strokeDashoffset: 120 }, { strokeDashoffset: 0, duration: 0.9, ease: "none" })
          .call(() => setLit(i + 1))
          .fromTo(`.gc-ripple-${i}`, { attr: { r: 24 }, autoAlpha: 0.8 }, { attr: { r: 48 }, autoAlpha: 0, duration: 0.6, ease: "power2.out", immediateRender: false }, "<")
          .to(".gc-pulse", { autoAlpha: 0, duration: 0.15 });
      }
      tl.to(".gc-ring", { autoAlpha: 0.8, duration: 0.6 }).call(() => setMonth(null)).to({}, { duration: 1.6 });
      return () => tl.kill();
    },
    { scope: root },
  );

  return (
    <section data-reveal className="panel panel-raised overflow-hidden p-5 md:p-7">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="label">One Genesis a month</span>
            <PlannedBadge label="Illustrative" />
          </div>
          <h2 className="min-h-[2.6em] font-display text-xl font-semibold leading-tight text-bone sm:min-h-0 md:text-2xl">{month ? `Month ${month} · Genesis on ${CHAINS[month - 1].name}` : lit >= n ? "xTOMB everywhere" : "Next Genesis"}</h2>
        </div>
        <div className="font-mono text-[12px] text-ash">
          {Math.min(lit, n)}/{n} chains
        </div>
      </div>
      <div ref={root} className="grid grid-cols-1 items-center gap-6 lg:grid-cols-[1fr_280px]">
        <div className="relative mx-auto w-full max-w-[520px]">
          <svg viewBox={`0 0 ${W} ${W}`} className="w-full" aria-hidden>
            <circle className="gc-ring" cx={C} cy={C} r={R} fill="none" stroke="#ff6a2b" strokeWidth="1.5" strokeDasharray="2 7" opacity={0.8} />
            {CHAINS.map((_, i) => {
              const { x, y } = pos(i);
              return (
                <g key={i}>
                  <line x1={C} y1={C} x2={x} y2={y} stroke={i < lit ? "rgba(255,106,43,0.35)" : "rgba(255,255,255,0.05)"} strokeWidth="1" />
                  <circle className={`gc-arc-${i}`} cx={x} cy={y} r={28} fill="none" stroke={i < lit ? "#ff8a3d" : "rgba(255,255,255,0.08)"} strokeWidth="2.5" strokeDasharray="120" strokeDashoffset={i < lit ? 0 : 120} transform={`rotate(-90 ${x} ${y})`} />
                  <circle className={`gc-ripple-${i}`} cx={x} cy={y} r={24} fill="none" stroke="#ffb547" strokeWidth="1.5" opacity={0} />
                </g>
              );
            })}
            <circle className="gc-pulse" cx={C} cy={C} r={6} fill="#ffb547" opacity={0} />
          </svg>
          {/* chain badges over the SVG nodes */}
          {CHAINS.map((c, i) => {
            const { x, y } = pos(i);
            return (
              <span key={c.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${(x / W) * 100}%`, top: `${(y / W) * 100}%` }}>
                <ChainBadge id={c.id} name={c.name} size={36} lit={i < lit} />
              </span>
            );
          })}
          <span className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
            <Sigil size={56} glow />
            <span className="mt-1 font-display text-[13px] font-semibold text-bone">xTOMB</span>
          </span>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between px-1 font-mono text-[10.5px] text-ash">
            <span>Each one: 7-day Genesis</span>
            <span>Ultra + xSHARE pools</span>
          </div>
          <ol className="space-y-2">
            {CHAINS.slice(0, 6).map((c, i) => {
              const now = month === i + 1;
              const done = i < lit && !now;
              return (
                <li
                  key={c.id}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors duration-500 ${now ? "border-ember/60 bg-ember/[0.09]" : done ? "border-ember/25 bg-ember/[0.04]" : "border-white/[0.06]"}`}
                >
                  <span className="w-[52px] shrink-0 font-mono text-[11px] text-ash">Month {i + 1}</span>
                  <ChainBadge id={c.id} name={c.name} size={22} lit={i < lit || now} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-bone-dim" title={c.name}>
                    {c.name}
                  </span>
                  <span className={`shrink-0 font-mono text-[10px] ${now ? "text-ember-hot" : done ? "text-ok" : "text-ash-dim"}`}>{now ? "live" : done ? "✓" : "·"}</span>
                </li>
              );
            })}
            <li className="px-3 font-mono text-[11px] text-ash">…and on, one chain a month</li>
          </ol>
        </div>
      </div>
      <p className="mt-4 text-[12px] text-ash">Each expansion Genesis would run seven days with an Ultra pool and an xSHARE pool. Chain order and dates aren't set.</p>
    </section>
  );
}

function BridgeForm() {
  const [asset, setAsset] = useState<"xSHARE" | "Ultra pass">("xSHARE");
  return (
    <section data-reveal className="panel p-5 md:p-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-display text-lg font-semibold text-bone">Bridge</h2>
        <PlannedBadge />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-ash">Asset</span>
          <select value={asset} onChange={(e) => setAsset(e.target.value as typeof asset)} className="well px-2 py-2 text-bone" aria-label="Asset to bridge">
            <option>xSHARE</option>
            <option>Ultra pass</option>
          </select>
        </label>
        {(["From", "To"] as const).map((k, i) => (
          <label key={k} className="flex flex-col gap-1 text-[12.5px]">
            <span className="text-ash">{k}</span>
            <select disabled defaultValue={CHAINS[i]?.id} className="well px-2 py-2 text-bone-dim" aria-label={`${k} chain`}>
              {CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button type="button" disabled className="btn btn-primary mt-4 h-12 w-full">
        Bridge unavailable
      </button>
      <Reason>{asset === "Ultra pass" ? "The current Ultra pass is soulbound; a bridgeable pass needs a new contract." : "xSHARE has no bridge contract in the merge branch yet."}</Reason>
    </section>
  );
}
