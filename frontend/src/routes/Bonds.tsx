import { useRef } from "react";

import { PageHeader } from "@/components/PageHeader";
import { PlannedBadge, Reason } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { masonryBondAbi } from "@/lib/abis/masonry";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Bond Office — MasonryBond is implemented (buy below peg by burning xTOMB,
 * redeem above peg 1:1) but actions stay disabled until a verified launch
 * address is published. Discount/debt/supply numbers are constructor
 * placeholders, not approved tokenomics.
 */
const WHY = "MasonryBond is implemented locally, but no verified launch address is published yet.";

const ABI_FNS = masonryBondAbi.filter((x) => x.type === "function").length;

export function Bonds() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root, []);
  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Bond Office · not launched"
        token="xBOND"
        title={<span className="amethyst-text">Bond Office</span>}
        lede="Buy xBOND below peg by burning xTOMB; redeem above peg 1:1 for xTOMB. Discounts are bounded (max 2×) and debt/supply caps are launch placeholders. Nothing is live until a verified address is published."
        aside={
          <div className="panel p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Status</span>
              <PlannedBadge />
            </div>
            <p className="text-[13px] leading-relaxed text-bone-dim">{WHY} Rates, caps and returns will come from the contract's own quote once it exists.</p>
          </div>
        }
      />
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-5 px-4 pb-12 md:px-8 lg:grid-cols-2">
        {(["Issue", "Redeem"] as const).map((action) => (
          <section key={action} data-reveal className="panel p-5 md:p-6">
            <div className="mb-3 flex items-center gap-2">
              <TokenIcon symbol={action === "Issue" ? "xTOMB" : "xBOND"} size={28} />
              <h2 className="font-display text-xl font-semibold text-bone">{action === "Issue" ? "Issue xBOND" : "Redeem xBOND"}</h2>
              <PlannedBadge />
            </div>
            <dl className="grid grid-cols-2 gap-2 text-[12.5px]">
              {[
                ["Contract quote", "from the bond contract"],
                ["Eligibility", "from the contract"],
                [action === "Issue" ? "Remaining issuance" : "Reserve availability", "from the contract"],
                ["Blocked because", WHY],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-black/25 p-3">
                  <dt className="label mb-1">{k}</dt>
                  <dd className="text-bone-dim">{k === "Blocked because" ? v : "—"}</dd>
                  {k !== "Blocked because" && <dd className="mt-0.5 text-[11px] text-ash-dim">{v}</dd>}
                </div>
              ))}
            </dl>
            <label className="well mt-4 flex items-center gap-2 px-3 py-2 opacity-60">
              <input disabled aria-label={`${action} amount`} placeholder="0" className="num min-w-0 flex-1 bg-transparent text-[20px] text-bone outline-none" />
              <span className="font-mono text-[11px] text-ash">{action === "Issue" ? "xTOMB" : "xBOND"}</span>
            </label>
            <button type="button" disabled className="btn btn-amethyst mt-3 h-12 w-full">
              {action} unavailable
            </button>
            <Reason>{WHY}</Reason>
          </section>
        ))}
        <section data-reveal className="panel p-5 lg:col-span-2">
          <div className="label mb-2">What this page binds to</div>
          <p className="text-[13px] leading-relaxed text-bone-dim">
            The MasonryBond ABI ({ABI_FNS} functions): buy below peg, redeem above peg, preview quotes, and the
            placeholder discount/debt/supply caps. This page does not call the legacy Treasury or TrustNote path.
          </p>
        </section>
      </div>
    </div>
  );
}
