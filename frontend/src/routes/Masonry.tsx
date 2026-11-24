import { parseUnits } from "viem";

import { ActionPanel } from "@/components/ActionPanel";
import { LockupClock } from "@/components/LockupClock";
import { RuleTrio } from "@/components/RuleTrio";
import { StatTile } from "@/components/StatTile";

import { useApproveAndCall, useMasonry, useDeployment, useEpoch } from "@/lib/hooks";
import { masonryAbi } from "@/lib/abis";
import { formatToken } from "@/lib/format";

/**
 * The Masonry — Masonry interface, wired to live state.
 *
 * Lockup remaining seconds derivation:
 *   The Masonry's `epochTimerStart` is the epoch index at the user's last
 *   stake/withdraw/claim. They can withdraw when `currentEpoch - timerStart >=
 *   withdrawLockupEpochs` and claim when `>= rewardLockupEpochs`.
 *
 *   Remaining-time math: (timerStart + lockupEpochs) is the epoch at which the
 *   gate opens. Multiplied by PERIOD (6h) and added to startTime, we get the
 *   absolute unlock timestamp. The hook can't run this multiplication because
 *   it'd need PERIOD; we compose it here using useEpoch's period + startTime.
 *
 * Write actions (stake/withdraw/claim) are placeholders this turn — wired in T9.
 */
