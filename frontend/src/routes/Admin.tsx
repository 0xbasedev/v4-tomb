import { useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress } from "viem";

import { LaunchSequence } from "@/components/LaunchSequence";
import { RotationStatusPanel } from "@/components/RotationStatusPanel";
import { RuleTrio } from "@/components/RuleTrio";
import { StatTile } from "@/components/StatTile";
import { useToast } from "@/components/ToastProvider";
import {
  useDeployment,
  useEpoch,
  useIsAdmin,
  useMoneyMarket,
} from "@/lib/hooks";
import {
  genesisRewardPoolAbi,
  hookAbi,
  treasuryAbi,
} from "@/lib/abis";
import { maskDecimalInput } from "@/lib/util/decimal";

/**
 * Admin — operator console for the protocol's privileged surfaces.
 *
 * Access:
 *   The route is reachable to anyone, but the action panels render only when
 *   the connected wallet matches Treasury.operator() OR PegDefenseHook.trustees()
 *   OR GenesisRewardPool.operator(). The contracts enforce the same checks
 *   server-side — this is a convenience gate, not a security boundary.
 *
 * Panels:
 *   I.   Status Board       — at-a-glance: epoch, oracle init, tax on/off, fund cuts
 *   II.  Open Genesis Pool  — register a stake token (operator-only)
 *   III. Post-Bootstrap     — set dao/dev fund cuts + enable hook tax
 *   IV.  Manual Tick        — call treasury.allocateSeigniorage() right now
 *
 * Each panel is independent and renders inline status / errors.
 */

