import { useRef } from "react";
import { Link } from "react-router-dom";

import { fmtDuration, GENESIS_DAYS, LP_DAY } from "@/lib/genesis";
import { useProtocol } from "@/lib/hooks";
import { PASSES } from "@/lib/launch";
import { useMagnetic } from "@/lib/motion/useMagnetic";

/** Genesis at a glance, shown while it's upcoming or running. */
export function GenesisStrip({ className = "" }: { className?: string }) {
  const { clock, pass, sim } = useProtocol();
  const cta = useRef<HTMLAnchorElement>(null);
  useMagnetic(cta, 0.2);
  if (!clock || clock.phase === "ended") return null;
  const status =
    clock.phase === "pre"
      ? `Starts in ${fmtDuration(clock.secondsToStart)}${clock.ultraEarly ? " · Ultra early staking open" : ""}`
      : clock.phase === "day1"
        ? `Day 1 · LP pool opens in ${fmtDuration(clock.secondsToLp)}`
        : `Day ${clock.day} of ${GENESIS_DAYS} · LP pool open`;
  return (
    <Link ref={cta} to="/genesis" data-reveal className={`panel panel-hover grid grid-cols-2 gap-4 p-5 md:grid-cols-[1.3fr_1fr_1fr_auto] md:items-center ${className}`}>
      <div className="col-span-2 md:col-span-1">
        <div className="label mb-1">Genesis{sim ? " · simulated clock" : ""}</div>
        <div className="font-display text-lg font-semibold text-bone">{status}</div>
      </div>
      <div>
        <div className="label mb-1">Official LP pool</div>
        <div className="text-[14px] text-bone">Opens Day {LP_DAY} · 75% of emissions</div>
      </div>
      <div>
        <div className="label mb-1">Entry</div>
        <div className="text-[14px] text-bone">{pass ? `${PASSES[pass].name} pass held` : `Pass from ${PASSES.genesis.priceUsdc} USDC`}</div>
      </div>
      <span className="col-span-2 text-right font-mono text-[13px] text-ember-hot md:col-span-1">Open →</span>
    </Link>
  );
}
