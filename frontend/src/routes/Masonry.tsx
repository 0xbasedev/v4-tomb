import { useRef, useState } from "react";
import { Link } from "react-router-dom";

import { AmountField, parseAmount } from "@/components/AmountField";
import { Countdown } from "@/components/Countdown";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { StatTile } from "@/components/StatTile";
import { NotDeployed, Reason, RuleBadge } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { HoldButton } from "@/components/fx/HoldButton";
import { formatToken, toNumber } from "@/lib/format";
import { useActions, useProtocol } from "@/lib/hooks";
import { useReveal } from "@/lib/motion/useReveal";
import { NAMES } from "@/lib/protocol";

/**
 * xROOM — the Masonry. Stake its token (by default the wrapped xTOMB/xSHARE
 * liquidity position), receive newly minted xTOMB each epoch the TWAP is above
 * the ceiling.
 *
 * Two lockups, both counted in epochs from your last stake, claim or
 * withdrawal: rewards after 3, the stake after 6. The page says exactly when
 * each opens, and warns before an action that would restart them.
 */
export function Masonry() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  const act = useActions();
  const m = p.masonry;
  const [mode, setMode] = useState<"stake" | "withdraw">("stake");
  const [raw, setRaw] = useState("");
  useReveal(root, [p.deployed]);

  const amount = parseAmount(raw);
  const staked = m.staked ?? 0n;
  const earned = m.earned ?? 0n;
  const hasStake = staked > 0n;

  // Lockups open at a known epoch; turn that into a wall-clock time via the Treasury's clock.
  const unlockAt = (epochs: number): number | null => {
    if (m.epochTimerStart === null || p.epoch.current === null || p.epoch.nextAt === null) return null;
    const left = m.epochTimerStart + epochs - p.epoch.current;
    return left <= 0 ? 0 : p.epoch.nextAt + (left - 1) * p.epoch.period;
  };
  const claimAt = unlockAt(m.rewardLockupEpochs);
  const withdrawAt = unlockAt(m.withdrawLockupEpochs);

  const restartNote = hasStake ? `This restarts both lockups: rewards unlock ${m.rewardLockupEpochs} epochs and your stake ${m.withdrawLockupEpochs} epochs from now.` : null;

  const stakeReason =
    act.blocked ??
    (!m.stakeToken
      ? "Reading the stake token…"
      : amount === null
        ? "Enter an amount."
        : m.wallet !== null && amount > m.wallet
          ? `You only hold ${formatToken(m.wallet)} ${m.stakeSymbol}.`
          : null);
  const withdrawReason =
    act.blocked ??
    (!hasStake
      ? "You have nothing staked."
      : m.canWithdraw === false
        ? `Locked for ${m.withdrawLockupEpochs} epochs after your last stake or claim.`
        : amount === null
          ? "Enter an amount."
          : amount > staked
            ? `You only have ${formatToken(staked)} staked.`
            : null);
  const claimReason = act.blocked ?? (earned === 0n ? "Nothing earned yet. Rewards arrive only in epochs where the TWAP is above the ceiling." : m.canClaim === false ? `Rewards unlock ${m.rewardLockupEpochs} epochs after your last stake or claim.` : null);
  const reason = mode === "stake" ? stakeReason : withdrawReason;

  async function submit() {
    if (amount === null || reason) return;
    const okay = mode === "stake" ? await act.roomStake(m.stakeToken!, amount) : await act.roomWithdraw(amount);
    if (okay) setRaw("");
  }

  return (
    <div ref={root}>
      <PageHeader
        eyebrow={`${NAMES.room} · the Masonry`}
        token="xROOM"
        title={
          <>
            Stake in <span className="amethyst-text">{NAMES.room}</span>
          </>
        }
        lede={`Stake the ${NAMES.peg}/${NAMES.share} liquidity token and receive newly minted ${NAMES.peg} every epoch the TWAP closes above the ceiling. The pool behind it cannot be traded, and deposits are untaxed.`}
        aside={
          <div className="panel panel-raised p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="label">Epoch {p.epoch.current ?? "—"}</span>
              <span className={`chip ${p.market.phase === "expansion" ? "chip-ok" : ""}`}>{p.market.phase === "expansion" ? "Expanding" : p.market.phase === "hold" ? "Not expanding" : "No reading"}</span>
            </div>
            <div className="font-display text-3xl font-semibold tracking-[-0.03em] text-bone">
              <Countdown to={p.epoch.nextAt} done="due now" />
            </div>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ash">until the next epoch</p>
            <p className="mt-4 border-t border-white/[0.06] pt-3 text-[13px] leading-relaxed text-bone-dim">
              {p.market.nextExpansion === null
                ? "The next expansion is read from the Treasury once deployed."
                : p.market.nextExpansion > 0n
                  ? `At the recorded TWAP the next epoch mints ${formatToken(p.market.nextExpansion)} ${NAMES.peg}, shared by stakers after fund cuts.`
                  : "At the recorded TWAP the next epoch mints nothing. Stakers earn only above the 1.01 ceiling."}
            </p>
          </div>
        }
      />

      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-10 md:px-8">
        {!p.deployed && <NotDeployed what={NAMES.room} />}
        {p.deployed && m.stakesPairLp === false && (
          <div data-reveal className="rounded-2xl border border-warn/35 bg-warn/[0.05] p-4 text-[13.5px] leading-relaxed text-bone-dim">
            <span className="font-semibold text-warn">Heads up:</span> this deployment's {NAMES.room} stakes <span className="font-mono text-bone">{m.stakeSymbol}</span>, not the {NAMES.peg}/{NAMES.share} liquidity wrapper. The steps below still apply to whichever token it reads from chain.
          </div>
        )}

        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Your position">
          <StatTile label="Total staked" numeric={toNumber(m.totalStaked)} unit={p.deployed ? m.stakeSymbol : undefined} hint="All stakers" />
          <StatTile label="Your stake" numeric={toNumber(m.staked)} unit={p.deployed ? m.stakeSymbol : undefined} hint={p.account ? "Earning each expansion" : "Connect a wallet to see it"} tone="amethyst" />
          <StatTile label="Earned" numeric={toNumber(m.earned)} unit={NAMES.peg} hint={earned > 0n ? (m.canClaim ? "Ready to claim" : "Locked for now") : "Paid per expansion epoch"} tone={earned > 0n ? "iris" : "default"} />
          <StatTile label="In your wallet" numeric={toNumber(m.wallet)} unit={p.deployed ? m.stakeSymbol : undefined} hint="Ready to stake" />
        </section>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1fr]">
          {/* ---- Stake / withdraw ---- */}
          <div data-reveal className="panel panel-raised p-5 md:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <TokenIcon symbol="PAIR-LP" size={30} />
                <h2 className="font-display text-lg font-semibold tracking-[-0.02em] text-bone">{mode === "stake" ? "Stake" : "Withdraw"}</h2>
              </div>
              <div className="inline-flex gap-1 rounded-xl border border-white/[0.07] bg-black/30 p-1" role="tablist" aria-label="Action">
                {(["stake", "withdraw"] as const).map((x) => (
                  <button key={x} role="tab" aria-selected={mode === x} type="button" onClick={() => { setMode(x); setRaw(""); }} className={`rounded-lg px-3 py-1.5 text-[12.5px] font-semibold capitalize transition-colors ${mode === x ? "bg-iris/15 text-iris-hot" : "text-ash hover:bg-white/5 hover:text-bone"}`}>
                    {x}
                  </button>
                ))}
              </div>
            </div>
            <AmountField
              label={mode === "stake" ? "Amount to stake" : "Amount to withdraw"}
              value={raw}
              onChange={setRaw}
              symbol={p.deployed ? m.stakeSymbol : `${NAMES.peg}/${NAMES.share} LP`}
              balance={p.account ? (mode === "stake" ? m.wallet : m.staked) : undefined}
              balanceLabel={mode === "stake" ? "In wallet" : "Staked"}
              disabled={act.busy || !p.deployed}
            />
            {mode === "stake" && !stakeReason && restartNote && <Reason tone="warn">{restartNote}</Reason>}
            <button type="button" onClick={submit} disabled={!!reason || act.busy} className={`btn mt-4 w-full ${mode === "stake" ? "btn-primary" : ""}`}>
              {act.busy ? "Working…" : mode === "stake" ? `Stake in ${NAMES.room}` : "Withdraw"}
            </button>
            {reason && <Reason>{reason}</Reason>}
            {mode === "stake" && !reason && <Reason>Staking is not a trade: no sell tax and no fee. One approval for the exact amount, then the stake.</Reason>}
            {mode === "withdraw" && !reason && <Reason tone="warn">Withdrawing also claims your rewards and restarts both lockups on what stays staked.</Reason>}
            {mode === "stake" && p.account && m.wallet === 0n && (
              <Reason tone="warn">
                You hold no {m.stakeSymbol}.{" "}
                <Link to="/farm" className="font-semibold text-iris-hot underline underline-offset-4">
                  Make it in the farm's workshop
                </Link>{" "}
                from {NAMES.peg} and {NAMES.share}.
              </Reason>
            )}
          </div>

          {/* ---- Rewards + lockups ---- */}
          <div data-reveal className="panel p-5 md:p-6">
            <div className="label mb-4">Rewards and lockups</div>
            <div className="mb-5 flex items-end justify-between gap-3">
              <div>
                <div className="font-display text-3xl font-semibold tracking-[-0.03em] text-bone">{formatToken(m.earned)}</div>
                <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-ash">{NAMES.peg} earned</div>
              </div>
              <button type="button" onClick={() => act.roomClaim()} disabled={!!claimReason || act.busy} className="btn btn-spectre">
                Claim
              </button>
            </div>
            {claimReason ? <Reason>{claimReason}</Reason> : <Reason tone="warn">Claiming restarts both lockups: your stake stays locked for another {m.withdrawLockupEpochs} epochs.</Reason>}

            <dl className="mt-5 space-y-3 border-t border-white/[0.06] pt-4 text-[13.5px]">
              <Lock label="Rewards" epochs={m.rewardLockupEpochs} open={m.canClaim} at={claimAt} active={hasStake} />
              <Lock label="Stake" epochs={m.withdrawLockupEpochs} open={m.canWithdraw} at={withdrawAt} active={hasStake} />
            </dl>

            {hasStake && (
              <div className="mt-5 border-t border-white/[0.06] pt-4">
                <p className="mb-3 text-[12.5px] leading-relaxed text-ash">Leaving entirely? Exit withdraws your whole stake and claims in one transaction.</p>
                <HoldButton onConfirm={() => act.roomExit()} disabled={!!act.blocked || m.canWithdraw === false || act.busy} hold={1.2}>
                  Exit {NAMES.room} — withdraw everything
                </HoldButton>
                {m.canWithdraw === false && <Reason>Exit is locked until the stake lockup ends.</Reason>}
              </div>
            )}
          </div>
        </section>

        <section>
          <SectionTitle kicker="Rules" title={`How ${NAMES.room} pays`} right={<RuleBadge />} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              ["Paid in expansion only", `When an epoch closes with the TWAP above 1.01, the Treasury mints ${NAMES.peg} and sends it here. At or below 1.01 there is no payout.`],
              ["Pro-rata", "Each expansion is split across stakers by their share of the total stake at that moment."],
              ["Two lockups", `Rewards unlock after ${m.rewardLockupEpochs} epochs and the stake after ${m.withdrawLockupEpochs}. Both count from your last stake, or your last claim or withdrawal that paid a reward — each of those restarts the clock.`],
              ["Untradeable pool", `The ${NAMES.peg}/${NAMES.share} pool rejects every swap. It exists to be staked, so it can never be used to route around the sell tax.`],
            ].map(([k, v]) => (
              <div key={k} data-reveal className="panel p-5">
                <div className="label mb-2">{k}</div>
                <p className="text-[13.5px] leading-relaxed text-bone-dim">{v}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Lock({ label, epochs, open, at, active }: { label: string; epochs: number; open: boolean | null; at: number | null; active: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-bone-dim">
        {label} <span className="font-mono text-[11px] text-ash">· {epochs} epochs</span>
      </dt>
      <dd>
        {!active ? (
          <span className="font-mono text-[12px] text-ash">starts when you stake</span>
        ) : open ? (
          <span className="chip chip-ok">Unlocked</span>
        ) : (
          <span className="chip chip-warn">
            Unlocks in <Countdown to={at && at > 0 ? at : null} done="moments" />
          </span>
        )}
      </dd>
    </div>
  );
}
