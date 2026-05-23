import { useState } from "react";
import { parseUnits } from "viem";
import { useReadContract } from "wagmi";

import { ActionPanel } from "@/components/ActionPanel";
import { LockupClock } from "@/components/LockupClock";
import { PoolEntryRow } from "@/components/PoolEntryRow";
import { RuleTrio } from "@/components/RuleTrio";
import { StatTile } from "@/components/StatTile";
import { TabBar } from "@/components/TabBar";
import { MintPositionPanel } from "@/components/MintPositionPanel";
import { WrapPanel } from "@/components/WrapPanel";

import { useApproveAndCall, useDeployment, useRewardPool, useTokenStatus } from "@/lib/hooks";
import { erc20Abi, moneyRewardPoolAbi, shareRewardPoolAbi } from "@/lib/abis";
import { formatToken } from "@/lib/format";

/**
 * The Vault — three reward pools, wired to live state.
 *
 * Pool-level state (allocation, time window) comes from each pool's first PID
 * (pid=0). Genesis has no registered PIDs at deploy time — the operator must
 * call `add(allocPoint, token, ...)` before staking opens. Until then the
 * page renders the "no stake assets registered" empty state.
 *
 * Each pool's PID 0 represents the primary stake token:
 *   Genesis pid 0 — operator-set (likely WETH or USDC at launch)
 *   Main    pid 0 — V4PositionWrapper (MONEY-WETH LP ERC-20 cert)
 *   Share   pid 0 — V4PositionWrapper (same)
 *
 * Total allocation (rewards distributed over the window) stays as protocol
 * constants because the on-chain GenesisRewardPool / MainRewardPool /
 * ShareRewardPool don't expose a single "totalRewards" view — they compute it
 * from a per-second emission rate × duration.
 */

type PoolId = "genesis" | "main" | "share";

interface PoolMeta {
  numeral: "I" | "II" | "III";
  formalName: string;
  subtitle: string;
  gloss: string;
  totalAllocation: string;
  rewardAsset: "MONEY" | "ESTATE";
  defaultStakeLabel: string;
}

const META: Record<PoolId, PoolMeta> = {
  genesis: {
    numeral: "I",
    formalName: "The Genesis Window",
    subtitle: "Twenty-Four Hours · Founders Only",
    gloss:
      "Deposit your $WETH, $USDC, or other outside assets for twenty-four hours. Receive $MONEY pro-rata. The bootstrap of The Trust.",
    totalAllocation: "11,000",
    rewardAsset: "MONEY",
    defaultStakeLabel: "Operator-Set Stake Token",
  },
  main: {
    numeral: "II",
    formalName: "The Main Pool",
    subtitle: "Nine Days · The MONEY-WETH Liquidity Provider",
    gloss:
      "Provide MONEY-WETH liquidity on Uniswap V4. Wrap the position into an ERC-20 certificate. Stake the certificate here.",
    totalAllocation: "140,000",
    rewardAsset: "MONEY",
    defaultStakeLabel: "OM · MONEY-WETH LP",
  },
  share: {
    numeral: "III",
    formalName: "The Share Distribution",
    subtitle: "Three Hundred Seventy Days · ESTATE Issuance",
    gloss:
      "The long emission. Fifty-nine thousand five hundred $ESTATE distributed to LP stakers across three hundred seventy days.",
    totalAllocation: "59,500",
    rewardAsset: "ESTATE",
    defaultStakeLabel: "OM · MONEY-WETH LP",
  },
};

