import { useRef } from "react";
import { Link } from "react-router-dom";

import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { PendingBadge, PendingPanel, Reason } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { useProtocol } from "@/lib/hooks";
import { FARM_POLICY, SQUARE_SUPPLY } from "@/lib/launch";
import { useReveal } from "@/lib/motion/useReveal";
import type { TokenId } from "@/lib/tokens";

/**
 * Farm — after Genesis, xSHARE emissions for official LP. The launch config
 * fixes the budget (25,641 xSHARE over 365 days) and the 3-hour compound
 * cooldown, but the merge branch has no Farm staking contract or ABI yet, so
 * every action here is shown, explained and disabled.
 */
const WHY = "No Farm staking contract is bound in the merge-branch deployment yet (Farm staking and migration remain pending on the backend).";

export function Farm() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  useReveal(root, []);
  const perDay = SQUARE_SUPPLY.farming / FARM_POLICY.emissionDays;
  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Farm · xSHARE emissions · pending"
        token="xSHARE"
        title={<span className="spectre-text">Farm</span>}
        lede={`After Genesis, official LP earns xSHARE: ${SQUARE_SUPPLY.farming.toLocaleString()} xSHARE over ${FARM_POLICY.emissionDays} days (≈${perDay.toFixed(1)} a day). The pools are configured; the staking contract isn't bound yet.`}
        aside={
          <div className="panel p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Status</span>
              <PendingBadge />
            </div>
            <p className="text-[13px] leading-relaxed text-bone-dim">{WHY}</p>
            <Link to="/genesis" className="btn btn-ghost mt-3 h-9 px-3 text-[12.5px]">
              {p.clock?.phase === "ended" ? "Withdraw Genesis stakes →" : "Genesis is running →"}
            </Link>
          </div>
        }
      />
      <div className="mx-auto w-full max-w-7xl space-y-8 px-4 pb-10 md:px-8">
        <section>
          <SectionTitle kicker="Configured" title="Farm pools" right={<PendingBadge label="Staking pending" />} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {(["xTOMB-USDC", "xSHARE-USDC"] as TokenId[]).map((id) => (
              <article key={id} data-reveal className="panel p-5">
                <div className="flex items-center gap-3">
                  <TokenIcon symbol={id} size={36} />
                  <div>
                    <h3 className="font-display text-[16px] font-semibold text-bone">{id === "xTOMB-USDC" ? "xTOMB/USDC LP" : "xSHARE/USDC LP"}</h3>
                    <div className="text-[12px] text-ash">vault shares · earns xSHARE</div>
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-[12.5px]">
                  <div>
                    <dt className="text-ash">Emission split</dt>
                    <dd className="text-bone-dim">pending</dd>
                  </div>
                  <div>
                    <dt className="text-ash">Compound</dt>
                    <dd className="text-bone">every {FARM_POLICY.compoundCooldownSeconds / 3600}h</dd>
                  </div>
                  <div>
                    <dt className="text-ash">Fees / locks</dt>
                    <dd className="text-bone-dim">pending</dd>
                  </div>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  {["Stake", "Claim", "Compound"].map((a) => (
                    <button key={a} type="button" disabled className="btn h-9 px-4 text-[12.5px]">
                      {a}
                    </button>
                  ))}
                </div>
                <Reason>{WHY}</Reason>
              </article>
            ))}
          </div>
        </section>
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PendingPanel title="Farm auto-compounder">
            The planned keeper product (one purchase covering both Farm pools) has no contract or ABI in the handoff. It will be offered only once a bound contract
            exposes its price and purchase call.
          </PendingPanel>
          <PendingPanel title="Genesis → Farm migration">
            Moving Genesis LP stakes into the Farm needs the Farm contract. Until then, withdraw from Genesis and keep the vault shares — they're redeemable for
            xTOMB and USDC at any time.
          </PendingPanel>
        </section>
      </div>
    </div>
  );
}
