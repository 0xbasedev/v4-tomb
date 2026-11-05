import { networks } from "@/lib/networks";
import { useState } from "react";
import { useReadContracts } from "wagmi";

import { genesisRewardPoolAbi, hookAbi, ownable2StepAbi, treasuryAbi } from "@/lib/abis";
import { useDeployment } from "@/lib/hooks";

/**
 * RotationStatusPanel — read-only ceremony state + copy-paste commands.
 *
 * The full governance rotation is two scripts:
 *   1. RotateGovernanceQueue.s.sol  — rotates operators, transfers ownership,
 *                                      queues acceptOwnership in Timelock
 *   2. RotateGovernanceExecute.s.sol — after 24h delay, executes the queued txs
 *
 * Each script broadcasts 4–13 transactions. Doing this as 17 wallet popups in
 * the UI would be brittle and error-prone for a one-time, irreversible action.
 * Instead this panel reads on-chain state, infers which phase we're in, and
 * surfaces the exact forge command to run next (with the right env vars baked).
 *
 * Observable phases:
 *   - **Not Started**: Treasury.operator() != Timelock — deployer holds everything.
 *   - **Awaiting Execute**: Treasury.operator() == Timelock but money.owner() !=
 *     Timelock — queue ran, acceptOwnership not yet executed. ETA is recoverable
 *     from the Timelock's `pendingOwner` of money and the original queue tx, but
 *     we don't track ETA on-chain. User must remember.
 *   - **Done**: money.owner() == Timelock.
 *
 *  ⚠ The actions in this panel are read-only. Do NOT trigger from UI.
 */

type RotationPhase = "not-started" | "awaiting-execute" | "done" | "unknown";

