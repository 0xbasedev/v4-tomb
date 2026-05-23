import { useState } from "react";

import { ActionPanel } from "@/components/ActionPanel";
import { LockupClock } from "@/components/LockupClock";
import { PoolEntryRow } from "@/components/PoolEntryRow";
import { RuleTrio } from "@/components/RuleTrio";
import { StatTile } from "@/components/StatTile";
import { TabBar } from "@/components/TabBar";

/**
 * The Vault — three reward pools.
 *
 * Tabs:
 *   I.  Genesis — 24-hour window, accepts outside ERC-20s, distributes 11,000 MONEY
 *   II. Main    — 9-day distribution across 2 epochs (80k + 60k), accepts MONEY/WETH LP
 *                 wrapper, distributes 140,000 MONEY
 *   III. Share  — 370-day distribution, accepts MONEY/WETH LP wrapper (and eventually
 *                 ESTATE/WETH), distributes 59,500 ESTATE
 *
 * Each pool's layout (under the tab):
 *   1. Pool overview — formal title + subtitle, 4 stat tiles (allocation, your stake,
 *      pending, status), single LockupClock for window-end countdown
 *   2. Pool entries table — registered stake tokens with PID / token / alloc / your
 *      balance / your stake
 *   3. Actions — 3-column ActionPanel grid (Make a Deposit / Withdraw / Forfeit & Withdraw)
 */

type PoolId = "genesis" | "main" | "share";

interface PoolView {
  id: PoolId;
  numeral: "I" | "II" | "III";
  formalName: string;
  subtitle: string;
  gloss: string;
  totalAllocation: string;
  rewardAsset: string;
  windowLabel: string;
  windowSecondsRemaining: number;
  status: string;
  yourStake: string;
  pending: string;
  entries: {
    pid: number;
    stakeToken: string;
    allocPoint: number;
    yourBalance: string;
    yourStake: string;
    poolBalance: string;
  }[];
}

const POOLS: Record<PoolId, PoolView> = {
  genesis: {
    id: "genesis",
    numeral: "I",
    formalName: "The Genesis Window",
    subtitle: "Twenty-Four Hours · Founders Only",
    gloss:
      "Deposit your $WETH, $USDC, or other outside assets for twenty-four hours. Receive $MONEY pro-rata. The bootstrap of The Trust.",
    totalAllocation: "11,000",
    rewardAsset: "MONEY",
    windowLabel: "Closes In",
    windowSecondsRemaining: 86_400, // 24h placeholder
    status: "Awaiting Operator Open",
    yourStake: "0",
    pending: "0",
    entries: [
      // Operator-set; empty until script/OpenLaunch runs.
    ],
  },
  main: {
    id: "main",
    numeral: "II",
    formalName: "The Main Pool",
    subtitle: "Nine Days · The MONEY-WETH Liquidity Provider",
    gloss:
      "Provide MONEY-WETH liquidity on Uniswap V4. Wrap the position into an ERC-20 certificate. Stake the certificate here. Eighty thousand $MONEY across the first four days, sixty thousand across the next five.",
    totalAllocation: "140,000",
    rewardAsset: "MONEY",
    windowLabel: "Closes In",
    windowSecondsRemaining: 9 * 86_400, // 9 days placeholder
    status: "Awaiting Genesis Close",
    yourStake: "0",
    pending: "0",
    entries: [
      {
        pid: 0,
        stakeToken: "OM · MONEY-WETH LP",
        allocPoint: 100,
        yourBalance: "0",
        yourStake: "0",
        poolBalance: "0",
      },
    ],
  },
  share: {
    id: "share",
    numeral: "III",
    formalName: "The Share Distribution",
    subtitle: "Three Hundred Seventy Days · ESTATE Issuance",
    gloss:
      "The long emission. Fifty-nine thousand five hundred $ESTATE distributed to LP stakers across three hundred seventy days. Earn the share token. Stake the share at The Club.",
    totalAllocation: "59,500",
    rewardAsset: "ESTATE",
    windowLabel: "Closes In",
    windowSecondsRemaining: 370 * 86_400,
    status: "Awaiting Genesis Close",
    yourStake: "0",
    pending: "0",
    entries: [
      {
        pid: 0,
        stakeToken: "OM · MONEY-WETH LP",
        allocPoint: 100,
        yourBalance: "0",
        yourStake: "0",
        poolBalance: "0",
      },
    ],
  },
};