export function Admin() {
  const deployment = useDeployment();
  const admin = useIsAdmin();
  const epoch = useEpoch();
  const market = useMoneyMarket();
  const toast = useToast();

  // One write hook reused across panels — only one action runs at a time on
  // this page, so a shared pipeline is fine.
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });

  function broadcast(label: string, call: Parameters<typeof write.writeContract>[0]) {
    const tid = toast.push({ variant: "pending", title: label, message: "Awaiting your signature." });
    write.writeContract(call, {
      onSuccess: (hash) => {
        toast.update(tid, {
          variant: "pending",
          title: `${label} · Confirming`,
          message: "Broadcast — waiting for inclusion.",
          txHash: hash,
        });
        // Defer success/error to the receipt watcher below
        watchReceipt(tid, label, hash);
      },
      onError: (err) => {
        toast.update(tid, {
          variant: "error",
          title: `${label} · Reverted`,
          message: err.message.split("\n")[0].slice(0, 120),
        });
      },
    });
  }

  function watchReceipt(tid: string, label: string, hash: `0x${string}`) {
    // Poll the receipt status synchronously via the existing useWaitForTransactionReceipt.
    // We can't subscribe per-tx here without restructuring, so we rely on the receipt
    // hook (above) which tracks write.data. The hook below escalates the toast on
    // success/error. Hash is included in pending toast so user has the BaseScan link.
    void hash;
    void tid;
    void label;
  }

  // Promote pending toast to success/error as the receipt resolves.
  if (receipt.isSuccess && write.data) {
    // Idempotent — only fires once because write.data identity is stable post-broadcast.
    // The Toast system de-dups by id; we re-push with a stable id derived from the txHash.
    toast.push({
      id: `r-${write.data}`,
      variant: "success",
      title: "Confirmed",
      txHash: write.data,
    });
  }
  if (receipt.isError && write.data) {
    toast.push({
      id: `e-${write.data}`,
      variant: "error",
      title: "Reverted",
      message: (write.error as Error | null)?.message?.split("\n")[0]?.slice(0, 120) ?? "Reverted",
      txHash: write.data,
    });
  }

  return (
    <div className="bg-deco-ground">
      {/* ===== Heading ===== */}
      <section className="relative px-6 pt-16 pb-12 md:px-12 md:pt-20 md:pb-16">
        <div className="mx-auto max-w-4xl text-center">
          <div className="label-deco mb-3 text-deco-gold-dark">
            The Operator's Console · Restricted
          </div>
          <h1 className="gold-text font-display italic text-section">The Admin</h1>
          <RuleTrio className="mb-2 mt-8" />
        </div>
      </section>

      {!deployment ? (
        <NotConnected />
      ) : admin.isLoading ? (
        <Loading />
      ) : !admin.isAdmin ? (
        <Restricted
          you={admin.treasuryOperator ? "" : "—"}
          treasury={admin.treasuryOperator ?? "—"}
          hookTrustees={admin.hookTrustees ?? "—"}
          genesisOperator={admin.genesisOperator ?? "—"}
        />
      ) : (
        <>
          <LaunchSequence />
          <StatusBoard
            epoch={epoch.epoch !== undefined ? Number(epoch.epoch) : 0}
            inBootstrap={market.phase === "bootstrap"}
            bootstrapEpochs={Number(market.bootstrapEpochs)}
            isTreasuryOperator={admin.isTreasuryOperator}
            isHookTrustees={admin.isHookTrustees}
            isGenesisOperator={admin.isGenesisOperator}
          />

          <OpenGenesisPanel
            disabled={!admin.isGenesisOperator || write.isPending || receipt.isLoading}
            onSubmit={(token, allocPoint) =>
              broadcast("Register Genesis Stake Token", {
                address: deployment.genesisRewardPool,
                abi: genesisRewardPoolAbi,
                functionName: "add",
                args: [allocPoint, token, false, 0n],
              })
            }
          />

          <PostBootstrapPanel
            currentEpoch={Number(epoch.epoch ?? 0n)}
            bootstrapEpochs={Number(market.bootstrapEpochs)}
            disabled={!admin.isTreasuryOperator || write.isPending || receipt.isLoading}
            onSetExtraFunds={(daoFund, daoPct, devFund, devPct) =>
              broadcast("Set Extra Funds", {
                address: deployment.treasury,
                abi: treasuryAbi,
                functionName: "setExtraFunds",
                args: [daoFund, daoPct, devFund, devPct],
              })
            }
            disabledTax={!admin.isHookTrustees || write.isPending || receipt.isLoading}
            onToggleTax={(enabled) =>
              broadcast(enabled ? "Enable Hook Tax" : "Disable Hook Tax", {
                address: deployment.hook,
                abi: hookAbi,
                functionName: "setAutoCalculateTax",
                args: [enabled],
              })
            }
          />

          <ManualTickPanel
            currentEpoch={Number(epoch.epoch ?? 0n)}
            nextEpochPoint={Number(epoch.nextEpochPoint ?? 0n)}
            disabled={write.isPending || receipt.isLoading}
            onTick={() =>
              broadcast("Manual Tick · allocateSeigniorage", {
                address: deployment.treasury,
                abi: treasuryAbi,
                functionName: "allocateSeigniorage",
                args: [],
              })
            }
          />

          <RotationStatusPanel />
        </>
      )}
    </div>
  );
}

/* ============================================================== */
/* States                                                         */
/* ============================================================== */

function NotConnected() {
  return (
    <section className="px-6 pb-20 md:px-12">
      <div className="deco-panel mx-auto max-w-2xl text-center">
        <div className="label-deco mb-3 text-deco-gold-dark">The Trust Awaits</div>
        <h2 className="mb-4 font-display text-3xl italic text-deco-ivory md:text-4xl">
          Connect a wallet on Base Sepolia
        </h2>
        <p className="font-body text-base italic text-deco-ivory-soft">
          The Admin console reads the operator slots on Treasury, PegDefenseHook, and
          GenesisRewardPool. Without a connected wallet, no slot can be checked.
        </p>
      </div>
    </section>
  );
}

function Loading() {
  return (
    <section className="px-6 pb-20 md:px-12">
      <div className="deco-panel mx-auto max-w-2xl text-center">
        <p className="font-body text-base italic text-deco-gold-dark">
          Reading the operator slots…
        </p>
      </div>
    </section>
  );
}

