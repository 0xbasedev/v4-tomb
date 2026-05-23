import { useState } from "react";

import { BondForm } from "@/components/BondForm";
import { MarketStateBanner, type MarketState } from "@/components/MarketStateBanner";
import { RuleTrio } from "@/components/RuleTrio";
import { StatTile } from "@/components/StatTile";
import { TabBar } from "@/components/TabBar";

/**
 * Trust Notes — the bond office.
 *
 * Layout (centered axis):
 *   1. Heading — Roman III, "Trust Notes" title, formal voice
 *   2. MarketStateBanner — formal pronouncement of current bond market state
 *      ("Notes Are Issued" / "Notes Are Redeemed" / "The Trust is Steady" /
 *      "No Notes Are Active")
 *   3. Tabs — Acquire | Present (for Redemption)
 *   4. Active BondForm
 *      - Acquire: burn MONEY, receive TRUSTNOTE at issuance discount
 *      - Present: burn TRUSTNOTE, receive MONEY at maturity premium
 *   5. Your Trust Notes position (2 tiles: held, MONEY equivalent)
 *   6. Market state stats (4 tiles)
 *   7. Schedule explanation panel
 *
 * Note on "current state": initial state is "closed" because the protocol hasn't
 * had a contraction yet. Sprint B reads `treasury.getMoneyPrice()` against
 * `moneyPriceOne` / `moneyPriceCeiling` / `premiumThreshold` to compute the
 * actual market state.
 */

type Tab = "acquire" | "present";