export function TheVault() {
  const [activeId, setActiveId] = useState<PoolId>("genesis");
  const deployment = useDeployment();
  const meta = META[activeId];

  const action = useApproveAndCall();

  function parseAmount(s: string): bigint {
    try {
      return parseUnits(s || "0", 18);
    } catch {
      return 0n;
    }
  }

  const poolAddress =
    activeId === "genesis"
      ? deployment?.genesisRewardPool
      : activeId === "main"
        ? deployment?.mainRewardPool
        : deployment?.shareRewardPool;

  const reward = meta.rewardAsset === "MONEY" ? "money" : "share";
  const pid0 = useRewardPool({ pool: poolAddress, pid: 0, reward });

  // Wallet balance + allowance for the stake token (pid 0). When the pool has
  // no PIDs yet, stakeToken is undefined; the hook returns 0 in that case.
  const tokenStatus = useTokenStatus(pid0.stakeToken, poolAddress);

  // Read the actual stake-token symbol so the UI labels reflect what's registered
  // on-chain (WETH / USDC / etc.) rather than the hardcoded placeholder.
  const symbolRead = useReadContract({
    address: pid0.stakeToken,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: !!pid0.stakeToken && pid0.exists },
  });
  const stakeLabel = pid0.exists && symbolRead.data ? symbolRead.data : meta.defaultStakeLabel;

  // Window-end countdown. Genesis/Main expose poolEndTime; Share extends 370d.
  // We only render poolStartTime + a fixed window duration, since the contract
  // doesn't expose a public end-time view for Share.
  // For now: until-window-end is computed lazily — Sprint C polish hooks this.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const startTime = pid0.poolStartTime;
  const windowSec =
    activeId === "genesis"
      ? BigInt(86_400) // 24h
      : activeId === "main"
        ? BigInt(9 * 86_400) // 9d
        : BigInt(370 * 86_400); // 370d
  const endTime = startTime > 0n ? startTime + windowSec : 0n;
  const secondsUntilEnd = endTime > nowSec ? Number(endTime - nowSec) : 0;

  // Status label
  let status = "Loading…";
  if (deployment) {
    if (!pid0.exists) status = "No Stakes Registered";
    else if (startTime > nowSec) status = "Awaiting Open";
    else if (endTime > nowSec) status = "Open";
    else status = "Window Closed";
  }

  const yourStakeDisplay = formatToken(pid0.yourStake, 4);
  const pendingDisplay = formatToken(pid0.pending, 4);
  const walletDisplay = formatToken(tokenStatus.balance, 4);

  const poolAbi = reward === "money" ? moneyRewardPoolAbi : shareRewardPoolAbi;
  const refetchAll = () => {
    pid0.refetch();
    tokenStatus.refetch();
  };

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
          <div className="label-deco mb-3 text-deco-gold-dark">{meta.subtitle}</div>
          <h2
            className="mb-4 font-display text-3xl italic text-deco-ivory md:text-4xl"
            style={{ letterSpacing: "0.06em" }}
          >
            {meta.formalName}
          </h2>
          <div className="mx-auto mb-8 h-[2px] w-12 bg-deco-gold" aria-hidden />
          <p className="mx-auto mb-12 max-w-2xl font-body text-base text-deco-ivory-soft md:text-lg">
            {meta.gloss}
          </p>

          <div className="mb-10 grid grid-cols-1 gap-5 md:grid-cols-4">
            <StatTile
              label="Total Allocation"
              value={meta.totalAllocation}
              hint={`$${meta.rewardAsset} · Across The Window`}
            />
            <StatTile
              label="Your Stake"
              value={yourStakeDisplay}
              hint="Across All Entries"
            />
            <StatTile
              label="Your Pending"
              value={pendingDisplay}
              hint={`$${meta.rewardAsset} · Unclaimed`}
            />
            <StatTile label="Status" value={status} hint="Window State" />
          </div>

          {/* Window countdown */}
          <div className="deco-panel mx-auto max-w-md">
            <LockupClock
              label="Closes In"
              secondsRemaining={secondsUntilEnd}
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
            {!pid0.exists ? (
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
                  <PoolEntryRow
                    pid={0}
                    stakeToken={stakeLabel}
                    allocPoint={Number(pid0.allocPoint)}
                    yourBalance={walletDisplay}
                    yourStake={yourStakeDisplay}
                    poolBalance="—" /* Sprint C: token.balanceOf(pool) read */
                  />
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      {/* ===== Mint + Wrap (Main + Share only) ===== */}
      {(activeId === "main" || activeId === "share") && (
        <section className="px-6 pb-12 md:px-12 md:pb-16">
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <MintPositionPanel poolName={meta.formalName} />
            <WrapPanel poolName={meta.formalName} />
          </div>
        </section>
      )}

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
              blurb={`Deposit your stake asset. Begin earning $${meta.rewardAsset} pro-rata.`}
              asset={stakeLabel}
              maxAvailable={walletDisplay}
              maxWei={tokenStatus.balance}
              cta={action.isInFlight ? "Awaiting…" : "Authorize · Stake"}
              disabled={
                !pid0.exists ||
                tokenStatus.balance === 0n ||
                action.isInFlight ||
                !poolAddress ||
                !pid0.stakeToken
              }
              disabledReason={
                !pid0.exists ? "No stake asset registered." : "No stake asset in wallet."
              }
              onSubmit={(s) => {
                if (!poolAddress || !pid0.stakeToken) return;
                const amount = parseAmount(s);
                if (amount <= 0n) return;
                action.submit({
                  amount,
                  currentAllowance: tokenStatus.allowance,
                  token: pid0.stakeToken,
                  spender: poolAddress,
                  call: {
                    address: poolAddress,
                    abi: poolAbi,
                    functionName: "deposit",
                    args: [0n, amount],
                  },
                  label: `Deposit into ${meta.formalName}`,
                  onSuccess: refetchAll,
                });
              }}
            />
            <ActionPanel
              numeral="II"
              title="Withdraw"
              blurb="Recall your stake. Pending rewards are claimed automatically."
              asset={stakeLabel}
              maxAvailable={yourStakeDisplay}
              maxWei={pid0.yourStake}
              cta={action.isInFlight ? "Awaiting…" : "Withdraw"}
              disabled={pid0.yourStake === 0n || action.isInFlight || !poolAddress}
              disabledReason="Nothing currently deposited."
              onSubmit={(s) => {
                if (!poolAddress) return;
                const amount = parseAmount(s);
                if (amount <= 0n) return;
                action.submit({
                  amount: 0n,
                  currentAllowance: 0n,
                  token: null,
                  spender: null,
                  call: {
                    address: poolAddress,
                    abi: poolAbi,
                    functionName: "withdraw",
                    args: [0n, amount],
                  },
                  label: `Withdraw from ${meta.formalName}`,
                  onSuccess: refetchAll,
                });
              }}
            />
            <ActionPanel
              numeral="III"
              title="Forfeit & Withdraw"
              blurb="Emergency exit. Returns your stake but FORFEITS all pending rewards. Use only if compelled."
              asset={stakeLabel}
              maxAvailable={yourStakeDisplay}
              cta={action.isInFlight ? "Awaiting…" : "Forfeit · Exit"}
              noInput
              disabled={pid0.yourStake === 0n || action.isInFlight || !poolAddress}
              disabledReason="Nothing currently deposited."
              onSubmit={() => {
                if (!poolAddress) return;
                action.submit({
                  amount: 0n,
                  currentAllowance: 0n,
                  token: null,
                  spender: null,
                  call: {
                    address: poolAddress,
                    abi: poolAbi,
                    functionName: "emergencyWithdraw",
                    args: [0n],
                  },
                  label: `Forfeit · ${meta.formalName}`,
                  onSuccess: refetchAll,
                });
              }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
