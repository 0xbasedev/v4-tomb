import { useReadContracts } from "wagmi";

import { genesisRewardPoolAbi, hookAbi, treasuryAbi } from "@/lib/abis";
import { useDeployment, useEpoch, useMoneyMarket } from "@/lib/hooks";
import { formatCountdown } from "@/lib/format";

/**
 * LaunchSequence — single canonical view of "where are we in the launch path."
 *
 * Reads every step's on-chain marker, computes its status (done / current /
 * blocked / future), and renders a vertical Art Deco timeline. The current
 * row is highlighted; done rows show emerald checks; future rows show ivory
 * markers waiting their turn.
 *
 * The actual action buttons live in the panels below this overview. This
 * component is read-only — its job is "what should I do next?" not "do it."
 */

type StepStatus = "done" | "current" | "blocked" | "future";

interface Step {
  numeral: string;
  title: string;
  detail: string;
  status: StepStatus;
  /** Anchor id to scroll to when the user clicks the row. */
  anchor?: string;
}

export function LaunchSequence() {
  const deployment = useDeployment();
  const epoch = useEpoch();
  const market = useMoneyMarket();

  // Direct multicall here (not via useBoardroom etc.) — these specific reads
  // exist nowhere else in the hook layer and adding hooks just for the wizard
  // would be over-abstraction. One off, clear.
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: deployment
      ? [
          { address: deployment.hook, abi: hookAbi, functionName: "bound" },
          { address: deployment.hook, abi: hookAbi, functionName: "autoCalculateTax" },
          { address: deployment.hook, abi: hookAbi, functionName: "trustees" },
          { address: deployment.genesisRewardPool, abi: genesisRewardPoolAbi, functionName: "poolStartTime" },
          { address: deployment.genesisRewardPool, abi: genesisRewardPoolAbi, functionName: "operator" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "operator" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "daoFundSharedPercent" },
          { address: deployment.treasury, abi: treasuryAbi, functionName: "devFundSharedPercent" },
        ]
      : [],
    query: { enabled: !!deployment, refetchInterval: 30_000 },
  });

  const poolBound = data?.[0]?.status === "success" ? (data[0].result as boolean) : false;
  const autoTaxOn = data?.[1]?.status === "success" ? (data[1].result as boolean) : false;
  const hookTrustees = data?.[2]?.status === "success" ? (data[2].result as `0x${string}`) : undefined;
  const genesisStartTime = data?.[3]?.status === "success" ? (data[3].result as bigint) : 0n;
  const genesisOperator = data?.[4]?.status === "success" ? (data[4].result as `0x${string}`) : undefined;
  const treasuryOperator = data?.[5]?.status === "success" ? (data[5].result as `0x${string}`) : undefined;
  const daoPct = data?.[6]?.status === "success" ? (data[6].result as bigint) : 0n;
  const devPct = data?.[7]?.status === "success" ? (data[7].result as bigint) : 0n;

  // Derive state.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const genesisWindowOpen =
    genesisStartTime > 0n && nowSec >= genesisStartTime && nowSec < genesisStartTime + 86_400n;
  const genesisWindowClosed = genesisStartTime > 0n && nowSec >= genesisStartTime + 86_400n;

  const currentEpoch = Number(epoch.epoch ?? 0n);
  const bootstrapEpochs = Number(market.bootstrapEpochs);
  const inBootstrap = currentEpoch < bootstrapEpochs;
  const bootstrapDone = bootstrapEpochs > 0 && currentEpoch >= bootstrapEpochs;

  const timelockAddr = deployment?.timelock?.toLowerCase();
  const rotated =
    !!timelockAddr &&
    !!treasuryOperator &&
    treasuryOperator.toLowerCase() === timelockAddr &&
    !!hookTrustees &&
    hookTrustees.toLowerCase() === timelockAddr &&
    !!genesisOperator &&
    genesisOperator.toLowerCase() === timelockAddr;

  // Steps. Status computed left-to-right; once a current step is found, the
  // rest are "future."
  const fundCutsSet = daoPct > 0n || devPct > 0n;

  // We treat fund cuts + tax enable as optional (user can choose to skip), so
  // they don't block "current" forward progression — they're side-quests.
  const steps: Step[] = [];

  function pick(
    titleNumeral: string,
    title: string,
    detail: string,
    isDone: boolean,
    isBlockedReason?: string,
  ): Step {
    if (isDone) return { numeral: titleNumeral, title, detail, status: "done" };
    if (isBlockedReason) return { numeral: titleNumeral, title, detail: isBlockedReason, status: "blocked" };
    return { numeral: titleNumeral, title, detail, status: "current" };
  }

  // 1 — Seed liquidity
  steps.push(pick("I", "Seed V4 liquidity", "Pool initialized at tick 0.", poolBound));

  // 2 — Open Genesis
  steps.push(
    pick(
      "II",
      "Open Genesis Pool",
      genesisStartTime > 0n
        ? `Window opens ${new Date(Number(genesisStartTime) * 1000).toLocaleString()}`
        : "Register WETH (and optionally USDC) via Panel I below.",
      genesisStartTime > 0n,
      poolBound ? undefined : "Waiting on Step I.",
    ),
  );

  // 3 — Genesis window
  steps.push({
    numeral: "III",
    title: "Genesis Window",
    detail: !genesisStartTime
      ? "Schedule set at deploy; opens when Step II completes."
      : genesisWindowClosed
        ? "Closed — Main + Share pools live."
        : genesisWindowOpen
          ? `Open · closes in ${formatCountdown(Number(genesisStartTime + 86_400n - nowSec))}`
          : `Opens in ${formatCountdown(Number(genesisStartTime - nowSec))}`,
    status: genesisWindowClosed ? "done" : genesisWindowOpen ? "current" : genesisStartTime > 0n ? "future" : "blocked",
  });

  // 4 — Bootstrap
  steps.push({
    numeral: "IV",
    title: "Bootstrap Phase",
    detail: bootstrapDone
      ? `Complete — ${bootstrapEpochs} epochs passed.`
      : inBootstrap
        ? `In progress · epoch ${currentEpoch} of ${bootstrapEpochs}. Keeper advances every 6h.`
        : "Pending Step III.",
    status: bootstrapDone ? "done" : inBootstrap ? "current" : "future",
  });

  // 5 — Post-bootstrap config (fund cuts)
  steps.push({
    numeral: "V",
    title: "Set Fund Cuts (optional)",
    detail: fundCutsSet
      ? `dao ${(Number(daoPct) / 100).toFixed(2)}% · dev ${(Number(devPct) / 100).toFixed(2)}%`
      : bootstrapDone
        ? "Default zero. Configure via Panel II below if desired."
        : "Pending bootstrap end.",
    status: fundCutsSet ? "done" : bootstrapDone ? "current" : "future",
  });

  // 6 — Enable hook tax (optional)
  steps.push({
    numeral: "VI",
    title: "Enable Hook Tax (optional)",
    detail: autoTaxOn
      ? "Active · 14-tier schedule taxing MONEY sells."
      : bootstrapDone
        ? "Disabled. Flip on via Panel II below to defend the peg."
        : "Pending bootstrap end.",
    status: autoTaxOn ? "done" : bootstrapDone ? "current" : "future",
  });

  // 7 — Governance rotation
  steps.push({
    numeral: "VII",
    title: "Rotate to Timelock",
    detail: rotated
      ? "Done — Timelock holds all admin roles."
      : !deployment?.timelock
        ? "Deploy Timelock first via script."
        : bootstrapDone
          ? "Run RotateGovernanceQueue.s.sol, wait 24h, then RotateGovernanceExecute.s.sol."
          : "Pending bootstrap end.",
    status: rotated ? "done" : bootstrapDone && !!deployment?.timelock ? "current" : "future",
  });

  return (
    <section className="px-6 pb-12 md:px-12">
      <div className="mx-auto max-w-3xl">
        <div className="deco-panel">
          <div className="label-deco mb-3 text-deco-gold-dark text-center">
            From Deploy to Fully Rotated
          </div>
          <h2
            className="mb-2 text-center font-display text-2xl italic text-deco-ivory md:text-3xl"
            style={{ letterSpacing: "0.06em" }}
          >
            The Launch Sequence
          </h2>
          <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
          <ol className="space-y-3">
            {steps.map((s) => (
              <StepRow key={s.numeral} step={s} />
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function StepRow({ step }: { step: Step }) {
  const toneBorder =
    step.status === "done"
      ? "border-deco-emerald/60"
      : step.status === "current"
        ? "border-deco-gold"
        : step.status === "blocked"
          ? "border-deco-ruby/40"
          : "border-deco-gold/20";

  const toneText =
    step.status === "done"
      ? "text-deco-emerald"
      : step.status === "current"
        ? "text-deco-gold"
        : step.status === "blocked"
          ? "text-deco-ruby"
          : "text-deco-gold-dark";

  const marker =
    step.status === "done"
      ? "✓"
      : step.status === "current"
        ? "◆"
        : step.status === "blocked"
          ? "—"
          : "○";

  return (
    <li className={`flex items-center gap-4 border-l-2 ${toneBorder} pl-5 py-2`}>
      <span
        className={`font-ornament text-xl ${toneText}`}
        style={{ letterSpacing: "0.2em", minWidth: "2.5em" }}
      >
        {step.numeral}
      </span>
      <span className={`text-2xl ${toneText}`}>{marker}</span>
      <div className="flex-1 text-left">
        <div className={`font-display text-lg ${step.status === "future" ? "text-deco-ivory-soft" : "text-deco-ivory"}`}>
          {step.title}
        </div>
        <div className="font-body text-sm italic text-deco-ivory-soft">{step.detail}</div>
      </div>
    </li>
  );
}
