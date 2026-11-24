import { useState } from "react";
import { Link } from "react-router-dom";

import { AmountField, parseAmount } from "@/components/AmountField";
import { Reason } from "@/components/Status";
import { TokenIcon, type TokenSymbol } from "@/components/TokenIcon";
import { HoldButton } from "@/components/fx/HoldButton";
import { formatToken } from "@/lib/format";
import { useActions, useProtocol, type FarmPool, type FarmState } from "@/lib/hooks";

const ROLE_ICON: Record<FarmPool["role"], TokenSymbol> = { pegLp: "PEG-LP", shareLp: "SHARE-LP", pairLp: "PAIR-LP", other: "QUOTE" };

/**
 * One pool of a reward contract: what it takes, what you hold, what you have
 * earned, and three actions in order of how much we want you to take them —
 * Deposit (primary), Claim (secondary), Withdraw (quiet). Emergency withdraw
 * forfeits rewards, so it is tucked away and needs a press-and-hold.
 */
export function FarmPoolCard({ farm, pool, onNeedLp }: { farm: FarmState; pool: FarmPool; onNeedLp?: (pool: FarmPool) => void }) {
  const p = useProtocol();
  const act = useActions();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [raw, setRaw] = useState("");
  const [danger, setDanger] = useState(false);

  const reward = farm.reward === "peg" ? p.symbols.peg : p.symbols.share;
  const amount = parseAmount(raw, pool.decimals);
  const max = mode === "deposit" ? pool.wallet : pool.staked;
  const tooMuch = amount !== null && max !== null && amount > max;
  const ended = farm.phase === "ended";
  const hasPending = (pool.pending ?? 0n) > 0n;
  const hasStake = (pool.staked ?? 0n) > 0n;

  const reason =
    act.blocked ??
    (mode === "deposit" && ended
      ? "This programme has ended. Deposits would earn nothing — withdraw instead."
      : amount === null
        ? "Enter an amount."
        : tooMuch
          ? mode === "deposit"
            ? `You only hold ${formatToken(pool.wallet, pool.decimals)} ${pool.symbol}.`
            : `You only have ${formatToken(pool.staked, pool.decimals)} ${pool.symbol} staked here.`
          : null);

  async function submit() {
    if (amount === null || reason) return;
    const okay = mode === "deposit" ? await act.farmDeposit(farm, pool, amount) : await act.farmWithdraw(farm, pool, amount);
    if (okay) setRaw("");
  }

  return (
    <article data-reveal className="panel flex flex-col gap-5 p-5 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <TokenIcon symbol={ROLE_ICON[pool.role]} size={34} />
          <div className="min-w-0">
            <h3 className="truncate font-display text-[17px] font-semibold tracking-[-0.02em] text-bone">{pool.symbol}</h3>
            <p className="font-mono text-[11px] text-ash">
              Pool {pool.pid} · earns {reward}
            </p>
          </div>
        </div>
        <span className="chip chip-iris">{pool.weightBps !== null ? `${+(pool.weightBps / 100).toFixed(1)}% of emissions` : "weight —"}</span>
      </header>

      <dl className="grid grid-cols-3 gap-3 border-y border-white/[0.06] py-4 text-[13px]">
        <div>
          <dt className="label mb-1">Total staked</dt>
          <dd className="num text-bone">{formatToken(pool.totalStaked, pool.decimals)}</dd>
        </div>
        <div>
          <dt className="label mb-1">Your stake</dt>
          <dd className="num text-bone">{formatToken(pool.staked, pool.decimals)}</dd>
        </div>
        <div>
          <dt className="label mb-1">Earned</dt>
          <dd className={`num ${hasPending ? "text-iris-hot" : "text-bone"}`}>
            {formatToken(pool.pending)} <span className="text-[11px] text-ash">{reward}</span>
          </dd>
        </div>
      </dl>

      <div>
        <div className="mb-3 inline-flex gap-1 rounded-xl border border-white/[0.07] bg-black/30 p-1" role="tablist" aria-label="Action">
          {(["deposit", "withdraw"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              type="button"
              onClick={() => {
                setMode(m);
                setRaw("");
              }}
              className={`rounded-lg px-3 py-1.5 text-[12.5px] font-semibold capitalize transition-colors ${mode === m ? "bg-iris/15 text-iris-hot" : "text-ash hover:bg-white/5 hover:text-bone"}`}
            >
              {m}
            </button>
          ))}
        </div>
        <AmountField
          label={mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
          value={raw}
          onChange={setRaw}
          symbol={pool.symbol}
          decimals={pool.decimals}
          balance={p.account ? max : undefined}
          balanceLabel={mode === "deposit" ? "In wallet" : "Staked"}
          disabled={act.busy}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={submit} disabled={!!reason || act.busy} className={`btn flex-1 ${mode === "deposit" ? "btn-primary" : ""}`}>
            {act.busy ? "Working…" : mode === "deposit" ? "Deposit" : "Withdraw"}
          </button>
          <button
            type="button"
            onClick={() => act.farmClaim(farm, pool)}
            disabled={!!act.blocked || !hasPending || act.busy}
            title={!hasPending ? "Nothing to claim yet" : undefined}
            className="btn btn-spectre"
          >
            Claim {hasPending ? formatToken(pool.pending) : ""} {reward}
          </button>
        </div>
        {reason && <Reason>{reason}</Reason>}
        {mode === "withdraw" && !reason && <Reason>Withdrawing also pays out what you have earned. There is no lockup and no fee on these pools.</Reason>}
        {mode === "deposit" && p.account && pool.wallet === 0n && pool.role !== "other" && onNeedLp && (
          <Reason tone="warn">
            You hold no {pool.symbol}. It is a wrapped full-range liquidity position —{" "}
            <button type="button" onClick={() => onNeedLp(pool)} className="font-semibold text-iris-hot underline underline-offset-4">
              make one below
            </button>
            .
          </Reason>
        )}
        {mode === "deposit" && pool.role === "pairLp" && (
          <Reason>
            This is the token the xROOM stakes. <Link to="/masonry" className="text-iris-hot underline underline-offset-4">Stake it there</Link> to earn expansion instead.
          </Reason>
        )}
      </div>

      {hasStake && (
        <div className="border-t border-white/[0.06] pt-3">
          <button type="button" onClick={() => setDanger((v) => !v)} aria-expanded={danger} className="font-mono text-[11px] uppercase tracking-[0.14em] text-ash hover:text-bone-dim">
            {danger ? "▾" : "▸"} Emergency withdraw
          </button>
          {danger && (
            <div className="mt-3 rounded-xl border border-bad/30 bg-bad/[0.05] p-4">
              <p className="mb-3 text-[13px] leading-relaxed text-bone-dim">
                Returns your {formatToken(pool.staked, pool.decimals)} {pool.symbol} and{" "}
                <span className="font-semibold text-bad">
                  forfeits the {formatToken(pool.pending)} {reward} you have earned
                </span>
                . Use the normal Withdraw unless it is failing.
              </p>
              <HoldButton onConfirm={() => act.farmEmergencyWithdraw(farm, pool)} disabled={!!act.blocked || act.busy} hold={1.6}>
                Forfeit {formatToken(pool.pending)} {reward} and withdraw
              </HoldButton>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
