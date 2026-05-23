import { MemphisScatter } from "@/components/MemphisScatter";
import { ConnectButton } from "@/components/ConnectButton";
import { StatTile } from "@/components/StatTile";
import { PillarCard } from "@/components/PillarCard";
import { Marquee } from "@/components/Marquee";

/**
 * Landing — Tomb-fork-style dashboard-first landing.
 *
 * Layout zones (top to bottom):
 *   1. Nav (light Miami ground)
 *   2. Hero: 2-column — chrome title + tagline + CTA on the left, live stats panel
 *      (Arcade mode, dark ground) on the right
 *   3. Marquee — neon ticker bridging hero to action zone
 *   4. Three pillar cards — TheClub / TheVault / TrustNotes — full-width row of
 *      large action cards
 *   5. How-it-works 3-step row (light ground, slab serif explanation)
 *   6. Footer with tagline + chain badge
 *
 * Stat values are placeholders for v0. Turn 2 of the frontend sprint wires wagmi
 * reads to pull live epoch / price / supply from the deployed contracts.
 */
export function Landing() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-miami-ground-blush">
      {/* Memphis scatter — sparse, in the page margins */}
      <div className="absolute inset-0 z-0">
        <MemphisScatter />
      </div>

      {/* === Nav === */}
      <nav className="relative z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 md:px-12">
        <div className="flex items-baseline gap-4">
          <span
            className="font-headline text-4xl font-black italic tracking-tighter text-miami-night"
            style={{ letterSpacing: "-0.04em" }}
          >
            OM
          </span>
          <span className="hidden text-label uppercase text-miami-night/70 md:inline">
            Old Money · Algorithmic Trust on Base
          </span>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="#docs"
            className="hidden text-label uppercase text-miami-night/70 hover:text-miami-pink md:inline"
          >
            Docs
          </a>
          <ConnectButton />
        </div>
      </nav>

      {/* === Hero: 2-column chrome title + arcade stats panel === */}
      <section className="relative z-10 mx-auto w-full max-w-7xl px-6 pt-10 pb-20 md:px-12 md:pt-14 md:pb-28">
        <div className="grid items-start gap-12 md:grid-cols-12">
          {/* Left col: chrome title + tagline + CTA */}
          <div className="md:col-span-7">
            <div className="text-label mb-5 uppercase text-miami-pink">
              The Algorithmic Trust · Pegged To ETH
            </div>
            <h1 className="chrome-title text-hero leading-[0.95]">
              OLD
              <br />
              MONEY.
            </h1>
            <p className="mt-8 max-w-xl font-slab text-2xl text-miami-night md:text-3xl">
              Defended by Uniswap V4.
              <br />
              Earned in TheClub.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <button className="btn-hard bg-miami-pink text-miami-ground shadow-hard-teal">
                ENTER THE CLUB
                <span aria-hidden>→</span>
              </button>
              <button className="btn-hard border-miami-pink bg-miami-ground text-miami-pink shadow-hard-pink-sm">
                READ THE DOCS
              </button>
            </div>
          </div>

          {/* Right col: Arcade-mode stats panel */}
          <div className="md:col-span-5">
            <div className="relative">
              <div
                aria-hidden
                className="absolute -inset-3 z-0 bg-miami-pink"
                style={{ transform: "rotate(-1deg)" }}
              />
              <div className="relative z-10 border-4 border-miami-night bg-arcade-ground p-6 shadow-[10px_10px_0px_#0a0a1a]">
                <div className="mb-5 flex items-center justify-between">
                  <span
                    className="text-label uppercase text-arcade-gold neon-text"
                    style={{ letterSpacing: "0.2em" }}
                  >
                    Live · Base
                  </span>
                  <span
                    className="flex items-center gap-2 text-label uppercase text-arcade-magenta neon-text"
                    style={{ letterSpacing: "0.15em" }}
                  >
                    <span
                      className="inline-block h-2 w-2 bg-arcade-magenta"
                      style={{ animation: "neon-flicker 4s steps(1) infinite" }}
                    />
                    EPOCH 0
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <StatTile label="MONEY Price" value="1.0000" hint="WETH · TWAP" variant="pink" />
                  <StatTile label="Peg" value="100.00%" hint="Target Range" variant="cyan" />
                  <StatTile label="Supply" value="160,001" hint="MONEY · Circulating" variant="gold" />
                  <StatTile label="Treasury" value="0" hint="MONEY · Reserve" variant="purple" />
                  <StatTile label="Next Epoch" value="06:00:00" hint="HH:MM:SS" variant="cyan" />
                  <StatTile label="Bond Rate" value="—" hint="No Discount Active" variant="gold" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* === Marquee ticker === */}
      <Marquee
        items={[
          "TOMB-FAITHFUL · V4-NATIVE",
          "PEG DEFENSE · ON EVERY SWAP",
          "BOOTSTRAP · 28 EPOCHS · 4.5% APY",
          "BURN ON CONTRACTION · TIER 7 → 1500 BPS",
          "TRUSTEES → TIMELOCK",
        ]}
        speed={40}
      />

      {/* === Pillars row === */}
      <section className="relative z-10 mx-auto w-full max-w-7xl px-6 py-20 md:px-12 md:py-28">
        <div className="mb-12 flex flex-wrap items-baseline justify-between gap-4">
          <h2
            className="font-headline text-4xl font-black italic text-miami-night md:text-5xl"
            style={{ letterSpacing: "-0.02em" }}
          >
            THREE PILLARS.
          </h2>
          <p className="font-slab text-lg text-miami-night/70 md:text-xl">
            Tomb-faithful mechanics. V4-native execution.
          </p>
        </div>

        <div className="grid gap-8 md:grid-cols-3">
          <PillarCard
            number="01"
            title="TheClub"
            blurb="Stake $ESTATE. Earn $MONEY every expansion epoch. 6-epoch withdraw lock, 3-epoch reward lock. Patience is rewarded."
            cta="Stake Now"
            href="#club"
            variant="pink"
          />
          <PillarCard
            number="02"
            title="TheVault"
            blurb="Provide MONEY-WETH liquidity. Wrap your V4 NFT into ERC-20 shares. Stake for the 140k $MONEY main allocation + 59.5k $ESTATE share rewards."
            cta="Open The Vault"
            href="#vault"
            variant="yellow"
          />
          <PillarCard
            number="03"
            title="TrustNotes"
            blurb="When MONEY drops below peg, burn it for $TRUSTNOTE at a discount. Redeem at a premium when MONEY recovers above 1.10. The peg's last defense."
            cta="View Bonds"
            href="#bonds"
            variant="orange"
          />
        </div>
      </section>

      {/* === How it works (night ground) === */}
      <section className="relative z-10 bg-miami-night px-6 py-20 text-miami-ground md:px-12 md:py-28">
        <div className="mx-auto w-full max-w-7xl">
          <div className="mb-12 grid items-baseline gap-4 md:grid-cols-2">
            <h2
              className="font-headline text-4xl font-black italic text-miami-ground md:text-5xl"
              style={{ letterSpacing: "-0.02em" }}
            >
              HOW IT WORKS.
            </h2>
            <p className="font-slab text-lg text-miami-ground/70 md:text-xl">
              The flywheel: peg above 1.01 → mint MONEY → reward stakers. Peg below 1.00
              → burn MONEY for bonds → reduce supply → recover.
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-3">
            <div className="border-l-4 border-miami-teal pl-6">
              <div className="text-label mb-3 uppercase text-miami-teal">
                Step · 01 · Stake
              </div>
              <h3
                className="font-headline text-3xl font-black italic text-miami-teal text-shadow-hard-pink md:text-4xl"
                style={{ letterSpacing: "-0.01em" }}
              >
                ACQUIRE
              </h3>
              <p className="mt-4 font-body text-base text-miami-ground/80">
                Earn $MONEY in the Genesis Pool by staking WETH or USDC for 24 hours.
                Or buy on the V4 pool. Or LP MONEY-WETH and earn it in the Main Pool.
              </p>
            </div>
            <div className="border-l-4 border-miami-pink pl-6">
              <div className="text-label mb-3 uppercase text-miami-pink">
                Step · 02 · Compound
              </div>
              <h3
                className="font-headline text-3xl font-black italic text-miami-pink text-shadow-hard-teal md:text-4xl"
                style={{ letterSpacing: "-0.01em" }}
              >
                MULTIPLY
              </h3>
              <p className="mt-4 font-body text-base text-miami-ground/80">
                Buy $ESTATE. Stake in TheClub. Every expansion epoch, seigniorage flows
                pro-rata. 9-tier expansion table tops out at 4.5% of circulating supply
                per epoch.
              </p>
            </div>
            <div className="border-l-4 border-miami-orange pl-6">
              <div className="text-label mb-3 uppercase text-miami-orange">
                Step · 03 · Defend
              </div>
              <h3
                className="font-headline text-3xl font-black italic text-miami-orange text-shadow-hard-teal md:text-4xl"
                style={{ letterSpacing: "-0.01em" }}
              >
                DEFEND
              </h3>
              <p className="mt-4 font-body text-base text-miami-ground/80">
                When MONEY drops, the V4 hook burns 15% of every sell. Bond buyers
                burn even more MONEY for $TRUSTNOTE. Supply contracts. Peg recovers.
              </p>
            </div>
          </div>

          <div className="mt-20 flex flex-wrap items-center justify-between gap-6 border-t border-miami-ground/20 pt-10">
            <p
              className="font-headline text-2xl font-bold italic text-miami-pink neon-text md:text-3xl"
              style={{ letterSpacing: "0.05em" }}
            >
              POWER. WITHOUT COMPROMISE.
            </p>
            <div className="flex items-center gap-6">
              <a
                href="#twitter"
                className="text-label uppercase text-miami-ground/70 hover:text-miami-pink"
              >
                Twitter
              </a>
              <a
                href="#discord"
                className="text-label uppercase text-miami-ground/70 hover:text-miami-pink"
              >
                Discord
              </a>
              <a
                href="#github"
                className="text-label uppercase text-miami-ground/70 hover:text-miami-pink"
              >
                Github
              </a>
              <span className="text-label uppercase text-miami-ground/50">
                Base · 2026
              </span>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
