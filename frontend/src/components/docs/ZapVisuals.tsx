import { useMemo, useRef, useState } from "react";

import { AnimatedNumber } from "@/components/fx/AnimatedNumber";
import { TokenIcon } from "@/components/TokenIcon";
import { useProtocol } from "@/lib/hooks";
import { GENESIS_DAYS, LP_DAY } from "@/lib/genesis";
import { FIRE, GENESIS_POLICY, pct } from "@/lib/launch";
import { SIM_POOLS } from "@/lib/preview";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { usd } from "@/lib/peg";
import { planRoute, quoteRoute } from "@/lib/routes";
import { shortLabel, type TokenId } from "@/lib/tokens";
import { Slider, Stage } from "./kit";

/**
 * Routes, animated: pick a pair and the legs play one by one — the same
 * planner the Swap card uses, priced on $1,000 with the current (or
 * simulated) Fire Tax. Unsupported routes say why instead of animating.
 */
const PAIRS: [TokenId, TokenId][] = [
  ["USDC", "xTOMB"],
  ["xTOMB", "USDC"],
  ["xTOMB-USDC", "USDC"],
  ["xTOMB-USDC", "xTOMB"],
  ["xTOMB", "xSHARE"],
  ["ETH", "xTOMB"],
];

const SIM_POOL_FEE_BPS = SIM_POOLS.xTOMB.feeBps;