export function Masonry() {
  const deployment = useDeployment();
  const epoch = useEpoch();
  const masonry = useMasonry();

  function parseAmount(s: string): bigint {
    try {
      return parseUnits(s || "0", 18);
    } catch {
      return 0n;
    }
  }

  // One shared write pipeline — The Masonry only ever runs one action at a time.
  const action = useApproveAndCall();

  // Lockup countdown derivation. PERIOD is the Treasury epoch length (6h);
  // each epoch nextEpochPoint = startTime + epoch * PERIOD.
  const period = epoch.period ?? 0n;
  const startTime = epoch.startTime ?? 0n;
  const currentEpoch = epoch.epoch ?? 0n;
  const timerStart = masonry.epochTimerStart ?? 0n;
  const wLockup = masonry.withdrawLockupEpochs ?? 0n;
  const rLockup = masonry.rewardLockupEpochs ?? 0n;

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  function lockupSeconds(lockup: bigint): number {
    if (currentEpoch === 0n && timerStart === 0n) return 0; // never staked
    const unlockEpoch = timerStart + lockup;
    if (unlockEpoch <= currentEpoch) return 0;
    const unlockAt = startTime + unlockEpoch * period;
    if (unlockAt <= nowSec) return 0;
    return Number(unlockAt - nowSec);
  }
  const withdrawLockupSec = lockupSeconds(wLockup);
  const claimLockupSec = lockupSeconds(rLockup);

  const stakedDisplay = formatToken(masonry.yourStake, 4);
  const pendingDisplay = formatToken(masonry.earned, 4);
  const walletDisplay = formatToken(masonry.shareInWallet, 4);
  const totalDisplay = formatToken(masonry.totalStaked, 2);

  // Disable Withdraw/Claim when timer hasn't matured, or when nothing to act on.
  const cantWithdraw = !masonry.canWithdraw || masonry.yourStake === 0n;
  const cantClaim = !masonry.canClaimReward || masonry.earned === 0n;

  return (
    <div className="bg-deco-ground">
      {/* ===== Heading ===== */}
      <section className="relative px-6 pt-16 pb-12 md:px-12 md:pt-20 md:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">
            A Pavilion of The Trust · The Masonry
          </div>
          <div
            className="font-ornament mb-4 text-3xl font-bold text-deco-gold"
            style={{ letterSpacing: "0.2em" }}
          >
            I
          </div>
          <h1 className="gold-text font-display italic text-section">The Masonry</h1>
          <RuleTrio className="mb-6 mt-8" />
          <p
            className="mx-auto max-w-2xl font-headline text-lg italic text-deco-ivory-soft md:text-xl"
            style={{ letterSpacing: "0.04em" }}
          >
            Members stake $SQUARE. Members receive $LEVEL each expansion epoch.
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
            <StatTile label="Staked" value={stakedDisplay} hint="$SQUARE · in The Masonry" />
            <StatTile label="Pending" value={pendingDisplay} hint="$LEVEL · Unclaimed" />
            <StatTile label="In Wallet" value={walletDisplay} hint="$SQUARE · Available" />
            <StatTile
              label="Last Activity"
              value={timerStart > 0n ? `Epoch ${timerStart.toString()}` : "—"}
              hint="Resets Each Stake or Claim"
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
              blurb="Deposit $SQUARE into the Masonry. Begin earning seigniorage each expansion epoch."
              asset="SQUARE"
              maxAvailable={walletDisplay}
              maxWei={masonry.shareInWallet ?? 0n}
              cta={action.isInFlight ? "Awaiting…" : "Authorize · Stake"}
              disabled={masonry.shareInWallet === 0n || action.isInFlight || !deployment}
              disabledReason="No $SQUARE in wallet."
              onSubmit={(s) => {
                if (!deployment) return;
                const amount = parseAmount(s);
                if (amount <= 0n) return;
                action.submit({
                  amount,
                  currentAllowance: masonry.shareAllowance ?? 0n,
                  token: deployment.share,
                  spender: deployment.masonry,
                  call: {
                    address: deployment.masonry,
                    abi: masonryAbi,
                    functionName: "stake",
                    args: [amount],
                  },
                  label: "Stake into The Masonry",
                  onSuccess: () => masonry.refetch(),
                });
              }}
            />
            <ActionPanel
              numeral="II"
              title="Withdraw"
              blurb="Recall your $SQUARE from the Masonry. Six-epoch lock from your last interaction."
              asset="SQUARE"
              maxAvailable={stakedDisplay}
              maxWei={masonry.yourStake ?? 0n}
              cta={action.isInFlight ? "Awaiting…" : "Withdraw"}
              disabled={cantWithdraw || action.isInFlight || !deployment}
              disabledReason={
                masonry.yourStake === 0n
                  ? "Nothing currently deposited."
                  : "Withdraw lockup not yet matured."
              }
              onSubmit={(s) => {
                if (!deployment) return;
                const amount = parseAmount(s);
                if (amount <= 0n) return;
                action.submit({
                  amount: 0n,
                  currentAllowance: 0n,
                  token: null,
                  spender: null,
                  call: {
                    address: deployment.masonry,
                    abi: masonryAbi,
                    functionName: "withdraw",
                    args: [amount],
                  },
                  label: "Withdraw from The Masonry",
                  onSuccess: () => masonry.refetch(),
                });
              }}
            />
            <ActionPanel
              numeral="III"
              title="Claim Your Returns"
              blurb="Claim accrued $LEVEL. Three-epoch lock from your last interaction."
              asset="LEVEL"
              maxAvailable={pendingDisplay}
              cta={action.isInFlight ? "Awaiting…" : "Claim Returns"}
              noInput
              disabled={cantClaim || action.isInFlight || !deployment}
              disabledReason={
                masonry.earned === 0n
                  ? "No returns currently accrued."
                  : "Reward lockup not yet matured."
              }
              onSubmit={() => {
                if (!deployment) return;
                action.submit({
                  amount: 0n,
                  currentAllowance: 0n,
                  token: null,
                  spender: null,
                  call: {
                    address: deployment.masonry,
                    abi: masonryAbi,
                    functionName: "claimReward",
                    args: [],
                  },
                  label: "Claim Returns",
                  onSuccess: () => masonry.refetch(),
                });
              }}
            />
          </div>
        </div>
      </section>

      {/* ===== Masonry State ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The State of The Masonry
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
            <StatTile
              label="Aggregate Deposited"
              value={totalDisplay}
              hint="$SQUARE · in The Masonry"
            />
            <StatTile
              label="Withdraw Lockup"
              value={wLockup > 0n ? `${wLockup.toString()} Epochs` : "—"}
              hint="From Last Interaction"
            />
            <StatTile
              label="Reward Lockup"
              value={rLockup > 0n ? `${rLockup.toString()} Epochs` : "—"}
              hint="From Last Interaction"
            />
            <StatTile
              label="Current Epoch"
              value={currentEpoch.toString()}
              hint="As Counted by The Treasury"
            />
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
              The Lockups of The Masonry
            </h2>
            <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
            <div className="grid grid-cols-1 gap-6 text-left md:grid-cols-2">
              <div className="border-l border-deco-gold/40 pl-5">
                <div className="label-deco mb-2 text-deco-gold">Withdraw Lockup</div>
                <div
                  className="font-display text-3xl text-deco-ivory"
                  style={{ letterSpacing: "0.05em" }}
                >
                  {wLockup > 0n ? wLockup.toString() : "6"}{" "}
                  <span className="font-ornament text-base text-deco-gold-dark">EPOCHS</span>
                </div>
                <p className="mt-2 font-body text-sm italic text-deco-ivory-soft">
                  Counted from your last interaction with the Masonry — any stake,
                  withdraw, or claim resets the clock.
                </p>
              </div>
              <div className="border-l border-deco-gold/40 pl-5">
                <div className="label-deco mb-2 text-deco-gold">Reward Lockup</div>
                <div
                  className="font-display text-3xl text-deco-ivory"
                  style={{ letterSpacing: "0.05em" }}
                >
                  {rLockup > 0n ? rLockup.toString() : "3"}{" "}
                  <span className="font-ornament text-base text-deco-gold-dark">EPOCHS</span>
                </div>
                <p className="mt-2 font-body text-sm italic text-deco-ivory-soft">
                  The Members do not extract on impulse. The Trust observes its own
                  equilibrium.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
