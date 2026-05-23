import { MemphisScatter } from "@/components/MemphisScatter";
import { ConnectButton } from "@/components/ConnectButton";

/**
 * Landing — the Miami Vice Split archetype.
 *
 * Per docs/eighties-design skill:
 *   - Top 60%: pale ground with chrome OLD MONEY hero title
 *   - Diagonal pink band at -30° between the zones
 *   - Bottom 40%: night ground with subhead and primary CTAs
 *   - Memphis scatter shapes drifting across both zones
 *   - Hard drop shadows on every interactive element
 *   - Declarative 80s copy: "Discover. Stake. Earn."
 *
 * The layout is intentionally light on the top and dark on the bottom — Miami Vice
 * never went all-dark. The split is the signal.
 */
export function Landing() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* Memphis scatter behind everything */}
      <div className="absolute inset-0 z-0">
        <MemphisScatter />
      </div>

      {/* Halftone texture overlay */}
      <div className="halftone-bg absolute inset-0 z-0 opacity-40" />

      {/* === Top zone — Miami light ground === */}
      <section className="relative z-10 bg-miami-ground-blush px-6 pt-10 pb-32 md:px-16 md:pt-14 md:pb-44">
        {/* Nav row */}
        <nav className="mb-16 flex items-center justify-between md:mb-24">
          <div className="flex items-baseline gap-3">
            <span
              className="font-headline text-3xl font-black italic tracking-tight text-miami-night"
              style={{ letterSpacing: "-0.02em" }}
            >
              OM
            </span>
            <span className="text-label uppercase text-miami-night/70">
              Old Money · Base
            </span>
          </div>
          <ConnectButton />
        </nav>

        {/* Hero */}
        <div className="relative max-w-6xl">
          <div className="text-label mb-6 uppercase text-miami-pink">
            The Algorithmic Trust · On Base
          </div>

          <h1 className="chrome-title text-hero leading-none">
            OLD
            <br />
            MONEY.
          </h1>

          <p className="mt-10 max-w-2xl font-slab text-2xl text-miami-night md:text-3xl">
            Pegged to ETH. Defended by V4. Earned in TheClub.
          </p>

          <p className="mt-6 max-w-xl font-body text-base text-miami-night/80 md:text-lg">
            $MONEY trades 1:1 against WETH. $ESTATE stakers in TheClub earn every
            expansion epoch. $TRUSTNOTE bondholders defend the peg during contraction.
            Built on Uniswap V4 with a peg-defense hook that burns supply when the
            market tries to push us off the rails.
          </p>
        </div>
      </section>

      {/* === Diagonal band — the structural spine === */}
      <div
        aria-hidden
        className="relative z-20 -mt-24 h-32 w-full md:-mt-32"
      >
        <div
          className="absolute -left-[10%] top-1/2 h-20 w-[120%] -translate-y-1/2 bg-miami-pink shadow-hard-teal"
          style={{
            transform: "translateY(-50%) skewY(-3deg)",
          }}
        />
      </div>

      {/* === Bottom zone — night ground === */}
      <section className="relative z-10 bg-miami-night px-6 pb-24 pt-20 text-miami-ground md:px-16 md:pb-32 md:pt-24">
        <div className="grid max-w-6xl gap-12 md:grid-cols-3">
          {/* Card 1 — Stake */}
          <div className="border-l-4 border-miami-teal pl-6">
            <div className="text-label mb-3 uppercase text-miami-teal">
              01 · TheClub
            </div>
            <h2 className="font-headline text-section font-black italic text-miami-pink text-shadow-hard-teal">
              STAKE
            </h2>
            <p className="mt-4 font-body text-base text-miami-ground/80">
              Stake $ESTATE in TheClub. Every expansion epoch, $MONEY seigniorage
              flows to stakers pro-rata. 6-epoch withdraw lock, 3-epoch reward lock.
              Patience is rewarded.
            </p>
          </div>

          {/* Card 2 — Earn */}
          <div className="border-l-4 border-miami-yellow pl-6">
            <div className="text-label mb-3 uppercase text-miami-yellow">
              02 · TheVault
            </div>
            <h2 className="font-headline text-section font-black italic text-miami-yellow text-shadow-hard-pink">
              EARN
            </h2>
            <p className="mt-4 font-body text-base text-miami-ground/80">
              Provide MONEY-WETH liquidity, wrap your V4 position, stake in TheVault.
              140k $MONEY emitted across the Main pool over 9 days. 59.5k $ESTATE
              streams to LPs over 370 days.
            </p>
          </div>

          {/* Card 3 — Defend */}
          <div className="border-l-4 border-miami-orange pl-6">
            <div className="text-label mb-3 uppercase text-miami-orange">
              03 · TrustNotes
            </div>
            <h2 className="font-headline text-section font-black italic text-miami-orange text-shadow-hard-pink">
              DEFEND
            </h2>
            <p className="mt-4 font-body text-base text-miami-ground/80">
              When MONEY drops below peg, burn it for $TRUSTNOTE at a discount.
              When MONEY recovers above 1.10, redeem at a premium. The bond market
              is the protocol's last line of defense.
            </p>
          </div>
        </div>

        {/* CTA row */}
        <div className="mt-16 flex flex-wrap items-center gap-6 md:mt-20">
          <button className="btn-hard bg-miami-pink text-miami-ground shadow-hard-teal">
            DISCOVER THE FUTURE
            <span aria-hidden>→</span>
          </button>
          <a
            href="#docs"
            className="text-label uppercase text-miami-ground/70 hover:text-miami-pink"
          >
            Read the docs →
          </a>
        </div>

        {/* Footer tagline */}
        <div className="mt-24 border-t border-miami-ground/20 pt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <p
              className="font-headline text-xl font-bold italic text-miami-pink neon-text"
              style={{ letterSpacing: "0.05em" }}
            >
              POWER. WITHOUT COMPROMISE.
            </p>
            <p className="text-label uppercase text-miami-ground/50">
              Old Money · Base Chain · 2026
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
