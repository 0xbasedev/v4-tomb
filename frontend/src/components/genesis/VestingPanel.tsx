import { Reason, SimBadge } from "@/components/Status";
import { fmtDuration, trancheView } from "@/lib/genesis";
import { useActions, useProtocol } from "@/lib/hooks";
import { GENESIS_POLICY, pct } from "@/lib/launch";

/**
 * Vested Genesis rewards — MasonryGenesisSettlement tranches. Each tranche
 * releases in 16 claim-gated installments: the first opens at Genesis end +
 * 6h, and each next one opens 6h after the previous is claimed (not on a
 * fixed calendar). Every release pays the 2% wallet fee to the DAO wallet.
 */
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export function VestingPanel() {
  const p = useProtocol();
  const actions = useActions();
  const list = p.tranches.map((t, i) => ({ t, i, v: trancheView(t, p.now) }));
  const total = list.reduce((a, x) => a + x.v.remaining, 0);
  const notYet = p.clock && p.clock.phase !== "ended";

  return (
    <section id="vesting" data-reveal className="panel scroll-mt-24 p-5 md:p-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="label">Vested rewards</span>
        {p.sim && <SimBadge />}
      </div>
      <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
        <h2 className="font-display text-xl font-semibold text-bone">{list.length ? `${fmt(total)} xTOMB vesting` : "Nothing vesting yet"}</h2>
        <p className="text-[12px] text-ash">
          {GENESIS_POLICY.installments} installments · {GENESIS_POLICY.installmentSeconds / 3600}h after each claim · {pct(GENESIS_POLICY.walletFeeBps)} per release
        </p>
      </div>
      {notYet && <p className="mt-1 text-[13px] text-bone-dim">Each claim or compound adds a tranche (half the reward). The first installment of every tranche opens 6 hours after Genesis ends.</p>}
      {list.length === 0 && <Reason>{p.account ? "Claim or compound to create a tranche." : "Connect a wallet to see your tranches."}</Reason>}
      <ul className="mt-4 space-y-3">
        {list.map(({ t, i, v }) => (
          <li key={i} className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] text-bone">
                Tranche #{i + 1} · <span className="num">{fmt(t.amount)}</span> xTOMB
              </span>
              <span className="font-mono text-[11px] text-ash">
                {t.releasedInstallments}/{GENESIS_POLICY.installments} released
              </span>
            </div>
            <div className="mt-2 grid grid-cols-16 gap-[3px]" style={{ gridTemplateColumns: `repeat(${GENESIS_POLICY.installments}, minmax(0,1fr))` }}>
              {Array.from({ length: GENESIS_POLICY.installments }, (_, k) => (
                <span
                  key={k}
                  className={`h-2 rounded-sm ${k < t.releasedInstallments ? "bg-ok" : k === t.releasedInstallments && v.ready ? "animate-breathe bg-ember" : "bg-white/[0.07]"}`}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12px] text-ash">
                {v.done ? "Fully released" : v.ready ? `Next: ${fmt(v.per)} xTOMB · ${fmt(v.nextNet)} to you after the fee` : `Next opens in ${fmtDuration(v.waitSeconds)}`}
              </span>
              <button type="button" className="btn btn-primary h-9 px-4 text-[12.5px]" disabled={!v.ready || actions.busy} onClick={() => actions.release(i)}>
                Release installment
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