export function TheVault() {
  const [activeId, setActiveId] = useState<PoolId>("genesis");
  const pool = POOLS[activeId];

  return (
    <div className="bg-deco-ground">
      {/* ===== Heading ===== */}
      <section className="relative px-6 pt-16 pb-12 md:px-12 md:pt-20 md:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">
            A Pavilion of The Trust · The Distribution Engines
          </div>
          <div
            className="font-ornament mb-4 text-3xl font-bold text-deco-gold"
            style={{ letterSpacing: "0.2em" }}
          >
            II
          </div>
          <h1 className="gold-text font-display italic text-section">The Vault</h1>
          <RuleTrio className="mb-6 mt-8" />
          <p
            className="mx-auto max-w-2xl font-headline text-lg italic text-deco-ivory-soft md:text-xl"
            style={{ letterSpacing: "0.04em" }}
          >
            Three windows of issuance. The Genesis for the Founders, the Main for the
            Providers of Liquidity, the Share for those who endure.
          </p>
        </div>
      </section>

      {/* ===== Tabs ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-12">
        <TabBar
          active={activeId}
          onChange={(id) => setActiveId(id as PoolId)}
          items={[
            { id: "genesis", numeral: "I", label: "Genesis", sublabel: "24 Hours" },
            { id: "main", numeral: "II", label: "Main", sublabel: "9 Days" },
            { id: "share", numeral: "III", label: "Share", sublabel: "370 Days" },
          ]}
        />
      </section>

      {/* ===== Active Pool Overview ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">{pool.subtitle}</div>
          <h2
            className="mb-4 font-display text-3xl italic text-deco-ivory md:text-4xl"
            style={{ letterSpacing: "0.06em" }}
          >
            {pool.formalName}
          </h2>
          <div className="mx-auto mb-8 h-[2px] w-12 bg-deco-gold" aria-hidden />
          <p className="mx-auto mb-12 max-w-2xl font-body text-base text-deco-ivory-soft md:text-lg">
            {pool.gloss}
          </p>

          <div className="mb-10 grid grid-cols-1 gap-5 md:grid-cols-4">
            <StatTile
              label="Total Allocation"
              value={pool.totalAllocation}
              hint={`$${pool.rewardAsset} · Across The Window`}
            />
            <StatTile
              label="Your Stake"
              value={pool.yourStake}
              hint="Across All Entries"
            />
            <StatTile
              label="Your Pending"
              value={pool.pending}
              hint={`$${pool.rewardAsset} · Unclaimed`}
            />
            <StatTile label="Status" value={pool.status} hint="Set By Operator" />
          </div>

          {/* Window countdown */}
          <div className="deco-panel mx-auto max-w-md">
            <LockupClock
              label={pool.windowLabel}
              secondsRemaining={pool.windowSecondsRemaining}
              unlockedLabel="Window Has Closed"
            />
          </div>
        </div>
      </section>

      {/* ===== Pool Entries ===== */}
      <section className="px-6 pb-12 md:px-12 md:pb-16">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            Registered Stake Assets
          </div>

          <div className="deco-panel overflow-x-auto p-0">
            {pool.entries.length === 0 ? (
              <div className="py-12 text-center">
                <p className="mx-auto max-w-md font-body text-base italic text-deco-ivory-soft">
                  No stake assets registered. The Operator must call{" "}
                  <code className="font-ornament text-deco-gold">add(allocPoint, token)</code> to
                  open this pool for deposits.
                </p>
              </div>
            ) : (
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-deco-gold/30">
                    <th className="label-deco px-5 py-4 text-deco-gold-dark">PID</th>
                    <th className="label-deco px-5 py-4 text-deco-gold-dark">Stake Asset</th>
                    <th className="label-deco px-5 py-4 text-deco-gold-dark">Allocation</th>
                    <th className="label-deco px-5 py-4 text-deco-gold-dark">Pool Balance</th>
                    <th className="label-deco px-5 py-4 text-deco-gold-dark">Your Stake</th>
                    <th className="label-deco px-5 py-4 text-right text-deco-gold-dark">
                      In Your Wallet
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pool.entries.map((entry) => (
                    <PoolEntryRow key={entry.pid} {...entry} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      {/* ===== Actions ===== */}
      <section className="px-6 pb-20 md:px-12 md:pb-28">
        <div className="mx-auto max-w-7xl">
          <div className="label-deco mb-6 text-center text-deco-gold-dark">
            The Actions of The Depositor
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            <ActionPanel
              numeral="I"
              title="Make a Deposit"
              blurb={`Deposit your stake asset. Begin earning $${pool.rewardAsset} pro-rata.`}
              asset={pool.entries[0]?.stakeToken ?? "—"}
              maxAvailable={pool.entries[0]?.yourBalance ?? "0"}
              cta="Authorize · Stake"
              disabled={pool.entries.length === 0}
              disabledReason="No stake asset registered."
            />
            <ActionPanel
              numeral="II"
              title="Withdraw"
              blurb="Recall your stake. Pending rewards are claimed automatically."
              asset={pool.entries[0]?.stakeToken ?? "—"}
              maxAvailable={pool.entries[0]?.yourStake ?? "0"}
              cta="Withdraw"
              disabled={(pool.entries[0]?.yourStake ?? "0") === "0"}
              disabledReason="Nothing currently deposited."
            />
            <ActionPanel
              numeral="III"
              title="Forfeit & Withdraw"
              blurb="Emergency exit. Returns your stake but FORFEITS all pending rewards. Use only if compelled."
              asset={pool.entries[0]?.stakeToken ?? "—"}
              maxAvailable={pool.entries[0]?.yourStake ?? "0"}
              cta="Forfeit · Exit"
              noInput
              disabled={(pool.entries[0]?.yourStake ?? "0") === "0"}
              disabledReason="Nothing currently deposited."
            />
          </div>
        </div>
      </section>
    </div>
  );
}
