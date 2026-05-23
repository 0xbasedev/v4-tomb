import { Link } from "react-router-dom";

import { ConnectButton } from "@/components/ConnectButton";
import { StatTile } from "@/components/StatTile";
import { PillarCard } from "@/components/PillarCard";
import { RuleTrio } from "@/components/RuleTrio";
import { Sunburst } from "@/components/Sunburst";

/**
 * Landing — Art Deco grammar per docs/skill-art-deco.md.
 *
 * Anatomy (top to bottom, all centered on a vertical axis):
 *   1. Minimal nav — brand mark + ConnectButton
 *   2. Hero — sunburst behind metallic OLD MONEY title, rule trios above and below,
 *      formal subhead, dual CTA. Stats panel (six tiles) directly below.
 *   3. "The Three Estates" — three pillar cards equal in weight, framed-within-framed
 *   4. "The Mechanism" — three formal step panels explaining the protocol
 *   5. Footer — closing rule trio and house signature
 *
 * Vertical symmetry is enforced throughout — no asymmetric/diagonal energy. Voice
 * is formal: "Acquire," "Discover," "We Are Honoured To Present."
 */
export function Landing() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-deco-ground">
      {/* ===== Nav ===== */}
      <nav className="relative z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 md:px-12">
        <div className="flex items-baseline gap-4">
          <span
            className="font-display text-3xl font-bold text-deco-gold"
            style={{ letterSpacing: "0.15em" }}
          >
            OM
          </span>
          <span className="label-deco hidden text-deco-gold-dark md:inline">
            The Trust · Base
          </span>
        </div>
        <ConnectButton />
      </nav>

      {/* ===== Hero ===== */}
      <section className="relative px-6 pt-12 pb-20 md:px-12 md:pt-16 md:pb-28">
        {/* Sunburst behind the hero — large, semi-transparent, slow rotation */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-0 -translate-x-1/2 -translate-y-[40%]">
          <Sunburst rays={32} opacity={0.18} className="h-[800px] w-[800px] md:h-[1100px] md:w-[1100px]" />
        </div>

        <div className="relative z-10 mx-auto max-w-4xl">
          {/* Top rule trio */}
          <RuleTrio className="mb-6" />

          {/* Imperial label */}
          <div className="label-deco mb-4 text-deco-gold-dark">
            An Algorithmic Trust · Pegged to Ether
          </div>

          {/* Chrome hero title */}
          <h1 className="gold-text-shimmer font-display italic text-hero">
            OLD MONEY
          </h1>

          {/* Subhead */}
          <p
            className="mt-8 font-headline text-xl text-deco-ivory md:text-2xl"
            style={{ letterSpacing: "0.08em" }}
          >
            Engineered with Precision. Defended by Sovereign Code.
            <br />
            Earned at The Club.
          </p>

          {/* Bottom rule trio with diamond */}
          <RuleTrio className="mb-10 mt-10" />

          {/* CTAs */}
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link to="/dashboard" className="btn-deco btn-deco-primary">
              Enter The Trust
            </Link>
            <a href="#mechanism" className="btn-deco">
              Discover The Mechanism
            </a>
          </div>
        </div>

        {/* ===== Stats panel ===== */}
        <div className="relative z-10 mx-auto mt-20 max-w-5xl md:mt-24">
          <div className="label-deco mb-6 text-deco-gold-dark">
            The Ledger · Live on Base · Epoch I
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            <StatTile label="MONEY · Price" value="1.0000" hint="ETH · TWAP" />
            <StatTile label="Peg" value="100.00%" hint="Within The Band" />
            <StatTile label="Supply" value="160,001" hint="MONEY in Circulation" />
            <StatTile label="Treasury Reserve" value="0" hint="MONEY · Held" />
            <StatTile label="Next Epoch" value="06:00:00" hint="HH : MM : SS" />
            <StatTile label="Bond Rate" value="—" hint="No Issuance Active" />
          </div>
        </div>
      </section>

      {/* ===== The Three Estates ===== */}
      <section className="relative px-6 py-24 md:px-12 md:py-32">
        <div className="mx-auto max-w-4xl">
          <div className="label-deco mb-3 text-deco-gold-dark">
            We Present
          </div>
          <h2
            className="gold-text mb-4 font-display italic text-section"
          >
            The Three Estates
          </h2>
          <p
            className="mx-auto max-w-xl font-headline text-lg italic text-deco-ivory-soft md:text-xl"
            style={{ letterSpacing: "0.04em" }}
          >
            Each performs its station. Together they preserve the Trust.
          </p>
          <RuleTrio className="mb-16 mt-10" />

          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
            <PillarCard
              numeral="I"
              title="The Club"
              blurb="Stake $ESTATE within the Boardroom. Each expansion epoch, seigniorage flows pro-rata to the Members. Six-epoch withdrawal. Three-epoch reward lockup."
              cta="Take a Seat"
              to="/club"
            />
            <PillarCard
              numeral="II"
              title="The Vault"
              blurb="Provide MONEY-WETH liquidity to the V4 pool. Wrap the position. Stake the certificate. One hundred forty thousand MONEY across nine days."
              cta="Open The Vault"
              to="/vault"
            />
            <PillarCard
              numeral="III"
              title="Trust Notes"
              blurb="When MONEY falls below peg, redeem it for Trust Notes at a discount. When the Trust recovers above one and one-tenth, redeem for a premium."
              cta="View The Notes"
              to="/notes"
            />
          </div>
        </div>
      </section>

      {/* ===== The Mechanism ===== */}
      <section className="relative bg-deco-ground-soft px-6 py-24 md:px-12 md:py-32">
        <div className="mx-auto max-w-4xl">
          <div className="label-deco mb-3 text-deco-gold-dark">In Brief</div>
          <h2 className="gold-text mb-4 font-display italic text-section">
            The Mechanism
          </h2>
          <p
            className="mx-auto max-w-xl font-headline text-lg italic text-deco-ivory-soft md:text-xl"
            style={{ letterSpacing: "0.04em" }}
          >
            A flywheel of supply and seigniorage. Six hours to the epoch.
          </p>
          <RuleTrio className="mb-16 mt-10" />

          <div className="grid grid-cols-1 gap-12 md:grid-cols-3">
            <div className="text-center">
              <div className="font-ornament mb-4 text-2xl font-bold text-deco-gold" style={{ letterSpacing: "0.2em" }}>
                I
              </div>
              <h3 className="mb-4 font-display text-2xl text-deco-ivory" style={{ letterSpacing: "0.06em" }}>
                Acquire
              </h3>
              <div className="mx-auto mb-5 h-[1px] w-12 bg-deco-gold" aria-hidden />
              <p className="mx-auto max-w-xs font-body text-base text-deco-ivory-soft">
                Stake your Ether in the Genesis Pool for twenty-four hours and receive $MONEY.
                Or purchase upon the V4 pool. Or provide liquidity and earn.
              </p>
            </div>

            <div className="text-center">
              <div className="font-ornament mb-4 text-2xl font-bold text-deco-gold" style={{ letterSpacing: "0.2em" }}>
                II
              </div>
              <h3 className="mb-4 font-display text-2xl text-deco-ivory" style={{ letterSpacing: "0.06em" }}>
                Compound
              </h3>
              <div className="mx-auto mb-5 h-[1px] w-12 bg-deco-gold" aria-hidden />
              <p className="mx-auto max-w-xs font-body text-base text-deco-ivory-soft">
                Acquire $ESTATE. Stake at The Club. When the Trust expands above peg,
                seigniorage is distributed to The Members. Patience is rewarded.
              </p>
            </div>

            <div className="text-center">
              <div className="font-ornament mb-4 text-2xl font-bold text-deco-gold" style={{ letterSpacing: "0.2em" }}>
                III
              </div>
              <h3 className="mb-4 font-display text-2xl text-deco-ivory" style={{ letterSpacing: "0.06em" }}>
                Defend
              </h3>
              <div className="mx-auto mb-5 h-[1px] w-12 bg-deco-gold" aria-hidden />
              <p className="mx-auto max-w-xs font-body text-base text-deco-ivory-soft">
                When the Trust falters below peg, the Hook burns supply on every sale.
                Trust Notes contract circulation further. The peg is restored.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="relative px-6 py-16 md:px-12 md:py-20">
        <div className="mx-auto max-w-4xl">
          <RuleTrio className="mb-10" />

          <div className="text-center">
            <p className="font-display text-2xl italic text-deco-ivory md:text-3xl" style={{ letterSpacing: "0.1em" }}>
              Wealth Engineered with Precision.
            </p>
            <div className="mt-4 font-ornament text-sm text-deco-gold" style={{ letterSpacing: "0.3em" }}>
              MMXXVI · The House of Old Money
            </div>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-6">
              <a href="#twitter" className="label-deco hover:text-deco-gold-light">
                Correspondence
              </a>
              <span className="text-deco-gold-dark">·</span>
              <a href="#docs" className="label-deco hover:text-deco-gold-light">
                The Mechanism
              </a>
              <span className="text-deco-gold-dark">·</span>
              <a href="#github" className="label-deco hover:text-deco-gold-light">
                The Ledger
              </a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
