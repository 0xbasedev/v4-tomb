import { useRef } from "react";
import { Link } from "react-router-dom";

import { KeeperPanel } from "@/components/genesis/KeeperPanel";
import { PassPicker } from "@/components/genesis/PassPicker";
import { PoolPanel } from "@/components/genesis/PoolPanel";
import { VestingPanel } from "@/components/genesis/VestingPanel";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { SimBadge } from "@/components/Status";
import { fmtDuration, GENESIS_DAYS, LP_DAY, walletClaim, type GenesisClock } from "@/lib/genesis";
import { useProtocol } from "@/lib/hooks";
import { FIRE, GENESIS_POLICY, pct } from "@/lib/launch";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Genesis — seven days, pass-gated, two pools (MasonryGenesisSchedule /
 * Pass / Staking / Settlement). Day 1 sends every emission to the standard
 * pool; from Day 2 the xTOMB/USDC LP pool takes 75%. After Genesis the same
 * page keeps withdrawals, claims and vesting releases open.
 */
export function Genesis() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  const c = p.clock;
  useReveal(root, [c?.phase]);
  const ex = walletClaim(400);

  return (
    <div ref={root}>
      <PageHeader
        eyebrow={
          !c
            ? "Genesis"
            : c.phase === "pre"
              ? `Genesis · starts in ${fmtDuration(c.secondsToStart)}`
              : c.phase === "ended"
                ? "Genesis · complete"
                : `Genesis · day ${c.day} of ${GENESIS_DAYS}`
        }
        token="xTOMB"
        title={<span className="ember-text">Genesis</span>}
        lede={`Seven days, pass-gated. Stake in the standard pool from Day 1; the xTOMB/USDC LP pool opens on Day ${LP_DAY} and takes 75% of emissions from then on. Every reward is half liquid, half vested.`}
        aside={c && <Timeline clock={c} simulated={p.sim} />}
      />

      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 md:px-8">
        {c?.phase !== "ended" && <PassPicker />}

        <section>
          <SectionTitle
            kicker={c?.phase === "ended" ? "Collect" : "Step 2 · Stake"}
            title={c?.phase === "ended" ? "Genesis pools · withdraw and claim" : "Genesis pools"}
            right={<span className="hidden font-mono text-[11px] text-ash sm:inline">claims and compounds: one 3h clock per pool</span>}
          />
          <div className="space-y-4">
            <PoolPanel pool={0} />
            <PoolPanel pool={1} />
          </div>
        </section>

        <section data-reveal className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="panel p-5 md:p-6">
            <div className="mb-2 flex items-center gap-2">
              <span className="label">How a claim settles</span>
            </div>
            <h3 className="font-display text-lg font-semibold text-bone">A 400 xTOMB wallet claim</h3>
            <div className="mt-4 flex h-3 overflow-hidden rounded-full">
              <div className="bg-ember" style={{ width: `${(ex.toWallet / 400) * 100}%` }} title="to wallet" />
              <div className="bg-warn" style={{ width: `${(ex.treasury / 400) * 100}%` }} title="to Treasury" />
              <div className="bg-amethyst" style={{ width: `${(ex.vested / 400) * 100}%` }} title="vested" />
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-[12.5px]">
              <div>
                <dt className="text-ash">To wallet</dt>
                <dd className="num text-[17px] text-ember-hot">{ex.toWallet}</dd>
              </div>
              <div>
                <dt className="text-ash">To Treasury</dt>
                <dd className="num text-[17px] text-warn">{ex.treasury}</dd>
              </div>
              <div>
                <dt className="text-ash">Vested</dt>
                <dd className="num text-[17px] text-amethyst">{ex.vested}</dd>
              </div>
            </dl>
            <p className="mt-3 text-[12.5px] leading-relaxed text-bone-dim">
              50% liquid, 50% vested (the 50/50 split is separate from the 75% LP emission share). The {pct(GENESIS_POLICY.walletFeeBps)} claim fee applies to the
              liquid half and to each vesting release; the vested half releases in {GENESIS_POLICY.installments} six-hour installments, each opening when you
              claim the one before.
            </p>
          </div>
          <div className="panel p-5 md:p-6">
            <span className="label">Sells during Genesis</span>
            <h3 className="mt-2 font-display text-lg font-semibold text-bone">At least {pct(FIRE.genesisFloorBps.xTOMB)} on xTOMB, burned in full</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-bone-dim">
              Every official xTOMB sell pays one rate — the highest of the TWAP target, the projected post-sale target, the recovery floor and the Genesis floor —
              capped at {pct(FIRE.capBps)}. During Genesis the whole xTOMB sell tax is burned. xSHARE sells pay at least {pct(FIRE.genesisFloorBps.xSHARE)}. A
              compound sells part of its xTOMB, so that sell leg pays the same Fire Tax. Buys and wallet transfers pay nothing.
            </p>
            <Link to="/swap" className="btn btn-ghost mt-4 h-10 px-4 text-[13px]">
              See the Fire Tax now →
            </Link>
          </div>
        </section>

        <KeeperPanel />
        <VestingPanel />

        {c?.phase === "ended" && (
          <section data-reveal className="panel mb-8 flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="label mb-1">After Genesis</div>
              <p className="text-[14px] text-bone-dim">Farm and Masonry staking are pending their backend bindings. Your Genesis principal stays withdrawable here.</p>
            </div>
            <Link to="/farm" className="btn h-10 px-4 text-[13px]">
              See the Farm status →
            </Link>
          </section>
        )}
        <div className="pb-8" />
      </div>
    </div>
  );
}

