import { useState } from "react";
import { isAddress, type Address } from "viem";

import { Reason, SimBadge } from "@/components/Status";
import { useActions, useProtocol } from "@/lib/hooks";
import { fmtDuration } from "@/lib/genesis";
import { GENESIS_POLICY, PASSES, pct } from "@/lib/launch";
import { PREVIEW_KEEPER } from "@/lib/preview";
import { maskDecimalInput } from "@/lib/util/decimal";

/**
 * Keeper compounding — MasonryGenesisStaking.setKeeper(executor, minNetShares).
 * Pro and Ultra only. The keeper you choose can compound your rewards into
 * the LP pool no more often than its tier allows (Pro 6h, Ultra 3h); each automated run
 * pays 2% of the liquid half to Treasury and must mint at least your minimum
 * net shares, or it reverts.
 */
export function KeeperPanel() {
  const p = useProtocol();
  const actions = useActions();
  const eligible = p.pass === "pro" || p.pass === "ultra";
  const [executor, setExecutor] = useState<string>(p.sim ? PREVIEW_KEEPER : "");
  const [min, setMin] = useState("0.5");
  const on = !!p.staking.keeper.executor;
  const valid = isAddress(executor) && parseFloat(min) > 0;
  const hours = (s: number) => s / 3600;
  const every = GENESIS_POLICY.keeperIntervalSeconds;
  const mine = p.pass === "ultra" ? every.ultra : every.pro;
  // The keeper compounds from whichever pool has rewards; show the sooner of the two clocks.
  const nextRuns = ([0, 1] as const).map((i) => p.staking.nextKeeperCompoundAt[i]).filter((t): t is number => t !== null);
  const wait = nextRuns.length ? Math.max(0, Math.min(...nextRuns) - p.now) : 0;
  const reason = !p.account ? "Connect a wallet." : !p.pass ? "Buy a pass first." : !eligible ? `Keeper compounding needs a ${PASSES.pro.name} or ${PASSES.ultra.name} pass.` : null;

  return (
    <section data-reveal className="panel p-5 md:p-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="label">Keeper compounding</span>
        <span className="chip h-6">Pro · Ultra</span>
        {on && <span className="chip chip-ok h-6">On</span>}
        {p.sim && <SimBadge />}
      </div>
      <p className="max-w-2xl text-[13.5px] leading-relaxed text-bone-dim">
        Opt in and a keeper you choose compounds your rewards into the LP pool for you: at most every {hours(every.pro)} hours with a {PASSES.pro.name} pass,
        every {hours(every.ultra)} hours with {PASSES.ultra.name}. Compounding by hand stays on the {hours(GENESIS_POLICY.compoundCooldownSeconds)}-hour clock for every pass. Each automated run
        pays {pct(GENESIS_POLICY.automationFeeBps)} of the liquid half to Treasury; a manual compound pays none. The run reverts if it would mint fewer than
        your minimum net shares.
      </p>
      {on ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-[13px]">
          <span className="font-mono text-bone-dim">
            keeper {p.staking.keeper.executor!.slice(0, 8)}… · min {p.staking.keeper.minNetShares} LP
          </span>
          {eligible && (
            <span className="chip h-6" data-testid="keeper-cadence">
              every {hours(mine)}h · {wait > 0 ? `next run in ${fmtDuration(wait)}` : "can run now"}
            </span>
          )}
          <button type="button" className="btn h-9 px-4 text-[12.5px]" disabled={actions.busy} onClick={() => actions.setKeeper(null, 0)}>
            Opt out
          </button>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px_auto] sm:items-end">
          <label className="block">
            <span className="label mb-1 block">Keeper address</span>
            <input value={executor} onChange={(e) => setExecutor(e.target.value.trim())} placeholder="0x…" aria-label="Keeper address" className="well w-full px-3 py-2 font-mono text-[12.5px] text-bone" />
          </label>
          <label className="block">
            <span className="label mb-1 block">Min net LP / run</span>
            <input value={min} inputMode="decimal" onChange={(e) => setMin(maskDecimalInput(e.target.value))} aria-label="Minimum net shares per run" className="well w-full px-3 py-2 font-mono text-[12.5px] text-bone" />
          </label>
          <button type="button" className="btn btn-primary h-10 px-4 text-[13px]" disabled={!!reason || !valid || actions.busy} onClick={() => actions.setKeeper(executor as Address, parseFloat(min))}>
            Opt in
          </button>
        </div>
      )}
      {reason && <Reason>{reason}</Reason>}
      {!reason && !on && !valid && <Reason tone="warn">Enter the keeper's address and a minimum above zero.</Reason>}
    </section>
  );
}