export function TrustNotes() {
  const [tab, setTab] = useState<Tab>("acquire");

  // Placeholder market state — Sprint B computes from price + thresholds.
  // For the initial demo we render "closed" since no contraction has occurred.
  // Cast widens the type so the comparison narrowings below typecheck.
  const marketState = "closed" as MarketState;
  const currentPrice = "1.0000";
  const priceDetail = "Within The Band · 1.0000 to 1.0100 ETH";

  // Placeholder rates. Sprint B reads:
  //   acquire: treasury.getBondDiscountRate() — usually 1.0 (no discount) unless
  //            discountPercent > 0; below 1.0 ETH the rate is 1e18/price (more bonds
  //            per MONEY burned).
  //   present: treasury.getBondPremiumRate() — 1.0 between 1.01 and 1.10; above
  //            1.10 it's 1 + (price - 1) * 70% / 10000.
  const discountRate = 1.0;
  const premiumRate = 1.0;

  // Placeholder user balances + market totals.
  const moneyInWallet = "0";
  const notesInWallet = "0";
  const noteSupply = "0";
  const treasuryReserve = "0";
  const debtRatio = "0.00%";

  const acquireDisabled = marketState !== "acquisition";
  const presentDisabled = marketState !== "redemption";

  return (
    <div className="bg-deco-ground">
      {/* ===== Heading ===== */}
      <section className="relative px-6 pt-16 pb-12 md:px-12 md:pt-20 md:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">
            A Pavilion of The Trust · The Bond Office
          </div>
          <div
            className="font-ornament mb-4 text-3xl font-bold text-deco-gold"
            style={{ letterSpacing: "0.2em" }}
          >
            III
          </div>
          <h1 className="gold-text font-display italic text-section">Trust Notes</h1>
          <RuleTrio className="mb-6 mt-8" />
          <p
            className="mx-auto max-w-2xl font-headline text-lg italic text-deco-ivory-soft md:text-xl"
            style={{ letterSpacing: "0.04em" }}
          >
            When the Trust falters, burn MONEY for Notes at a discount. When the Trust
            recovers above one and one-tenth, present the Notes for a premium.
          </p>
        </div>
      </section>

      {/* ===== Market State Banner ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <MarketStateBanner
          state={marketState}
          price={currentPrice}
          detail={priceDetail}
        />
      </section>

      {/* ===== Tabs ===== */}
      <section className="px-6 pb-8 md:px-12 md:pb-10">
        <TabBar
          active={tab}
          onChange={(id) => setTab(id as Tab)}
          items={[
            { id: "acquire", numeral: "I", label: "Acquire", sublabel: "Below Peg" },
            { id: "present", numeral: "II", label: "Present", sublabel: "Above 1.10" },
          ]}
        />
      </section>

      {/* ===== Active Form ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-2xl">
          {tab === "acquire" ? (
            <BondForm
              inputLabel="Burn MONEY"
              inputAsset="MONEY"
              maxAvailable={moneyInWallet}
              outputAsset="TRUSTNOTE"
              rate={discountRate}
              rateLabel="Issuance Discount"
              cta="Issue Note Against MONEY"
              disabled={acquireDisabled}
              disabledReason={
                marketState === "redemption"
                  ? "The Trust trades above peg. Notes are not issued — they are redeemed."
                  : marketState === "at-rest"
                    ? "The Trust trades within the band. No Notes are issued here."
                    : "The Trust has not yet entered a contraction."
              }
              helper="Your MONEY is permanently destroyed. The Note holds a claim against future MONEY at premium."
            />
          ) : (
            <BondForm
              inputLabel="Present TRUSTNOTE"
              inputAsset="TRUSTNOTE"
              maxAvailable={notesInWallet}
              outputAsset="MONEY"
              rate={premiumRate}
              rateLabel="Maturity Premium"
              cta="Present Note · Claim MONEY"
              disabled={presentDisabled}
              disabledReason={
                marketState === "acquisition"
                  ? "The Trust trades below peg. Notes are issued, not redeemed."
                  : marketState === "at-rest"
                    ? "The Trust must trade above one and one-tenth for premium. Below that, redemption is one-to-one and the Treasury must hold sufficient MONEY."
                    : "The Treasury holds no MONEY reserve to redeem against."
              }
              helper="MONEY is drawn from the Treasury's reserve, accumulated during prior expansion epochs."
            />
          )}
        </div>
      </section>

      {/* ===== Your Position ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            Your Holdings
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <StatTile
              label="Trust Notes · Held"
              value={notesInWallet}
              hint="$TRUSTNOTE · Awaiting Redemption"
            />
            <StatTile
              label="MONEY · in Wallet"
              value={moneyInWallet}
              hint="$MONEY · Available to Burn"
            />
          </div>
        </div>
      </section>

      {/* ===== Bond Market State ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The State of The Bond Market
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
            <StatTile label="Notes Outstanding" value={noteSupply} hint="$TRUSTNOTE · Total" />
            <StatTile
              label="Treasury Reserve"
              value={treasuryReserve}
              hint="$MONEY · Held for Redemption"
            />
            <StatTile label="Debt Ratio" value={debtRatio} hint="Notes / Circulating MONEY" />
            <StatTile label="Debt Ceiling" value="35.00%" hint="Maximum Permitted" />
          </div>
        </div>
      </section>

      {/* ===== The Schedule ===== */}
      <section className="px-6 pb-20 md:px-12 md:pb-28">
        <div className="mx-auto max-w-3xl">
          <div className="deco-panel">
            <div className="label-deco mb-3 text-deco-gold-dark">The Mechanism</div>
            <h2
              className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl"
              style={{ letterSpacing: "0.06em" }}
            >
              The Issuance and Redemption of Notes
            </h2>
            <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
            <div className="grid grid-cols-1 gap-6 text-left md:grid-cols-2">
              <div className="border-l border-deco-gold/40 pl-5">
                <div className="label-deco mb-2 text-deco-gold">Issuance</div>
                <p className="font-body text-sm italic text-deco-ivory-soft">
                  Open only when MONEY trades below one Ether. Each epoch permits at most
                  three per cent of circulating supply to be burned. Outstanding Notes
                  may not exceed thirty-five per cent of the supply.
                </p>
              </div>
              <div className="border-l border-deco-gold/40 pl-5">
                <div className="label-deco mb-2 text-deco-gold">Redemption</div>
                <p className="font-body text-sm italic text-deco-ivory-soft">
                  Open only when MONEY trades above one and one-hundredth Ether. The
                  premium kicks in at one and one-tenth — below that threshold the Note
                  redeems one-to-one. The Treasury must hold sufficient MONEY reserve.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
