import { useRef } from "react";
import { Link } from "react-router-dom";
import { useAccount, useReadContracts } from "wagmi";
import type { Address } from "viem";

import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { DepositBadge, Reason } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { masonryShareSaleAbi } from "@/lib/abis/masonry";
import { useProtocol } from "@/lib/hooks";
import { useReveal } from "@/lib/motion/useReveal";
import { PEG } from "@/lib/peg";
import {
  SALE_MAX_RAISE,
  SALE_TOTAL_SHARES,
  SALE_UNLOCK_HOURS,
  SALE_VESTING_PER_TRANCHE,
  SHARE_SALE,
  trancheCost,
  tranchePrice,
} from "@/lib/shareSale";

/**
 * xSHARE auction — MasonryShareSale. Fixed tranches on a rising price, open
 * to Genesis pass holders who also hold an auction pass, after Genesis ends.
 * Writes stay disabled until a verified sale address is published.
 */
const WHY = "MasonryShareSale is built and tested locally, but no verified sale address is published yet.";
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

export function Auction() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  const { address: user } = useAccount();
  useReveal(root, []);

  const sale = (p.net.deployment?.contracts as Record<string, Address | undefined> | undefined)?.shareSale;
  const base = { address: sale, abi: masonryShareSaleAbi } as const;
  const live = useReadContracts({
    contracts: [
      { ...base, functionName: "tranchesSold" },
      { ...base, functionName: "lastBuyer" },
      { ...base, functionName: "isOpen" },
    ],
    query: { enabled: Boolean(sale) },
  });
  const sold = Number((live.data?.[0]?.result as bigint | undefined) ?? 0n);
  const lastBuyer = live.data?.[1]?.result as Address | undefined;
  const yourTurnIsBlocked = Boolean(user && lastBuyer && user.toLowerCase() === lastBuyer.toLowerCase());
  const soldOut = sold >= SHARE_SALE.trancheCount;
  const current = Math.min(sold, SHARE_SALE.trancheCount - 1);

  return (
    <div ref={root}>
      <PageHeader
        eyebrow="xSHARE auction · not launched"
        token="xSHARE"
        title={<span className="spectre-text">xSHARE Auction</span>}
        lede={`${SALE_TOTAL_SHARES} xSHARE, sold in ${SHARE_SALE.trancheCount} tranches of ${SHARE_SALE.trancheSize}. The price starts at ${usd(SHARE_SALE.startPriceUsd)} a share and rises ${usd(SHARE_SALE.priceStepUsd)} with every tranche sold. Opens when Genesis ends.`}
      />
      <div className="mx-auto w-full max-w-7xl space-y-8 px-4 pb-10 md:px-8">
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div data-reveal className="panel p-5 md:p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <TokenIcon symbol="xSHARE" size={30} />
              <h2 className="font-display text-xl font-semibold text-bone">
                {soldOut ? "Sold out" : `Tranche ${current + 1} of ${SHARE_SALE.trancheCount}`}
              </h2>
              <DepositBadge label={`${SHARE_SALE.trancheSize} xSHARE`} />
            </div>
            <div className="grid grid-cols-2 gap-3 text-[12.5px] md:grid-cols-4">
              {[
                ["Price per share", usd(tranchePrice(current))],
                ["Tranche cost", `${usd(trancheCost(current))} ${PEG.symbol}`],
                ["Yours at purchase", `${SHARE_SALE.upfrontPerTranche} xSHARE`],
                ["Unlocks later", `${SALE_VESTING_PER_TRANCHE} xSHARE`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-black/25 p-3">
                  <div className="label mb-1">{k}</div>
                  <div className="num text-[15px] text-bone">{v}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/[0.06]" aria-label={`${sold} of ${SHARE_SALE.trancheCount} tranches sold`}>
              <div className="h-full rounded-full bg-ok" style={{ width: `${(sold / SHARE_SALE.trancheCount) * 100}%` }} />
            </div>
            <div className="mt-2 flex justify-between font-mono text-[11px] text-ash">
              <span>
                {sold} of {SHARE_SALE.trancheCount} tranches sold
              </span>
              <span>next tranche {usd(tranchePrice(Math.min(current + 1, SHARE_SALE.trancheCount - 1)))} a share</span>
            </div>
            <button type="button" disabled className="btn btn-ok mt-5 h-12 w-full sm:w-auto sm:px-8">
              Buy tranche {current + 1} for {usd(trancheCost(current))}
            </button>
            {yourTurnIsBlocked ? (
              <Reason tone="warn">You bought the last tranche. You can buy again once another wallet buys one.</Reason>
            ) : (
              <Reason>{WHY}</Reason>
            )}
          </div>

          <div data-reveal className="panel p-5 md:p-6">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="font-display text-xl font-semibold text-bone">Auction pass</h2>
              <DepositBadge label={`${usd(SHARE_SALE.auctionPassUsd)} once`} />
            </div>
            <p className="text-[13.5px] leading-relaxed text-bone-dim">
              One per wallet, paid once, to take part in the auction. It is not refundable and cannot be moved to another wallet. You also need a{" "}
              <Link to="/genesis" className="text-spectre hover:underline">
                Genesis pass
              </Link>
              , and those stop selling when Genesis ends.
            </p>
            <button type="button" disabled className="btn btn-ok mt-4 h-12 w-full">
              Buy auction pass · {usd(SHARE_SALE.auctionPassUsd)}
            </button>
            <Reason>{WHY}</Reason>
          </div>
        </section>

        <section>
          <SectionTitle kicker="How it works" title="The rules, all enforced by the contract" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              ["Whole tranches only", `You buy all ${SHARE_SALE.trancheSize} xSHARE in a tranche or none. Every share in a tranche costs the same.`],
              ["Take turns", "After you buy a tranche you cannot buy the next one. Another wallet has to buy first."],
              [
                "1 now, 4 later",
                `${SHARE_SALE.upfrontPerTranche} xSHARE reaches your wallet at purchase. The other ${SALE_VESTING_PER_TRANCHE} unlock after the sale closes: ${SALE_VESTING_PER_TRANCHE} xSHARE every ${SHARE_SALE.unlockEpochs} epochs (${SALE_UNLOCK_HOURS} hours), one tranche at a time.`,
              ],
              ["Straight to the DAO", `Payments are in ${PEG.symbol} and go directly to the DAO wallet. Unsold xSHARE goes there too when the sale closes.`],
            ].map(([k, v]) => (
              <div key={k} data-reveal className="panel p-5">
                <div className="label mb-2">{k}</div>
                <p className="text-[13.5px] leading-relaxed text-bone-dim">{v}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle
            kicker="Price ladder"
            title={`${SHARE_SALE.trancheCount} tranches, ${usd(tranchePrice(0))} to ${usd(tranchePrice(SHARE_SALE.trancheCount - 1))}`}
            right={<span className="font-mono text-[12px] text-ash">full sell-out raises {usd(SALE_MAX_RAISE)}</span>}
          />
          <div data-reveal className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
            {Array.from({ length: SHARE_SALE.trancheCount }, (_, t) => {
              const state = t < sold ? "sold" : t === sold ? "now" : "later";
              return (
                <div
                  key={t}
                  className={`rounded-xl border p-3 ${
                    state === "now" ? "border-ok/60 bg-ok/10" : state === "sold" ? "border-white/[0.05] bg-black/30 opacity-50" : "border-white/[0.07] bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="label">Tranche {t + 1}</span>
                    {state === "now" && <span className="font-mono text-[10px] uppercase tracking-wider text-ok">now</span>}
                    {state === "sold" && <span className="font-mono text-[10px] uppercase tracking-wider text-ash">sold</span>}
                  </div>
                  <div className="num mt-1 text-[17px] text-bone">{usd(tranchePrice(t))}</div>
                  <div className="font-mono text-[11px] text-ash">{usd(trancheCost(t))} for {SHARE_SALE.trancheSize}</div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
