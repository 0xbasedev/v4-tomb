import { useRef } from "react";

import { PageHeader } from "@/components/PageHeader";
import { PlannedBadge, Reason } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { legacyTreasuryAbi, legacyTrustNoteAbi } from "@/lib/abis/masonry";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Bond Office — a clearly labelled planned preview. The handoff carries the
 * Old Money Treasury and TrustNote ABIs for reference only; they establish no
 * xBOND address, rate, cap or policy. Issuance and redemption stay disabled
 * until a verified deployment exposes both actions, and no rates, caps,
 * reserve balances or returns are shown.
 */
const WHY = "No verified xBOND contract exposes issuance and redemption yet.";

const LEGACY = {
  treasury: legacyTreasuryAbi.filter((x) => x.type === "function").length,
  trustNote: legacyTrustNoteAbi.filter((x) => x.type === "function").length,
};

export function Bonds() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root, []);
  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Bond Office · planned preview"
        token="xBOND"
        title={<span className="amethyst-text">Bond Office</span>}
        lede="A planned way to defend the peg with bonds. Nothing here is live: the bond contract, its economics and its deployment are still to be verified."
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
          <div className="label mb-2">What the handoff includes</div>
          <p className="text-[13px] leading-relaxed text-bone-dim">
            Two Old Money reference interfaces — Treasury ({LEGACY.treasury} functions) and TrustNote ({LEGACY.trustNote} functions) — to study the legacy bond
            flow. They are not xBOND, set no live address or policy, and nothing on this page calls them.
          </p>
        </section>
      </div>
    </div>
  );
}
