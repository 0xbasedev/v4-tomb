import { useRef } from "react";
import { Link } from "react-router-dom";

import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { PendingBadge, PendingPanel, Reason, SimBadge } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { useProtocol } from "@/lib/hooks";
import { EXPANSION, SQUARE_ROUTING, pct } from "@/lib/launch";
import { PHASE_META } from "@/lib/market";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Masonry — the share-holder seat of the protocol. Its economics on the
 * merge branch are the xSHARE fee routing and (planned) expansion; there is
 * no Boardroom/Masonry staking contract or ABI in the handoff, so staking,
 * locks, fees and automation are shown as pending and every action is
 * disabled with the reason.
 */
const WHY = "No Masonry staking contract is bound in the merge-branch deployment — the ABI handoff has no production Farm or Boardroom ABI.";

export function Masonry() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  useReveal(root, []);
  const meta = PHASE_META[p.market.phase];
  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Masonry · pending"
        token="xSHARE"
        title={<span className="spectre-text">Masonry</span>}
        lede="Where xSHARE holders will stake for expansion. Today the contracts define how xSHARE's sell tax is routed and the planned expansion rule; Masonry staking itself isn't bound yet."
        aside={
          <div className="panel p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Right now</span>
              {p.sim && <SimBadge />}
            </div>
            <div className={`chip mb-2 ${meta.chip}`}>{meta.label}</div>
            <p className="text-[13px] leading-relaxed text-bone-dim">{meta.detail}</p>
          </div>
        }
      />
      <div className="mx-auto w-full max-w-7xl space-y-8 px-4 pb-10 md:px-8">
        <section data-reveal className="panel p-5 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <TokenIcon symbol="xSHARE-USDC" size={30} />
            <h2 className="font-display text-xl font-semibold text-bone">Stake xSHARE/USDC LP</h2>
            <PendingBadge />
          </div>
          <div className="grid grid-cols-2 gap-3 text-[12.5px] md:grid-cols-4">
            {[
              ["Stake asset", "xSHARE/USDC vault shares (planned)"],
              ["Withdraw lock", "pending"],
              ["Claim lock", "pending"],
              ["Deposit fee", "pending"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl bg-black/25 p-3">
                <div className="label mb-1">{k}</div>
                <div className="text-bone-dim">{v}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {["Deposit", "Claim", "Withdraw", "Compound"].map((a) => (
              <button key={a} type="button" disabled className="btn h-10 px-4 text-[13px]">
                {a}
              </button>
            ))}
          </div>
          <Reason>{WHY}</Reason>
        </section>

        <section>
          <SectionTitle kicker="Bound today" title="What the contracts already do for xSHARE" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div data-reveal className="panel p-5">
              <div className="label mb-2">xSHARE sell tax · normal</div>
              <p className="text-[13.5px] text-bone-dim">
                {pct(SQUARE_ROUTING.polBps)} to protocol-owned xSHARE/USDC LP, {pct(SQUARE_ROUTING.usdcReserveBps)} sold into the USDC reserve,{" "}
                {pct(SQUARE_ROUTING.squareReserveBps)} retained as xSHARE — shares of the collected tax.
              </p>
              <Link to="/dashboard" className="mt-3 inline-block font-mono text-[12px] text-spectre hover:underline">
                Live routing on the dashboard →
              </Link>
            </div>
            <div data-reveal className="panel p-5">
              <div className="label mb-2">Critical Defense</div>
              <p className="text-[13.5px] text-bone-dim">100% of new xSHARE sell tax buys and burns xTOMB while defense is active. Existing earmarks keep their purpose.</p>
              <Link to="/dashboard#defense" className="mt-3 inline-block font-mono text-[12px] text-spectre hover:underline">
                Defense status →
              </Link>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PendingPanel title="Expansion to stakers">
            Planned: a fresh validated TWAP above ${EXPANSION.gate.toFixed(2)} makes an epoch eligible to mint up to {pct(EXPANSION.maxPerEpochBps)} of circulating
            xTOMB. Treasury mint wiring and its recipients are still open on the merge branch.
          </PendingPanel>
          <PendingPanel title="Masonry auto-compounder">No contract or ABI yet. It will appear only once a bound contract exposes its price and purchase call.</PendingPanel>
        </section>
      </div>
    </div>
  );
}
