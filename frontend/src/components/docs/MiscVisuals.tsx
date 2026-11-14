import { useRef, useState } from "react";

import { FireTaxChart } from "@/components/FireTaxChart";
import { recoveryFloorBps, sellTax, type TaxedAsset } from "@/lib/fireTax";
import { FIRE, pct } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { usd } from "@/lib/peg";
import { Segmented, Slider, Stage, useEnter } from "./kit";

/* ------------------------------------------------------------------------ */
/* Fire Tax explorer                                                        */
/* ------------------------------------------------------------------------ */

/** Move the TWAP, toggle Genesis, scrub time since a raised rate — read the one rate. */
export function FireTaxExplorer() {
  const [asset, setAsset] = useState<TaxedAsset>("xTOMB");
  const [ratio, setRatio] = useState(0.97);
  const [genesis, setGenesis] = useState(true);
  const [since, setSince] = useState(2);
  const raised = 900;
  const q = sellTax({ asset, twap: ratio, projected: ratio, raisedBps: raised, raisedAt: 0, now: since * 3600, genesisActive: genesis });
  const W = 520;
  const H = 90;
  const pts = Array.from({ length: 29 }, (_, i) => i / 4);
  const ry = (b: number) => 8 + (1 - b / 1300) * (H - 24);
  const rx = (h: number) => 30 + (h / 7) * (W - 40);
  return (
    <div className="space-y-3">
      <Stage>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Segmented options={[{ id: "xTOMB", label: "xTOMB" }, { id: "xSHARE", label: "xSHARE" }]} value={asset} onChange={setAsset} />
          <label className="flex items-center gap-2 text-[12px] text-bone-dim">
            <input type="checkbox" checked={genesis} onChange={(e) => setGenesis(e.target.checked)} /> During Genesis
          </label>
        </div>
        <FireTaxChart asset={asset} ratio={ratio} quote={q} genesisActive={genesis} />
        <div className="mt-3">
          <Slider id="ft-ratio" label="TWAP ÷ reference" value={ratio} min={0.8} max={1.05} step={0.005} onChange={setRatio} display={ratio.toFixed(3)} />
        </div>
      </Stage>
      <Stage caption={`Recovery: after a ${pct(raised)} rate is observed, the floor falls linearly back to ${pct(FIRE.baselineBps)} over ${FIRE.recoverySeconds / 3600} hours. Genesis floors never change this state.`}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label="Recovery floor over seven hours">
          <path d={pts.map((h, i) => `${i ? "L" : "M"} ${rx(h).toFixed(1)} ${ry(recoveryFloorBps(raised, 0, h * 3600)).toFixed(1)}`).join(" ")} fill="none" stroke="#b48cff" strokeWidth="2" />
          <circle cx={rx(since)} cy={ry(recoveryFloorBps(raised, 0, since * 3600))} r="5" fill="#050507" stroke="#ece8df" strokeWidth="2" />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((h) => (
            <text key={h} x={rx(h)} y={H - 2} textAnchor="middle" fontSize="9.5" fill="#7c7a74" fontFamily="JetBrains Mono Variable, monospace">
              {h}h
            </text>
          ))}
        </svg>
        <Slider id="ft-since" label="Hours since the raise" value={since} min={0} max={7} step={0.25} onChange={setSince} display={`${since}h · floor ${pct(recoveryFloorBps(raised, 0, since * 3600))}`} />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-black/30 p-3">
            <div className="label mb-0.5 text-ember">Sell $1,000 of {asset}</div>
            <div className="num text-lg text-bone">−{usd((1000 * (q.rateBps ?? 0)) / 10_000, 0)}</div>
            <div className="text-[11px] text-ash">{pct(q.rateBps ?? 0)} · {q.driver}</div>
          </div>
          <div className="rounded-xl bg-black/30 p-3">
            <div className="label mb-0.5 text-ok">Buy $1,000 of {asset}</div>
            <div className="num text-lg text-bone">−$0</div>
            <div className="text-[11px] text-ash">buys and transfers are never taxed</div>
          </div>
        </div>
      </Stage>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Risks                                                                    */
/* ------------------------------------------------------------------------ */

const RISKS: { title: string; likelihood: number; impact: number; what: string; mitigation: string }[] = [
  {
    title: "Unaudited contracts",
    likelihood: 4,
    impact: 5,
    what: "The Masonry contracts on the merge branch pass local tests with mocks and a local v4 PoolManager; they haven't been audited or fork-tested against deployed AMM behaviour.",
    mitigation: "Audit and fork-test before mainnet; rehearse the launch on a testnet; the Wizard blocks any plan that breaks a release invariant.",
  },
  {
    title: "Thin or manipulated oracle",
    likelihood: 3,
    impact: 4,
    what: "The xTOMB TWAP comes from one official pool. Thin liquidity or a quiet market can make it invalid, and a determined actor could try to move it.",
    mitigation: "The oracle needs adequate active liquidity across its window and a recent real swap; without a valid TWAP the hook rejects sells and nothing expands.",
  },
  {
    title: "Sells rejected",
    likelihood: 3,
    impact: 3,
    what: "With no valid TWAP — at startup, during an outage, in an inactive market — every official sell reverts until the oracle is fresh again.",
    mitigation: "Buys continue, liquidity stays redeemable, and the UI says why a sell is blocked instead of failing silently.",
  },
  {
    title: "Unofficial pools",
    likelihood: 3,
    impact: 2,
    what: "Anyone can create an xTOMB pool without the hook. Those pools charge no Fire Tax and don't feed the TWAP.",
    mitigation: "The app routes only through the official pools; the hook's protections apply there.",
  },
  {
    title: "Pending backends",
    likelihood: 5,
    impact: 2,
    what: "MasonryTreasury, MasonryFarm, MasonryChamber and MasonryBond exist in this checkout but have no verified launch addresses yet.",
    mitigation: "Those screens are labelled pending or planned and their actions are disabled with the reason.",
  },
  {
    title: "Fixed-range liquidity",
    likelihood: 2,
    impact: 3,
    what: "Each LP vault holds one fixed tick range. If price leaves it, deposits become one-sided and compounds may refund more.",
    mitigation: "Ranges are deployment choices sized in the Wizard; vault shares stay redeemable for both tokens at any time.",
  },
];

export function RiskMeters() {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<number | null>(0);
  useEnter(root, (tl) => {
    tl.from(".rk-card", { y: 14, autoAlpha: 0, duration: 0.45, stagger: 0.07, ease: EASE.rise }).from(
      ".rk-bar",
      { scaleX: 0, transformOrigin: "left", duration: 0.7, stagger: 0.05, ease: EASE.settle },
      "-=0.4",
    );
  });
  useGSAP(
    () => {
      gsap.utils.toArray<HTMLElement>(".rk-body", root.current).forEach((el) => {
        const on = el.dataset.idx === String(open);
        if (prefersReducedMotion()) gsap.set(el, { height: on ? "auto" : 0, opacity: on ? 1 : 0 });
        else gsap.to(el, { height: on ? "auto" : 0, opacity: on ? 1 : 0, duration: 0.35, ease: EASE.rise });
      });
    },
    { scope: root, dependencies: [open] },
  );
  return (
    <div ref={root} className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
      {RISKS.map((r, i) => (
        <button
          key={r.title}
          type="button"
          onClick={() => setOpen(open === i ? null : i)}
          className={`rk-card rounded-xl border p-4 text-left transition-colors ${open === i ? "border-bad/40 bg-bad/[0.05]" : "border-white/[0.06] bg-black/20 hover:border-white/15"}`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[14px] font-semibold text-bone">{r.title}</span>
            <span className="text-ash">{open === i ? "−" : "+"}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Meter label="Likelihood" v={r.likelihood} />
            <Meter label="Impact" v={r.impact} />
          </div>
          <div data-idx={i} className="rk-body overflow-hidden" style={{ height: 0, opacity: 0 }}>
            <p className="mt-3 text-[12.5px] leading-relaxed text-bone-dim">{r.what}</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ok/90">
              <span className="font-semibold">Mitigation · </span>
              {r.mitigation}
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}

function Meter({ label, v }: { label: string; v: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between font-mono text-[10px] text-ash">
        <span>{label}</span>
        <span>{v}/5</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5">
        <div className={`rk-bar h-full rounded-full ${v >= 4 ? "bg-bad" : v >= 3 ? "bg-warn" : "bg-ok"}`} style={{ width: `${(v / 5) * 100}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Glossary                                                                 */
/* ------------------------------------------------------------------------ */

export function Glossary({ terms }: { terms: { term: string; body: string; tag: string }[] }) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const tags = Array.from(new Set(terms.map((t) => t.tag)));
  const shown = terms.filter((t) => (!tag || t.tag === tag) && (`${t.term} ${t.body}`.toLowerCase().includes(q.trim().toLowerCase())));

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.fromTo(".gl-card", { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.35, stagger: 0.025, ease: EASE.rise });
    },
    { scope: grid, dependencies: [q, tag] },
  );

  const mark = (s: string) => {
    const needle = q.trim();
    if (!needle) return s;
    const i = s.toLowerCase().indexOf(needle.toLowerCase());
    if (i < 0) return s;
    return (
      <>
        {s.slice(0, i)}
        <mark className="rounded bg-ember/25 px-0.5 text-bone">{s.slice(i, i + needle.length)}</mark>
        {s.slice(i + needle.length)}
      </>
    );
  };

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="well flex-1 px-3 py-2">
          <input id="gl-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search terms…" className="text-[14px] text-bone" aria-label="Search the glossary" />
          {q && (
            <button type="button" onClick={() => setQ("")} className="font-mono text-[11px] text-ash">
              clear
            </button>
          )}
        </label>
        <div className="flex flex-wrap gap-1">
          {[null, ...tags].map((t) => (
            <button
              key={t ?? "all"}
              type="button"
              onClick={() => setTag(t)}
              className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] ${tag === t ? "border-ember/60 bg-ember/10 text-ember-hot" : "border-white/[0.07] text-ash hover:text-bone"}`}
            >
              {t ?? "all"}
            </button>
          ))}
        </div>
      </div>
      <div ref={grid} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {shown.map((t) => (
          <div key={t.term} className="gl-card rounded-xl border border-white/[0.06] bg-black/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-display text-[14px] font-semibold text-ember-hot">{mark(t.term)}</span>
              <span className="font-mono text-[9.5px] uppercase tracking-wider text-ash-dim">{t.tag}</span>
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-bone-dim">{mark(t.body)}</p>
          </div>
        ))}
        {shown.length === 0 && <p className="text-[13px] text-ash">No term matches “{q}”.</p>}
      </div>
    </div>
  );
}