/** Seven-day bar: Ultra's 24h pre-window, Day 1, the LP era from Day 2, and "now". */
function Timeline({ clock, simulated }: { clock: GenesisClock; simulated: boolean }) {
  const lpStart = GENESIS_POLICY.lpDelaySeconds / GENESIS_POLICY.durationSeconds;
  const ended = clock.phase === "ended";
  const now = clock.phase === "pre" ? 0 : clock.progress;
  return (
    <div className="panel p-5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="label">{ended ? "Genesis complete" : clock.phase === "pre" ? "Starts in" : "Ends in"}</span>
        <span className="flex items-center gap-2">
          {simulated && <SimBadge />}
          <span className="num text-lg text-bone">{ended ? `${fmtDuration(clock.secondsSinceEnd)} ago` : fmtDuration(clock.phase === "pre" ? clock.secondsToStart : clock.secondsToEnd)}</span>
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-white/5">
        <div className="absolute inset-y-0 right-0 rounded-r-full border border-ember-hot/50 bg-ember-hot/15" style={{ left: `${lpStart * 100}%` }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-ember-deep/60 to-ember/70" style={{ width: `${now * 100}%` }} />
        {Array.from({ length: GENESIS_DAYS - 1 }, (_, i) => (
          <span key={i} className="absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-white/20" style={{ left: `${((i + 1) / GENESIS_DAYS) * 100}%` }} />
        ))}
        {!ended && clock.phase !== "pre" && (
          <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-void bg-bone shadow-[0_0_14px_rgba(236,232,223,0.6)]" style={{ left: `${now * 100}%` }} />
        )}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-ash">
        {Array.from({ length: GENESIS_DAYS }, (_, i) => i + 1).map((d) => (
          <span key={d} className={d === clock.day && !ended ? "text-bone" : ""}>
            D{d}
          </span>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12px] text-ash">
        <span className="h-2 w-2 rounded-sm bg-ember-hot/70" />
        {clock.lpOpen ? "LP pool open · 75% of emissions" : ended ? "LP pool closed with Genesis" : clock.phase === "pre" ? (clock.ultraEarly ? "Ultra early staking is open (standard pool)" : "Ultra may pre-stake 24h before the start") : `LP pool opens Day ${LP_DAY} · in ${fmtDuration(clock.secondsToLp)}`}
      </div>
    </div>
  );
}