function Restricted({
  you,
  treasury,
  hookTrustees,
  genesisOperator,
}: {
  you: string;
  treasury: string;
  hookTrustees: string;
  genesisOperator: string;
}) {
  void you;
  return (
    <section className="px-6 pb-20 md:px-12">
      <div className="deco-panel mx-auto max-w-2xl text-center">
        <div className="label-deco mb-3 text-deco-ruby">Access Denied</div>
        <h2 className="mb-4 font-display text-3xl italic text-deco-ivory md:text-4xl">
          The Trust does not recognize you
        </h2>
        <div className="mx-auto mb-6 h-[2px] w-12 bg-deco-gold" aria-hidden />
        <p className="mb-6 font-body text-base italic text-deco-ivory-soft">
          Your wallet holds no admin role on the protocol contracts. This page is
          gated to the operator slots on Treasury, PegDefenseHook, and
          GenesisRewardPool. The contracts themselves enforce the same checks —
          any unauthorized action would revert on-chain.
        </p>
        <div className="space-y-2 text-left font-body text-xs italic text-deco-gold-dark">
          <div>
            Treasury operator:{" "}
            <code className="font-ornament text-deco-gold">{treasury}</code>
          </div>
          <div>
            Hook trustees:{" "}
            <code className="font-ornament text-deco-gold">{hookTrustees}</code>
          </div>
          <div>
            Genesis operator:{" "}
            <code className="font-ornament text-deco-gold">{genesisOperator}</code>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================== */
/* Panels                                                         */
/* ============================================================== */

function StatusBoard({
  epoch,
  inBootstrap,
  bootstrapEpochs,
  isTreasuryOperator,
  isHookTrustees,
  isGenesisOperator,
}: {
  epoch: number;
  inBootstrap: boolean;
  bootstrapEpochs: number;
  isTreasuryOperator: boolean;
  isHookTrustees: boolean;
  isGenesisOperator: boolean;
}) {
  return (
    <section className="px-6 pb-12 md:px-12">
      <div className="mx-auto max-w-7xl">
        <div className="label-deco mb-6 text-center text-deco-gold-dark">Your Roles</div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
          <StatTile
            label="Treasury Operator"
            value={isTreasuryOperator ? "Yes" : "No"}
            hint="setExtraFunds, setBootstrap, allocateSeigniorage"
          />
          <StatTile
            label="Hook Trustees"
            value={isHookTrustees ? "Yes" : "No"}
            hint="setAutoCalculateTax, setTreasury, tax tier edits"
          />
          <StatTile
            label="Genesis Operator"
            value={isGenesisOperator ? "Yes" : "No"}
            hint="add() to register stake tokens"
          />
          <StatTile
            label="Phase"
            value={inBootstrap ? `Bootstrap ${epoch}/${bootstrapEpochs}` : `Epoch ${epoch}`}
            hint={inBootstrap ? "Unconditional expansion" : "Oracle-driven"}
          />
        </div>
      </div>
    </section>
  );
}

function OpenGenesisPanel({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (token: `0x${string}`, allocPoint: bigint) => void;
}) {
  const [tokenInput, setTokenInput] = useState("");
  const [allocPoint, setAllocPoint] = useState("100");

  const tokenValid = isAddress(tokenInput.trim());
  const allocValid = /^\d+$/.test(allocPoint) && parseInt(allocPoint, 10) > 0;
  const canSubmit = tokenValid && allocValid && !disabled;

  return (
    <section className="px-6 pb-12 md:px-12">
      <div className="mx-auto max-w-3xl">
        <div className="deco-panel">
          <div className="label-deco mb-3 text-deco-gold-dark">I · Open Genesis</div>
          <h2 className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl">
            Register a Genesis Stake Token
          </h2>
          <div className="mx-auto mb-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
          <p className="mb-6 mx-auto max-w-xl font-body text-sm italic text-deco-ivory-soft">
            Calls <code className="font-ornament text-deco-gold">genesisRewardPool.add(allocPoint, token, false, 0)</code>.
            Run BEFORE poolStartTime — unregistered emission is lost. Repeat per token (WETH, USDC, etc.).
          </p>

          <div className="mb-2 px-1 text-left">
            <span className="label-deco text-deco-gold-dark">Stake Token Address</span>
          </div>
          <div className="mb-4 flex items-center border border-deco-gold/50 bg-deco-ground focus-within:border-deco-gold">
            <input
              type="text"
              placeholder="0x4200…"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              disabled={disabled}
              aria-label="Stake token address"
              className="font-display w-full bg-transparent px-4 py-3 text-left text-base text-deco-ivory placeholder:text-deco-gold-dark/40 focus:outline-none disabled:opacity-50"
            />
          </div>

          <div className="mb-2 px-1 text-left">
            <span className="label-deco text-deco-gold-dark">Alloc Point</span>
          </div>
          <div className="mb-6 flex items-center border border-deco-gold/50 bg-deco-ground focus-within:border-deco-gold">
            <input
              type="text"
              inputMode="numeric"
              value={allocPoint}
              onChange={(e) => setAllocPoint(e.target.value.replace(/[^\d]/g, ""))}
              disabled={disabled}
              aria-label="Alloc point weight"
              className="font-display w-full bg-transparent px-4 py-3 text-right text-2xl text-deco-ivory focus:outline-none disabled:opacity-50"
            />
          </div>

          <button
            type="button"
            onClick={() => onSubmit(tokenInput.trim() as `0x${string}`, BigInt(allocPoint))}
            disabled={!canSubmit}
            className="btn-deco btn-deco-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-40"
          >
            Register
          </button>
        </div>
      </div>
    </section>
  );
}

function PostBootstrapPanel({
  currentEpoch,
  bootstrapEpochs,
  disabled,
  onSetExtraFunds,
  disabledTax,
  onToggleTax,
}: {
  currentEpoch: number;
  bootstrapEpochs: number;
  disabled: boolean;
  onSetExtraFunds: (daoFund: `0x${string}`, daoPct: bigint, devFund: `0x${string}`, devPct: bigint) => void;
  disabledTax: boolean;
  onToggleTax: (enabled: boolean) => void;
}) {
  const [daoFund, setDaoFund] = useState("");
  const [daoPct, setDaoPct] = useState("");
  const [devFund, setDevFund] = useState("");
  const [devPct, setDevPct] = useState("");

  const inBootstrap = currentEpoch < bootstrapEpochs;
  const fundsValid =
    isAddress(daoFund) &&
    isAddress(devFund) &&
    /^\d+(\.\d+)?$/.test(daoPct) &&
    /^\d+(\.\d+)?$/.test(devPct);

  return (
    <section className="px-6 pb-12 md:px-12">
      <div className="mx-auto max-w-3xl">
        <div className="deco-panel">
          <div className="label-deco mb-3 text-deco-gold-dark">II · Post-Bootstrap</div>
          <h2 className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl">
            Configure Fund Cuts &amp; Hook Tax
          </h2>
          <div className="mx-auto mb-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
          {inBootstrap && (
            <p className="mb-4 mx-auto max-w-xl font-body text-sm italic text-deco-ruby">
              Still in bootstrap (epoch {currentEpoch} of {bootstrapEpochs}). These
              setters work pre-bootstrap-end but won't take effect until expansion
              begins.
            </p>
          )}

          {/* --- Extra Funds --- */}
          <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <div className="label-deco mb-1 text-left text-deco-gold-dark">Dao Fund Address</div>
              <input
                type="text"
                placeholder="0x…"
                value={daoFund}
                onChange={(e) => setDaoFund(e.target.value)}
                disabled={disabled}
                className="font-display w-full border border-deco-gold/50 bg-deco-ground px-3 py-2 text-left text-base text-deco-ivory focus:border-deco-gold focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <div className="label-deco mb-1 text-left text-deco-gold-dark">Dao % (0–30)</div>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={daoPct}
                onChange={(e) => setDaoPct(maskDecimalInput(e.target.value))}
                disabled={disabled}
                className="font-display w-full border border-deco-gold/50 bg-deco-ground px-3 py-2 text-right text-base text-deco-ivory focus:border-deco-gold focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <div className="label-deco mb-1 text-left text-deco-gold-dark">Dev Fund Address</div>
              <input
                type="text"
                placeholder="0x…"
                value={devFund}
                onChange={(e) => setDevFund(e.target.value)}
                disabled={disabled}
                className="font-display w-full border border-deco-gold/50 bg-deco-ground px-3 py-2 text-left text-base text-deco-ivory focus:border-deco-gold focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <div className="label-deco mb-1 text-left text-deco-gold-dark">Dev % (0–10)</div>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={devPct}
                onChange={(e) => setDevPct(maskDecimalInput(e.target.value))}
                disabled={disabled}
                className="font-display w-full border border-deco-gold/50 bg-deco-ground px-3 py-2 text-right text-base text-deco-ivory focus:border-deco-gold focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!fundsValid) return;
              onSetExtraFunds(
                daoFund as `0x${string}`,
                BigInt(Math.round(parseFloat(daoPct) * 100)),
                devFund as `0x${string}`,
                BigInt(Math.round(parseFloat(devPct) * 100)),
              );
            }}
            disabled={!fundsValid || disabled}
            className="btn-deco w-full justify-center disabled:cursor-not-allowed disabled:opacity-40"
          >
            Set Extra Funds
          </button>

          {/* --- Tax Toggle --- */}
          <div className="mt-6 border-t border-deco-gold/20 pt-6">
            <div className="mb-2 text-left">
              <span className="label-deco text-deco-gold-dark">Hook Tax</span>
            </div>
            <p className="mb-4 font-body text-sm italic text-deco-ivory-soft">
              Enable the 14-tier sell tax. Off by default at deploy; flip on
              post-bootstrap. Burns below 1.10 ETH, routes to Treasury above.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => onToggleTax(true)}
                disabled={disabledTax}
                className="btn-deco flex-1 justify-center disabled:cursor-not-allowed disabled:opacity-40"
              >
                Enable Tax
              </button>
              <button
                type="button"
                onClick={() => onToggleTax(false)}
                disabled={disabledTax}
                className="btn-deco flex-1 justify-center disabled:cursor-not-allowed disabled:opacity-40"
              >
                Disable Tax
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ManualTickPanel({
  currentEpoch,
  nextEpochPoint,
  disabled,
  onTick,
}: {
  currentEpoch: number;
  nextEpochPoint: number;
  disabled: boolean;
  onTick: () => void;
}) {
  const now = Math.floor(Date.now() / 1000);
  const ready = now >= nextEpochPoint && nextEpochPoint > 0;
  const wait = nextEpochPoint - now;

  return (
    <section className="px-6 pb-20 md:px-12 md:pb-28">
      <div className="mx-auto max-w-3xl">
        <div className="deco-panel">
          <div className="label-deco mb-3 text-deco-gold-dark">III · Manual Tick</div>
          <h2 className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl">
            Force An Epoch Advance
          </h2>
          <div className="mx-auto mb-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
          <p className="mb-6 mx-auto max-w-xl font-body text-sm italic text-deco-ivory-soft">
            Calls <code className="font-ornament text-deco-gold">treasury.allocateSeigniorage()</code> right now. Permissionless
            post-nextEpochPoint. The GitHub Actions keeper handles this every 30
            min on schedule; use this for one-off pushes or debugging.
          </p>
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatTile label="Current Epoch" value={currentEpoch.toString()} hint="Treasury Counter" />
            <StatTile
              label="Ready?"
              value={ready ? "Yes" : `In ${Math.max(0, wait)}s`}
              hint={ready ? "now >= nextEpochPoint" : "Will revert if pushed early"}
            />
          </div>
          <button
            type="button"
            onClick={onTick}
            disabled={!ready || disabled}
            className="btn-deco btn-deco-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-40"
          >
            Tick
          </button>
        </div>
      </div>
    </section>
  );
}
