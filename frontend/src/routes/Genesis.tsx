import { useRef } from "react";
import { Link } from "react-router-dom";

import { Countdown } from "@/components/Countdown";
import { FarmPoolCard } from "@/components/FarmPoolCard";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { StatTile } from "@/components/StatTile";
import { NotDeployed, RuleBadge } from "@/components/Status";
import { formatDate, toNumber } from "@/lib/format";
import { useProtocol } from "@/lib/hooks";
import { useReveal } from "@/lib/motion/useReveal";
import { EMISSIONS, NAMES } from "@/lib/protocol";

const PHASE_COPY = {
  unknown: { chip: "", label: "Not deployed", line: "Genesis has no schedule on this network." },
  upcoming: { chip: "chip-iris", label: "Opens soon", line: "Deposits can be made now and start earning the moment the window opens." },
  live: { chip: "chip-ok", label: "Live", line: "Emissions are running. Rewards accrue every second to the deposits in each pool." },
  ended: { chip: "", label: "Ended", line: "The 24 hours are over. Nothing more accrues — withdraw your deposit and claim what you earned." },
} as const;

/**
 * Genesis — GenesisRewardPool. One 24-hour window, before the first epoch,
 * paying a fixed 11,000 of the peg token to whoever deposits the listed tokens.
 * Deposits are not sold, locked or wrapped: you can withdraw the same token at any time.
 */
export function Genesis() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  const g = p.farms.genesis;
  useReveal(root, [p.deployed, g.pools.length]);
  const copy = PHASE_COPY[g.phase];
  const perSecond = EMISSIONS.genesis.total / EMISSIONS.genesis.seconds;

  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Genesis"
        token="xTOMB"
        title={
          <>
            Twenty-four hours of <span className="iris-text">{NAMES.peg}</span>
          </>
        }
        lede={`Deposit a listed token and earn ${NAMES.peg} pro-rata for one day, before the first epoch. Your deposit stays yours: there is no lockup and no deposit fee.`}
        aside={
          <div className="panel panel-raised p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="label">Window</span>
              <span className={`chip ${copy.chip}`}>
                {g.phase === "live" && <span className="live-dot h-1.5 w-1.5 rounded-full bg-ok" />}
                {copy.label}
              </span>
            </div>
            <div className="font-display text-3xl font-semibold tracking-[-0.03em] text-bone">
              {g.phase === "upcoming" ? <Countdown to={g.start} done="opening" /> : g.phase === "live" ? <Countdown to={g.end} done="closing" /> : "—"}
            </div>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ash">{g.phase === "upcoming" ? "until it opens" : g.phase === "live" ? "until it closes" : g.phase === "ended" ? `closed ${formatDate(g.end)}` : "no schedule"}</p>
            <p className="mt-4 border-t border-white/[0.06] pt-3 text-[13px] leading-relaxed text-bone-dim">{copy.line}</p>
          </div>
        }
      />

      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-10 md:px-8">
        {!p.deployed && <NotDeployed what="Genesis" />}

        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Genesis facts">
          <StatTile label="Total rewards" numeric={toNumber(g.totalRewards) ?? EMISSIONS.genesis.total} format={(n) => n.toLocaleString()} unit={NAMES.peg} hint={g.totalRewards === null ? "Contract constant" : "GenesisRewardPool.TOTAL_REWARDS"} tone="iris" />
          <StatTile label="Emission rate" value={`${perSecond.toFixed(4)}/s`} hint={`${(perSecond * 3600).toFixed(1)} ${NAMES.peg} per hour, split by pool weight`} />
          <StatTile label="Opens" value={g.start ? formatDate(g.start) : "—"} hint="poolStartTime" />
          <StatTile label="Closes" value={g.end ? formatDate(g.end) : "—"} hint="24 hours after it opens" />
        </section>

        <section>
          <SectionTitle kicker="Pools" title="What you can deposit" />
          {g.pools.length > 0 ? (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {g.pools.map((pool) => (
                <FarmPoolCard key={pool.pid} farm={g} pool={pool} />
              ))}
            </div>
          ) : (
            <div data-reveal className="rounded-2xl border border-dashed border-white/12 bg-black/20 p-6 text-[14px] leading-relaxed text-bone-dim">
              {p.deployed ? (g.loaded ? "No deposit tokens are registered yet. The operator lists them before the window opens; they will appear here as soon as they exist on-chain." : "Reading the pools…") : "The deposit tokens are chosen at launch and read from the contract. None exist on this network."}
            </div>
          )}
        </section>

        <section>
          <SectionTitle kicker="Rules" title="How Genesis works" right={<RuleBadge />} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              ["One window", `Exactly 24 hours and ${EMISSIONS.genesis.total.toLocaleString()} ${NAMES.peg}. It is not extended and not repeated.`],
              ["Pro-rata, per second", "Each pool gets a fixed share of the emissions; inside a pool you earn in proportion to your share of the deposits, second by second."],
              ["Yours throughout", "Withdraw the token you deposited at any time, with what you earned. Emergency withdraw returns the deposit but forfeits the earnings."],
            ].map(([k, v]) => (
              <div key={k} data-reveal className="panel p-5">
                <div className="label mb-2">{k}</div>
                <p className="text-[13.5px] leading-relaxed text-bone-dim">{v}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[13px] text-ash">
            After Genesis, the same {NAMES.peg} can be paired into liquidity and farmed for {NAMES.share}.{" "}
            <Link to="/farm" className="text-iris-hot underline-offset-4 hover:underline">
              Open the farm →
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}

