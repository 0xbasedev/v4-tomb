import { ActionPanel } from "@/components/ActionPanel";
import { LockupClock } from "@/components/LockupClock";
import { RuleTrio } from "@/components/RuleTrio";
import { StatTile } from "@/components/StatTile";

/**
 * The Club — Boardroom interface. Members stake $ESTATE, receive $MONEY each
 * expansion epoch.
 *
 * Layout (centered vertical axis throughout):
 *   1. Heading — "The Club" with imperial label + rule trio
 *   2. Position overview — 4 tiles + 2 lockup clocks (Withdraw / Claim)
 *   3. Actions — 3 ActionPanel cards (Make Deposit / Withdraw / Claim Returns)
 *   4. Boardroom state — 4 read-only tiles
 *   5. The Lockup Schedule — formal explanation panel
 *
 * All values + actions are PLACEHOLDERS. Sprint B wires:
 *   - useReadContract → estate.balanceOf(user), boardroom.balanceOf(user),
 *     boardroom.earned(user), boardroom.canWithdraw(user), boardroom.canClaimReward(user),
 *     treasury.epoch(), treasury.nextEpochPoint(), boardroom.totalSupply()
 *   - useWriteContract → estate.approve(boardroom), boardroom.stake, boardroom.withdraw,
 *     boardroom.claimReward
 */
export function TheClub() {
  // Placeholder values — Sprint B wires live reads.
  const positionStakedEstate = "0";
  const pendingMoney = "0";
  const walletEstate = "0";
  const lifetimeClaimed = "0";

  // Placeholder lockup seconds — neither active yet
  const withdrawLockupSec = 0;
  const claimLockupSec = 0;

  // Boardroom state placeholders
  const boardroomTotalStaked = "1";
  const lifetimeDistributed = "0";
  const lastDistribution = "0";

  return (
    <div className="bg-deco-ground">
      {/* ===== Heading ===== */}
      <section className="relative px-6 pt-16 pb-12 md:px-12 md:pt-20 md:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">
            A Pavilion of The Trust · The Boardroom
          </div>
          <div
            className="font-ornament mb-4 text-3xl font-bold text-deco-gold"
            style={{ letterSpacing: "0.2em" }}
          >
            I
          </div>
          <h1 className="gold-text font-display italic text-section">The Club</h1>
          <RuleTrio className="mb-6 mt-8" />
          <p
            className="mx-auto max-w-2xl font-headline text-lg italic text-deco-ivory-soft md:text-xl"
            style={{ letterSpacing: "0.04em" }}
          >
            Members stake $ESTATE. Members receive $MONEY each expansion epoch.
            Patience is rewarded.
          </p>
        </div>
      </section>

      {/* ===== Your Position ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            Your Position
          </div>
          <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-4">
            <StatTile
              label="Staked"
              value={positionStakedEstate}
              hint="$ESTATE · in The Club"
            />
            <StatTile label="Pending" value={pendingMoney} hint="$MONEY · Unclaimed" />
            <StatTile label="In Wallet" value={walletEstate} hint="$ESTATE · Available" />
            <StatTile
              label="Lifetime"
              value={lifetimeClaimed}
              hint="$MONEY · Claimed To Date"
            />
          </div>

          {/* Lockup clocks */}
          <div className="deco-panel mx-auto grid max-w-3xl grid-cols-1 gap-8 md:grid-cols-2">
            <LockupClock
              label="Withdraw Available In"
              secondsRemaining={withdrawLockupSec}
            />
            <LockupClock
              label="Claim Available In"
              secondsRemaining={claimLockupSec}
            />
          </div>
        </div>
      </section>

      {/* ===== Actions ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The Actions of The Member
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            <ActionPanel
              numeral="I"
              title="Make a Deposit"
              blurb="Deposit $ESTATE into the Boardroom. Begin earning seigniorage each expansion epoch."
              asset="ESTATE"
              maxAvailable={walletEstate}
              cta="Authorize · Stake"
            />
            <ActionPanel
              numeral="II"
              title="Withdraw"
              blurb="Recall your $ESTATE from the Boardroom. Six-epoch lock from your last interaction."
              asset="ESTATE"
              maxAvailable={positionStakedEstate}
              cta="Withdraw"
              disabled={positionStakedEstate === "0"}
              disabledReason="No $ESTATE currently deposited."
            />
            <ActionPanel
              numeral="III"
              title="Claim Your Returns"
              blurb="Claim accrued $MONEY. Three-epoch lock from your last interaction."
              asset="MONEY"
              maxAvailable={pendingMoney}
              cta="Claim Returns"
              noInput
              disabled={pendingMoney === "0"}
              disabledReason="No returns currently accrued."
            />
          </div>
        </div>
      </section>

      {/* ===== Boardroom State ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The State of The Boardroom
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
            <StatTile
              label="Aggregate Deposited"
              value={boardroomTotalStaked}
              hint="$ESTATE · in The Club"
            />
            <StatTile
              label="Distributed To Date"
              value={lifetimeDistributed}
              hint="$MONEY · Lifetime"
            />
            <StatTile
              label="Last Epoch"
              value={lastDistribution}
              hint="$MONEY · Distributed"
            />
            <StatTile label="Member Count" value="1" hint="Including The Founder" />
          </div>
        </div>
      </section>

      {/* ===== The Lockup Schedule ===== */}
      <section className="px-6 pb-20 md:px-12 md:pb-28">
        <div className="mx-auto max-w-3xl">
          <div className="deco-panel">
            <div className="label-deco mb-3 text-deco-gold-dark">The Schedule</div>
            <h2
              className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl"
              style={{ letterSpacing: "0.06em" }}
            >
              The Lockups of The Club
            </h2>
            <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
            <div className="grid grid-cols-1 gap-6 text-left md:grid-cols-2">
              <div className="border-l border-deco-gold/40 pl-5">
                <div className="label-deco mb-2 text-deco-gold">Withdraw Lockup</div>
                <div
                  className="font-display text-3xl text-deco-ivory"
                  style={{ letterSpacing: "0.05em" }}
                >
                  6 <span className="font-ornament text-base text-deco-gold-dark">EPOCHS</span>
                </div>
                <p className="mt-2 font-body text-sm italic text-deco-ivory-soft">
                  Thirty-six hours. Counted from your last interaction with the Boardroom — any stake, withdraw, or claim resets the clock.
                </p>
              </div>
              <div className="border-l border-deco-gold/40 pl-5">
                <div className="label-deco mb-2 text-deco-gold">Reward Lockup</div>
                <div
                  className="font-display text-3xl text-deco-ivory"
                  style={{ letterSpacing: "0.05em" }}
                >
                  3 <span className="font-ornament text-base text-deco-gold-dark">EPOCHS</span>
                </div>
                <p className="mt-2 font-body text-sm italic text-deco-ivory-soft">
                  Eighteen hours. The Members do not extract on impulse. The Trust observes its own equilibrium.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
