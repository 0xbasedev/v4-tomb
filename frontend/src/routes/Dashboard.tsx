import { useRef, useState } from "react";

import { GenesisStrip } from "@/components/GenesisStrip";
import { NextMove } from "@/components/NextMove";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { PegGauge } from "@/components/PegGauge";
import { PendingBadge, PlannedBadge, SimBadge } from "@/components/Status";
import { DRIVER_LABEL, targetBps } from "@/lib/fireTax";
import { fmtDuration } from "@/lib/genesis";
import { useProtocol } from "@/lib/hooks";
import { DEFENSE, EXPANSION, FIRE, POLICY, SQUARE_ROUTING, SQUARE_SUPPLY, pct } from "@/lib/launch";
import { PHASE_META, expansionCap, marketPhase } from "@/lib/market";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { useReveal } from "@/lib/motion/useReveal";
import { usePreview } from "@/lib/preview";

/**
 * Dashboard — the peg, the planned expansion rule, Critical Defense, xSHARE
 * fee routing and the configured supply, each reading the launch config and
 * (once deployed) the contracts. Sample values carry a Simulated badge.
 */

const fmt = (n: number | null, d = 2) => (n === null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d }));
/** Sample circulating xTOMB for the expansion-cap illustration (no supply binding yet). */
const SIM_CIRCULATING = 4_200_000;