export function RotationStatusPanel() {
  const deployment = useDeployment();
  const [copied, setCopied] = useState<string | null>(null);

  const { data } = useReadContracts({
    allowFailure: true,
    contracts: deployment
      ? [
          { address: deployment.treasury, abi: treasuryAbi, functionName: "operator" },
          { address: deployment.hook, abi: hookAbi, functionName: "trustees" },
          { address: deployment.genesisRewardPool, abi: genesisRewardPoolAbi, functionName: "operator" },
          { address: deployment.money, abi: ownable2StepAbi, functionName: "owner" },
          { address: deployment.money, abi: ownable2StepAbi, functionName: "pendingOwner" },
          { address: deployment.estate, abi: ownable2StepAbi, functionName: "owner" },
          { address: deployment.trustNote, abi: ownable2StepAbi, functionName: "owner" },
          { address: deployment.hook, abi: ownable2StepAbi, functionName: "owner" },
        ]
      : [],
    query: { enabled: !!deployment, refetchInterval: 30_000 },
  });

  const treasuryOp = data?.[0]?.status === "success" ? (data[0].result as `0x${string}`) : undefined;
  const hookTrust = data?.[1]?.status === "success" ? (data[1].result as `0x${string}`) : undefined;
  const genesisOp = data?.[2]?.status === "success" ? (data[2].result as `0x${string}`) : undefined;
  const moneyOwner = data?.[3]?.status === "success" ? (data[3].result as `0x${string}`) : undefined;
  const moneyPending = data?.[4]?.status === "success" ? (data[4].result as `0x${string}`) : undefined;
  const estateOwner = data?.[5]?.status === "success" ? (data[5].result as `0x${string}`) : undefined;
  const trustnoteOwner = data?.[6]?.status === "success" ? (data[6].result as `0x${string}`) : undefined;
  const hookOwner = data?.[7]?.status === "success" ? (data[7].result as `0x${string}`) : undefined;

  function eq(a?: string, b?: string) {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
  }

  const tl = deployment?.timelock;
  const operatorsAtTimelock =
    eq(treasuryOp, tl) && eq(hookTrust, tl) && eq(genesisOp, tl);
  const ownersAtTimelock =
    eq(moneyOwner, tl) && eq(estateOwner, tl) && eq(trustnoteOwner, tl) && eq(hookOwner, tl);

  let phase: RotationPhase = "unknown";
  if (treasuryOp && tl) {
    if (ownersAtTimelock) phase = "done";
    else if (operatorsAtTimelock) phase = "awaiting-execute";
    else phase = "not-started";
  }

  const queueCommand = deployment
    ? buildQueueCommand(deployment)
    : "# Connect first";
  const executeCommand = deployment
    ? buildExecuteCommand(deployment)
    : "# Connect first";

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2_000);
    } catch {
      // clipboard may be denied in some browsers — fall through silently
    }
  }

  return (
    <section className="px-6 pb-12 md:px-12">
      <div className="mx-auto max-w-3xl">
        <div className="deco-panel">
          <div className="label-deco mb-3 text-deco-gold-dark">IV · Governance Rotation</div>
          <h2 className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl">
            Hand Off Admin to The Timelock
          </h2>
          <div className="mx-auto mb-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
          <p className="mb-6 mx-auto max-w-xl font-body text-sm italic text-deco-ivory-soft">
            The ceremony is two scripts with a {`>= 24h`} Timelock delay between
            them. This panel reads on-chain state to surface where you are and
            the exact command to run next. The actions are intentionally NOT
            wired to UI — irreversible, 17 wallet pops, and a fat-finger could
            split admin between deployer and Timelock with no recovery.
          </p>

          {/* Phase indicator */}
          <PhasePill phase={phase} />

          {/* State table */}
          <div className="my-6 grid grid-cols-1 gap-2 text-left text-xs font-body italic">
            <Row label="Treasury operator" value={treasuryOp} timelock={tl} />
            <Row label="Hook trustees" value={hookTrust} timelock={tl} />
            <Row label="Genesis operator" value={genesisOp} timelock={tl} />
            <Row label="$MONEY owner" value={moneyOwner} timelock={tl} pending={moneyPending} />
            <Row label="$ESTATE owner" value={estateOwner} timelock={tl} />
            <Row label="$TRUSTNOTE owner" value={trustnoteOwner} timelock={tl} />
            <Row label="Hook owner" value={hookOwner} timelock={tl} />
          </div>

          {/* Action box — shows the command appropriate for the current phase */}
          {phase === "not-started" && (
            <CommandBlock
              title="Run the Queue script"
              hint="After this completes, wait 24h (the Timelock delay), then come back to run Execute."
              command={queueCommand}
              copied={copied === "queue"}
              onCopy={() => copy("queue", queueCommand)}
            />
          )}

          {phase === "awaiting-execute" && (
            <CommandBlock
              title="Run the Execute script"
              hint="ETA must match the value used in the queue script. Defaults to (queue time + Timelock.delay() + 60s). If you didn't override at queue time, use that default."
              command={executeCommand}
              copied={copied === "execute"}
              onCopy={() => copy("execute", executeCommand)}
            />
          )}

          {phase === "done" && (
            <div className="border border-deco-emerald/50 bg-deco-emerald/5 p-4 text-center">
              <div className="label-deco mb-1 text-deco-emerald">Complete</div>
              <p className="font-body text-sm italic text-deco-ivory">
                The Timelock holds all admin roles. The deployer EOA has no
                privileged access on Treasury, Hook, reward pools, or token
                ownership. Every admin action now goes through the
                queue/wait/execute pattern.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function PhasePill({ phase }: { phase: RotationPhase }) {
  const copy = {
    "not-started": { label: "Phase · Not Started", tone: "border-deco-gold/50 text-deco-gold" },
    "awaiting-execute": { label: "Phase · Awaiting Execute", tone: "border-deco-ruby/60 text-deco-ruby" },
    done: { label: "Phase · Complete", tone: "border-deco-emerald/60 text-deco-emerald" },
    unknown: { label: "Phase · Reading state…", tone: "border-deco-gold/30 text-deco-gold-dark" },
  }[phase];
  return (
    <div className="flex justify-center">
      <div className={`label-deco border px-3 py-1 ${copy.tone}`}>{copy.label}</div>
    </div>
  );
}

function Row({
  label,
  value,
  timelock,
  pending,
}: {
  label: string;
  value?: `0x${string}`;
  timelock?: `0x${string}`;
  pending?: `0x${string}`;
}) {
  const isAtTl = !!value && !!timelock && value.toLowerCase() === timelock.toLowerCase();
  const hasPending = !!pending && pending !== "0x0000000000000000000000000000000000000000";
  return (
    <div className="flex items-baseline justify-between gap-3 border-l border-deco-gold/20 pl-3">
      <span className="text-deco-gold-dark">{label}</span>
      <span className={isAtTl ? "text-deco-emerald" : "text-deco-ivory"}>
        {value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—"}
        {isAtTl && " ✓"}
        {hasPending && (
          <span className="ml-2 text-deco-gold">
            → pending {pending!.slice(0, 6)}…{pending!.slice(-4)}
          </span>
        )}
      </span>
    </div>
  );
}

function CommandBlock({
  title,
  hint,
  command,
  copied,
  onCopy,
}: {
  title: string;
  hint: string;
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="border border-deco-gold/40 bg-deco-ground-soft p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="label-deco text-deco-gold">{title}</div>
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy ${title} command`}
          className="label-deco text-deco-gold transition-colors hover:text-deco-gold-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-deco-gold"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p className="mb-3 font-body text-xs italic text-deco-ivory-soft">{hint}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all bg-deco-ground p-3 font-ornament text-xs text-deco-ivory">
        {command}
      </pre>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Command builders                                                   */
/* ----------------------------------------------------------------- */

function buildQueueCommand(d: NonNullable<ReturnType<typeof useDeployment>>): string {
  return [
    "cd contracts",
    "set -a && source .env && set +a",
    `export PROTOCOL_NETWORK_INDEX=${networks.findIndex((n) => n.deployment?.treasury === d.treasury)}`,
    "# RPC_URL must point to this network; the script checks its chain ID.",
    "forge script script/RotateGovernanceQueue.s.sol \\",
    '  --rpc-url "$RPC_URL" --broadcast --slow',
  ].join("\n");
}

function buildExecuteCommand(d: NonNullable<ReturnType<typeof useDeployment>>): string {
  return [
    "cd contracts",
    "set -a && source .env && set +a",
    `export PROTOCOL_NETWORK_INDEX=${networks.findIndex((n) => n.deployment?.treasury === d.treasury)}`,
    "# RPC_URL must point to this network; the script checks its chain ID.",
    "# ETA must match what you used in queue (or its default).",
    "# If you didn't override, the default was: queue_block.timestamp + timelock.delay() + 60.",
    "export ETA=<unix-timestamp-from-queue-log>",
    "forge script script/RotateGovernanceExecute.s.sol \\",
    '  --rpc-url "$RPC_URL" --broadcast --slow',
  ].join("\n");
}
