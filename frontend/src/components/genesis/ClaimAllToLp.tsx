import { fmtDuration } from "@/lib/genesis";
import { useActions, useCompoundPlan, useProtocol } from "@/lib/hooks";
import { GENESIS_POLICY } from "@/lib/launch";

/**
 * Claim All to LP — one button for every pass tier, Genesis NFT included
 * (Jess, 2026-11-09). Claims the pending rewards from all Genesis pools and
 * zaps them into the LP pool (compoundToLP per pool).
 *
 * The 3-hour rule is the pools' own, never the button's: claims and compounds
 * share one 3h clock per pool, and this button can only include a pool whose
 * clock is already ready. A pool still cooling down is skipped and left
 * exactly as it was — its timer is neither reset nor overridden, so the
 * batch can never become a way to claim more often than the per-pool clock
 * allows (Jess, 2026-11-09 anti-bypass rule).
 */
export function ClaimAllToLp() {
  const p = useProtocol();
  const actions = useActions();

  const pools = ([0, 1] as const).map((pool) => {
    const pos = p.staking.positions[pool];
    const pending = pos?.pending ?? 0;
    const readyIn = Math.max(0, (p.staking.nextCompoundAt[pool] ?? 0) - p.now);
    return { pool, pending, readyIn };
  });

  const tax0 = p.taxFor("xTOMB", (pools[0].pending * GENESIS_POLICY.liquidShare * (p.prices.xTOMB ?? 1)) / 2);
  const tax1 = p.taxFor("xTOMB", (pools[1].pending * GENESIS_POLICY.liquidShare * (p.prices.xTOMB ?? 1)) / 2);
  const live0 = useCompoundPlan(0, tax0.rateBps, p.poolFeeBps.xTOMB);
  const live1 = useCompoundPlan(1, tax1.rateBps, p.poolFeeBps.xTOMB);
  const plans = [live0.plan, live1.plan];

  const ready = pools.filter((x) => x.pending > 0 && x.readyIn <= 0);
  const cooling = pools.filter((x) => x.pending > 0 && x.readyIn > 0);
  // In live mode a ready pool also needs its compound plan; without one it
  // waits (same reason the per-pool compound gives), it is never forced.
  const actionable = ready.filter((x) => p.sim || plans[x.pool]);
  const waitingOnPlan = ready.filter((x) => !p.sim && !plans[x.pool]);

  const totalPending = pools.reduce((s, x) => s + x.pending, 0);
  const nextReadyIn = cooling.length ? Math.min(...cooling.map((x) => x.readyIn)) : 0;

  const block = !p.account
    ? "Connect a wallet."
    : totalPending <= 0
      ? "Nothing accrued yet."
      : actionable.length === 0 && waitingOnPlan.length > 0
        ? "Waiting for the vault range and validated spot to plan the compound."
        : actionable.length === 0
          ? `Still cooling down — ready in ${fmtDuration(nextReadyIn)}.`
          : null;

  const claimAll = () => {
    const queue = [...actionable];
    const step = (): void => {
      const next = queue.shift();
      if (!next) return;
      actions.compound(next.pool, plans[next.pool], queue.length ? step : undefined);
    };
    step();
  };

  return (
    <div className="panel mt-4 p-5">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className="btn btn-primary h-11 px-6 text-[14px]"
          disabled={!!block || actions.busy}
          onClick={claimAll}
        >
          Claim All to LP
        </button>
        <p className="min-w-[220px] flex-1 text-[13px] leading-relaxed text-bone-dim">
          This will claim all of your pending Rewards from all pools and zap them into the LP for a
          higher APR.
        </p>
      </div>
      {(block || cooling.length > 0) && (
        <p className="mt-3 text-[12px] leading-relaxed text-ash">
          {block ??
            cooling
              .map(
                (x) =>
                  `${x.pool === 0 ? "Standard pool" : "LP pool"} is still on its 3-hour clock — ready in ${fmtDuration(x.readyIn)}, not included this time.`,
              )
              .join(" ")}
        </p>
      )}
    </div>
  );
}