export function Dashboard() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  const preview = usePreview();
  const m = p.market;
  useReveal(root, []);
  const meta = PHASE_META[m.phase];
  const age = m.observedAt !== null ? Math.max(0, p.now - m.observedAt) : null;
  const xt = p.taxFor("xTOMB", 1_000);
  const xs = p.taxFor("xSHARE", 1_000);
  const cap = p.sim ? expansionCap(SIM_CIRCULATING, m.twap, m.fresh) : null;

  return (
    <div ref={root}>
      <PageHeader
        eyebrow={p.sim ? "Dashboard · simulated data" : "Dashboard"}
        title="The peg, on one screen"
        lede="Inspect the validated TWAP, the planned expansion rule, Critical Defense and where xSHARE's sell tax goes."
        aside={
          <div className="panel panel-raised p-5 lg:w-[440px]">
            <div className="mb-1 flex items-center justify-between">
              <span className="label">xTOMB peg monitor</span>
              {p.sim ? <SimBadge /> : <span className="chip chip-ok h-6">Live</span>}
            </div>
            <PegGauge price={m.twap ?? 0} phase={m.phase} simulated={p.sim} idleLabel="No valid TWAP" />
          </div>
        }
      />

      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-8 md:px-8">
        <GenesisStrip />

        {/* The interface's opinion comes first: one move, one alternative, one thing to avoid. */}
        <section>
          <NextMove />
        </section>

        {/* ===== State ===== */}
        <section data-reveal className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="panel p-5 lg:col-span-2">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className={`chip ${meta.chip}`}>
                <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-current" />
                {meta.label}
              </span>
              {p.sim && <SimBadge />}
            </div>
            <h2 className="font-display text-xl font-semibold text-bone">{meta.title}</h2>
            <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-bone-dim">{meta.detail}</p>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
              <Fact k="Validated TWAP" v={m.twap !== null ? `$${m.twap.toFixed(4)}` : "—"} />
              <Fact k="Observed" v={age !== null ? `${fmtDuration(age)} ago` : "—"} tone={m.fresh ? "" : "text-warn"} />
              <Fact k="xTOMB sell tax" v={xt.rateBps !== null ? pct(xt.rateBps) : "rejected"} sub={xt.driver ? DRIVER_LABEL[xt.driver] : undefined} />
              <Fact k="xSHARE sell tax" v={xs.rateBps !== null ? pct(xs.rateBps) : "rejected"} sub={xs.driver ? DRIVER_LABEL[xs.driver] : undefined} />
            </dl>
          </div>
          <WhatIf />
        </section>

        {/* ===== Expansion + Defense ===== */}
        <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div data-reveal className="panel p-5">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="label">Expansion rule</span>
              <PlannedBadge label="Planned · mint not bound" />
            </div>
            <h3 className="font-display text-lg font-semibold text-bone">
              Fresh validated TWAP strictly above ${EXPANSION.gate.toFixed(2)}
            </h3>
            <p className="mt-1 text-[13.5px] leading-relaxed text-bone-dim">
              An eligible six-hour epoch may mint at most {pct(EXPANSION.maxPerEpochBps)} of circulating xTOMB. No spot fallback, no catch-up for
              missed epochs, nothing when the oracle is stale. There are no unconditional bootstrap epochs.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 text-[13px]">
              <Fact k="This epoch" v={m.fresh && m.twap !== null && m.twap > EXPANSION.gate ? "eligible" : "not eligible"} tone={m.fresh && m.twap !== null && m.twap > EXPANSION.gate ? "text-ember-hot" : "text-ash"} />
              <Fact k={p.sim ? "Cap on sample supply" : "Cap this epoch"} v={cap !== null ? `${fmt(cap, 0)} xTOMB` : "needs supply binding"} sub={p.sim ? `${pct(EXPANSION.maxPerEpochBps)} of ${SIM_CIRCULATING.toLocaleString()} (sample)` : undefined} />
            </div>
          </div>

          <div data-reveal id="defense" className={`panel p-5 ${m.defense.active ? "border-bad/40" : ""}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="label">Critical Defense</span>
              <span className={`chip h-6 ${m.defense.active ? "chip-bad" : ""}`}>{m.defense.active ? "Active" : "Inactive"}</span>
              {p.sim && <SimBadge />}
            </div>
            <h3 className="font-display text-lg font-semibold text-bone">
              Enters at a fresh TWAP ≤ ${DEFENSE.enterAt.toFixed(2)}
            </h3>
            <p className="mt-1 text-[13.5px] leading-relaxed text-bone-dim">
              While active, 100% of new xSHARE sell tax buys and burns xTOMB; earlier earmarks keep their purpose. It exits after {DEFENSE.recoveryEpochs}{" "}
              consecutive real six-hour checkpoints with a fresh TWAP strictly above ${DEFENSE.exitAbove.toFixed(2)}. Stale data never ends it.
            </p>
            <div className="mt-4">
              <div className="mb-1 flex justify-between font-mono text-[11px] text-ash">
                <span>Recovery checkpoints</span>
                <span>
                  {m.defense.active ? m.defense.checkpoints : 0}/{DEFENSE.recoveryEpochs}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {Array.from({ length: DEFENSE.recoveryEpochs }, (_, i) => (
                  <div key={i} className={`h-2 rounded-full ${m.defense.active && i < m.defense.checkpoints ? "bg-ok" : "bg-white/[0.07]"}`} />
                ))}
              </div>
              <p className="mt-2 font-mono text-[10.5px] text-ash-dim">Oracle max age for defense decisions: {DEFENSE.oracleMaxAgeSeconds / 60} min</p>
            </div>
          </div>
        </section>

        {/* ===== xSHARE fee routing ===== */}
        <section>
          <SectionTitle kicker="xSHARE sell tax" title="Where the fee goes" right={p.sim ? <SimBadge /> : undefined} />
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Routing
              title="Normal routing"
              active={!m.defense.active}
              note="Shares of the collected tax, not of the sale."
              rows={[
                { k: "Protocol-owned xSHARE/USDC LP", bps: SQUARE_ROUTING.polBps, tone: "bg-spectre" },
                { k: "USDC reserve (sold for USDC)", bps: SQUARE_ROUTING.usdcReserveBps, tone: "bg-[#5b9dff]" },
                { k: "Retained xSHARE reserve", bps: SQUARE_ROUTING.squareReserveBps, tone: "bg-amethyst" },
              ]}
              balances={[
                ["Earmarked for POL", p.hooks.xSHARE.pol, "xSHARE"],
                ["Earmarked for USDC reserve", p.hooks.xSHARE.usdcReserve, "xSHARE"],
                ["Retained", p.hooks.xSHARE.retained, "xSHARE"],
                ["USDC routed", p.hooks.xSHARE.usdcRouted, "USDC"],
              ]}
            />
            <Routing
              title="Critical Defense"
              active={m.defense.active}
              note="Only new eligible fee revenue; prior earmarks, user capital and Treasury principal are untouched."
              rows={[{ k: "xSHARE → USDC → xTOMB, burned", bps: 10_000, tone: "bg-bad" }]}
              balances={[
                ["Earmarked for buy-and-burn", p.hooks.xSHARE.critical, "xSHARE"],
                ["xTOMB burned by xSHARE routing", p.hooks.xSHARE.levelBurned, "xTOMB"],
              ]}
            />
          </div>
          <p className="mt-3 text-[12px] text-ash">
            xTOMB's own sell tax is separate: burned in full during Genesis, sent to the hook's fee recipient afterwards. Treasury-held xTOMB is never sold for
            fee routing.
          </p>
        </section>

        {/* ===== Supply ===== */}
        <section data-reveal className="panel p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="label mb-1">xSHARE supply</div>
              <h3 className="font-display text-lg font-semibold text-bone">Configured cap: {SQUARE_SUPPLY.cap.toLocaleString()} xSHARE</h3>
            </div>
            <span className="font-mono text-[11px] text-ash">config/masonry-launch.template.json</span>
          </div>
          <SupplyBar />
        </section>

      </div>
      {preview.enabled && <span className="sr-only">Values on this page are simulated.</span>}
    </div>
  );
}

function Fact({ k, v, sub, tone = "" }: { k: string; v: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-black/25 p-3">
      <dt className="label mb-1">{k}</dt>
      <dd className={`num text-[15px] text-bone ${tone}`}>{v}</dd>
      {sub && <dd className="mt-0.5 text-[11px] text-ash">{sub}</dd>}
    </div>
  );
}

/** Pick a price and read what the protocol does there — independent of the live state. */
function WhatIf() {
  const preview = usePreview();
  const [price, setPrice] = useState(1.0);
  const presets: [string, number][] = [
    ["Defense", 0.88],
    ["Below", 0.95],
    ["Peg", 1.0],
    ["Above gate", 1.03],
  ];
  const phase = marketPhase({ twap: price, fresh: true, defenseActive: price <= DEFENSE.enterAt });
  const text: Record<string, string> = {
    defense: "At or below the Critical Defense threshold.",
    tax: "Below peg: the Fire Tax target rises toward the cap.",
    band: "Inside the band: no expansion, baseline tax.",
    expansion: "Above the expansion price gate — planned mint of up to 2% per eligible epoch.",
  };
  return (
    <div data-reveal className="panel p-5">
      <div className="label mb-2">What happens at…</div>
      <div className="flex flex-wrap gap-1">
        {presets.map(([l, v]) => (
          <button
            key={l}
            type="button"
            onClick={() => {
              setPrice(v);
              if (preview.enabled) preview.setTwap(v);
            }}
            className={`rounded-lg border px-2.5 py-1.5 text-[12px] ${price === v ? "border-ember/60 bg-ember/10 text-ember-hot" : "border-white/[0.08] text-ash hover:text-bone"}`}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="mt-4 num text-2xl text-bone">${price.toFixed(2)}</div>
      <p className="mt-1 text-[13.5px] text-bone-dim">{text[phase]}</p>
      <p className="mt-2 font-mono text-[11px] text-ash">Fire Tax target here: {pct(targetBps(price))}</p>
      {preview.enabled && <p className="mt-2 text-[11px] text-ash-dim">In Preview this also moves the simulated TWAP.</p>}
    </div>
  );
}

function Routing({
  title,
  active,
  note,
  rows,
  balances,
}: {
  title: string;
  active: boolean;
  note: string;
  rows: { k: string; bps: number; tone: string }[];
  balances: [string, number | null, string][];
}) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.fromTo(".rt-bar", { scaleX: 0 }, { scaleX: 1, transformOrigin: "left", duration: 0.8, stagger: 0.08, ease: EASE.settle });
    },
    { scope: root, dependencies: [active] },
  );
  return (
    <div ref={root} data-reveal className={`panel p-5 transition-opacity ${active ? "" : "opacity-55"}`}>
      <div className="mb-3 flex items-center justify-between">
        <span className="font-display text-[16px] font-semibold text-bone">{title}</span>
        <span className={`chip h-6 ${active ? "chip-ok" : ""}`}>{active ? "In effect" : "Standby"}</span>
      </div>
      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.k}>
            <div className="mb-1 flex justify-between text-[12.5px]">
              <span className="text-bone-dim">{r.k}</span>
              <span className="num text-bone">{pct(r.bps)}</span>
            </div>
            <div className="h-2 rounded-full bg-white/[0.05]">
              <div className={`rt-bar h-full rounded-full ${r.tone}`} style={{ width: `${r.bps / 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-ash">{note}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-white/5 pt-3">
        {balances.map(([k, v, u]) => (
          <div key={k}>
            <dt className="text-[11px] text-ash">{k}</dt>
            <dd className="num text-[13px] text-bone">
              {fmt(v)} <span className="text-[10.5px] text-ash">{u}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SupplyBar() {
  const v = SQUARE_SUPPLY.vesting;
  const vested = Object.values(v).every((x) => x !== null) ? Object.values(v).reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  const initial = SQUARE_SUPPLY.initial.ownerTeamDeveloper + SQUARE_SUPPLY.initial.treasury + SQUARE_SUPPLY.initial.arbitrage;
  const deployerDao = SQUARE_SUPPLY.deployer + SQUARE_SUPPLY.initial.deployerDao;
  const assigned = SQUARE_SUPPLY.farming + SQUARE_SUPPLY.saleEscrow + deployerDao + initial;
  const rest = SQUARE_SUPPLY.cap - assigned;
  const parts: { k: string; n: number; tone: string; note?: string }[] = [
    { k: "Farming emissions", n: SQUARE_SUPPLY.farming, tone: "bg-spectre" },
    { k: "Initial (owner/team/dev · Treasury · arbitrage)", n: initial, tone: "bg-[#5b9dff]" },
    { k: "Sale escrow", n: SQUARE_SUPPLY.saleEscrow, tone: "bg-ember" },
    { k: "Deployer / DAO (liquid)", n: deployerDao, tone: "bg-bone" },
    { k: vested === null ? "Vesting buckets — set in the Wizard" : `Vesting · ${POLICY.operationalVestingDays}-day linear (team ${(v.team ?? 0).toLocaleString()} · developer ${(v.developer ?? 0).toLocaleString()} · Treasury ${(v.treasury ?? 0).toLocaleString()} · arbitrage ${(v.arbitrage ?? 0).toLocaleString()})`, n: rest, tone: "bg-amethyst", note: vested === null ? "unset" : undefined },
  ];
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.05]">
        {parts.map((x) => (
          <div key={x.k} className={`${x.tone} ${x.note ? "opacity-40" : ""}`} style={{ width: `${(x.n / SQUARE_SUPPLY.cap) * 100}%` }} title={x.k} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-1.5 text-[12.5px] sm:grid-cols-2 lg:grid-cols-3">
        {parts.map((x) => (
          <li key={x.k} className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-sm ${x.tone} ${x.note ? "opacity-40" : ""}`} />
            <span className="text-bone-dim">{x.k}</span>
            <span className="num ml-auto text-bone">{x.n.toLocaleString()}</span>
          </li>
        ))}
      </ul>
      {vested === null && (
        <p className="mt-2 flex items-center gap-2 text-[12px] text-ash">
          <PendingBadge label="Unset" /> The template leaves Team, Developer, Treasury and Arbitrage vesting at null; deploy is blocked until they reconcile to the cap.
        </p>
      )}
      <p className="mt-1 font-mono text-[10.5px] text-ash-dim">Fire Tax cap {pct(FIRE.capBps)} applies to both assets.</p>
    </div>
  );
}