export function RoutePlayer() {
  const p = useProtocol();
  const [idx, setIdx] = useState(2);
  const root = useRef<HTMLDivElement>(null);
  const [input, output] = PAIRS[idx];
  const plan = planRoute(input, output, p.lpAssetShare);
  const amount = p.prices[input] ? 1000 / (p.prices[input] as number) : 0;
  const q = plan.ok ? quoteRoute(plan, input, output, amount, { prices: p.prices, poolFeeBps: p.poolFeeBps, taxFor: p.taxFor }) : null;

  useGSAP(
    () => {
      const chips = gsap.utils.toArray<HTMLElement>(".rp-step", root.current);
      if (!chips.length || prefersReducedMotion()) return;
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8 });
      chips.forEach((c) => {
        tl.to(c, { scale: 1.06, borderColor: "rgba(255,106,43,0.9)", backgroundColor: "rgba(255,106,43,0.14)", duration: 0.28, ease: EASE.snap }).to(
          c,
          { scale: 1, borderColor: "rgba(255,255,255,0.1)", backgroundColor: "rgba(0,0,0,0.25)", duration: 0.4 },
          "+=0.25",
        );
      });
      tl.fromTo(".rp-done", { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.3 }, "-=0.2").to(".rp-done", { autoAlpha: 0, duration: 0.3 }, "+=0.9");
      return () => tl.kill();
    },
    { scope: root, dependencies: [idx] },
  );

  return (
    <Stage caption="Each leg is one transaction on an official pool or vault. Only the leg that sells xTOMB or xSHARE pays the Fire Tax; pool fees are separate.">
      <div ref={root}>
        <div className="flex flex-wrap gap-1.5">
          {PAIRS.map(([a, b], i) => (
            <button
              key={`${a}-${b}`}
              type="button"
              onClick={() => setIdx(i)}
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-[11px] ${i === idx ? "border-ember/60 bg-ember/10 text-bone" : "border-white/[0.07] text-ash hover:text-bone"}`}
            >
              <TokenIcon symbol={a} size={14} />
              {shortLabel(a)} → {shortLabel(b)}
            </button>
          ))}
        </div>
        {plan.ok ? (
          <>
            <ol className="mt-4 flex flex-wrap items-center gap-1.5">
              {plan.legs.map((s, i) => (
                <li key={`${s.label}-${i}`} className="flex items-center gap-1.5">
                  <span className={`rp-step rounded-lg border border-white/10 bg-black/25 px-2 py-1 font-mono text-[11px] ${s.kind === "sell" ? "text-bad" : s.kind === "redeem" ? "text-spectre" : "text-ok"}`}>{s.label}</span>
                  {i < plan.legs.length - 1 && <span className="text-ash-dim">→</span>}
                </li>
              ))}
              <li className="rp-done ml-1 font-mono text-[11px] text-ok" style={{ opacity: 0 }}>
                ✓ received
              </li>
            </ol>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Cost k="You pay" v={usd(q?.valueInUsd ?? 1000, 0)} />
              <Cost k="Pool fees" v={`−${usd(q?.poolFeesUsd ?? 0, 2)}`} />
              <Cost k="Fire Tax" v={(q?.fireTaxUsd ?? 0) > 0 ? `−${usd(q?.fireTaxUsd, 2)}` : q?.blocked ? "rejected" : "$0"} bad={(q?.fireTaxUsd ?? 0) > 0 || !!q?.blocked} />
              <Cost k="You get" v={usd(q?.valueOutUsd, 2)} good />
            </div>
          </>
        ) : (
          <p className="mt-4 rounded-xl border border-warn/30 bg-warn/[0.05] p-3 text-[12.5px] text-bone-dim">
            <span className="font-semibold text-warn">Unavailable. </span>
            {plan.reason}
          </p>
        )}
      </div>
    </Stage>
  );
}

function Cost({ k, v, bad, good }: { k: string; v: string; bad?: boolean; good?: boolean }) {
  return (
    <div className="rounded-xl bg-black/30 p-2.5">
      <div className="label mb-0.5">{k}</div>
      <div className={`num text-[14px] ${bad ? "text-bad" : good ? "text-ok" : "text-bone"}`}>{v}</div>
    </div>
  );
}

/**
 * Claim vs compound over the Genesis LP window, drawn. Drag the APR; the gap
 * is what compounding the liquid half is worth after its real costs. Each run
 * reinvests the liquid half minus the sell leg's Fire Tax and pool fee (on
 * roughly half of it) and the LP fee (sent to the Treasury); the vested half accrues either way.
 */
export function CompoundCurve() {
  const [apr, setApr] = useState(1500);
  const root = useRef<HTMLDivElement>(null);
  const S = 1000;
  const startDay = LP_DAY - 1; // the LP pool opens at the start of Day 2
  const days = GENESIS_DAYS - startDay;
  const runsPerDay = 86_400 / GENESIS_POLICY.compoundCooldownSeconds;
  const W = 520;
  const H = 180;
  const perRun = apr / 100 / 365 / runsPerDay;
  const sellCost = 0.5 * ((FIRE.genesisFloorBps.xTOMB + SIM_POOL_FEE_BPS) / 10_000);
  const keep = GENESIS_POLICY.liquidShare * (1 - sellCost) * (1 - GENESIS_POLICY.lpBurnFeeBps / 10_000);
  const pts = useMemo(() => {
    const simple: number[] = [];
    const comp: number[] = [];
    let P = S;
    let vested = 0;
    for (let d = 0; d <= days; d++) {
      // Claim only: every reward accrues on the original stake; the liquid half pays the wallet fee.
      simple.push(S * (1 + (apr / 100 / 365) * d * (1 - GENESIS_POLICY.liquidShare * (GENESIS_POLICY.walletFeeBps / 10_000))));
      comp.push(P + vested);
      for (let r = 0; r < runsPerDay; r++) {
        const reward = P * perRun;
        vested += reward * (1 - GENESIS_POLICY.liquidShare);
        P += reward * keep;
      }
    }
    return { simple, comp };
  }, [apr, perRun, keep, days, runsPerDay]);
  const top = Math.max(...pts.comp, ...pts.simple);
  const x = (d: number) => 30 + (d / days) * (W - 40);
  const y = (v: number) => H - 20 - ((v - S) / Math.max(1, top - S)) * (H - 40);
  const line = (arr: number[]) => arr.map((v, d) => `${d === 0 ? "M" : "L"} ${x(d).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line(pts.comp)} L ${x(days)} ${y(pts.simple[days]!)} ${pts.simple
    .map((v, d) => [d, v] as const)
    .reverse()
    .map(([d, v]) => `L ${x(d).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ")} Z`;
  const gain = pts.comp[days]! - pts.simple[days]!;
  const worth = gain > 1;

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.utils.toArray<SVGPathElement>(".cc-line", root.current).forEach((p) => {
        const len = p.getTotalLength();
        gsap.fromTo(p, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 0.9, ease: "power2.out" });
      });
      gsap.fromTo(".cc-area", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.8, delay: 0.3 });
    },
    { scope: root, dependencies: [apr] },
  );

  return (
    <Stage
      caption={`$1,000 from Day ${LP_DAY} to the end of Genesis, compounded every ${GENESIS_POLICY.compoundCooldownSeconds / 3600}h. Each run reinvests the liquid half after the sell leg (${pct(FIRE.genesisFloorBps.xTOMB)} Genesis Fire Tax + pool fee on about half of it) and the ${pct(GENESIS_POLICY.lpBurnFeeBps)} LP fee to the Treasury; claims pay the ${pct(GENESIS_POLICY.walletFeeBps)} wallet fee instead. A keeper run also pays ${pct(GENESIS_POLICY.automationFeeBps)} of the liquid half.`}
    >
      <div ref={root}>
        <Slider id="cc-apr" label="Pool APR" value={apr} min={100} max={6000} step={100} onChange={setApr} display={`${apr.toLocaleString()}%`} accent="#34e3a0" />
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label="Simple versus compounded growth">
          <path className="cc-area" d={area} fill="rgba(52,227,160,0.14)" />
          <path className="cc-line" d={line(pts.simple)} fill="none" stroke="#7c7a74" strokeWidth="2" strokeDasharray="4 4" />
          <path className="cc-line" d={line(pts.comp)} fill="none" stroke="#34e3a0" strokeWidth="2.6" />
          {Array.from({ length: days + 1 }, (_, d) => (
            <text key={d} x={x(d)} y={H - 4} textAnchor="middle" fontSize="10" fill="#4a4945" fontFamily="JetBrains Mono Variable, monospace">
              {d === days ? "end" : `D${d + LP_DAY}`}
            </text>
          ))}
        </svg>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Cost k="Claim only" v={usd(pts.simple[days]!, 0)} />
          <Cost k="Compound every 3h" v={usd(pts.comp[days]!, 0)} good={worth} />
          <div className="rounded-xl bg-black/30 p-2.5">
            <div className="label mb-0.5">Difference</div>
            <AnimatedNumber value={gain} format={(n) => (n < 0 ? `−${usd(-n, 0)}` : usd(n, 0))} duration={0.6} className={`num text-[14px] ${worth ? "text-ok" : "text-warn"}`} />
          </div>
        </div>
        <p className={`mt-2 text-[12px] ${worth ? "text-ok" : "text-warn"}`}>
          {worth ? "At this APR the compounding gain beats the sell-leg and burn costs." : "At this APR the sell-leg and burn costs eat the gain — claiming is as good."}
        </p>
      </div>
    </Stage>
  );
}
