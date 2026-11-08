import { useRef } from "react";
import { Link } from "react-router-dom";

import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { PendingBadge, PendingPanel, Reason, SimBadge } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { masonryChamberAbi } from "@/lib/abis/masonry";
import { useProtocol } from "@/lib/hooks";
import { EXPANSION, POLICY, SQUARE_ROUTING, pct } from "@/lib/launch";
import { PHASE_META } from "@/lib/market";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Masonry — stake X Share/WETH LP in MasonryChamber for expansion X Tomb.
 * Writes stay disabled until a verified launch address is published.
 */
const WHY = "MasonryChamber is implemented locally, but no verified launch address is published yet.";
const ABI_FNS = masonryChamberAbi.filter((x) => x.type === "function").length;

export function Masonry() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  useReveal(root, []);
  const meta = PHASE_META[p.market.phase];
  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Masonry · not launched"
        token="xSHARE"
        title={<span className="spectre-text">Masonry</span>}
        lede="Stake X Share/WETH LP for expansion xTOMB. Manual deposits reset a 6-hour withdraw lock; claims have their own 6-hour cooldown. Exit Now bypasses both locks by returning half your LP, sending the other half to the DAO wallet, and forfeiting pending xTOMB to Arbitrage."
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
            <TokenIcon symbol="xSHARE" size={30} />
            <h2 className="font-display text-xl font-semibold text-bone">Stake X Share/WETH LP</h2>
            <PendingBadge />
          </div>
          <div className="grid grid-cols-2 gap-3 text-[12.5px] md:grid-cols-4">
            {[
              ["Stake asset", "X Share/WETH LP"],
              ["Withdraw lock", "6 hours after a manual deposit"],
              ["Claim lock", "6 hours, independent of deposits"],
              ["Auto-compound", "Must not reset the withdraw lock"],
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

        <section data-reveal className="panel p-5 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl font-semibold text-bone">Exit Now</h2>
            <PendingBadge />
          </div>
          <p className="text-[13.5px] leading-relaxed text-bone-dim">
            Instantly leave: 50% of your staked LP returns to you, 50% goes to Treasury, and 100% of pending xTOMB is forfeited to Arbitrage.
            This does not redeem LP or sell xTOMB, so it cannot be used as a tax-free way around the Fire Tax. Waiting out the 6-hour withdraw lock still returns 100% of your LP.
          </p>
          <button type="button" disabled className="btn btn-amethyst mt-4 h-12 px-5">
            Exit Now unavailable
          </button>
          <Reason>{WHY}</Reason>
          <p className="mt-3 font-mono text-[11px] text-ash-dim">MasonryChamber ABI · {ABI_FNS} functions · expansion cap {pct(POLICY.maximumExpansionPerEpochBps)} per epoch</p>
        </section>

        <section>
          <SectionTitle kicker="Bound today" title="What the contracts already do for xSHARE" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div data-reveal className="panel p-5">
              <div className="label mb-2">xSHARE sell tax · normal</div>
              <p className="text-[13.5px] text-bone-dim">
                {pct(SQUARE_ROUTING.polBps)} to protocol-owned xSHARE/{`USDC`} LP, {pct(SQUARE_ROUTING.usdcReserveBps)} sold into the reserve,{" "}
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
            A fresh validated TWAP above ${EXPANSION.gate.toFixed(2)} lets MasonryTreasury mint up to {pct(EXPANSION.maxPerEpochBps)} of circulating
            xTOMB to MasonryChamber. Actions stay disabled until a verified address is published.
          </PendingPanel>
          <PendingPanel title="Masonry auto-compounder">No bound auto-compounder yet. If one is added it must not reset the 6-hour manual withdraw lock.</PendingPanel>
        </section>
      </div>
    </div>
  );
}
