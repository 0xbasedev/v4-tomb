import { useState } from "react";
import { Link } from "react-router-dom";

import { CompoundButton } from "@/components/CompoundButton";
import { AnimatedNumber } from "@/components/fx/AnimatedNumber";
import { Modal, Row } from "@/components/Modal";
import { Reason, SimBadge } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { DRIVER_LABEL } from "@/lib/fireTax";
import { compoundSplit, emissionShare, fmtDuration, LP_DAY, walletClaim } from "@/lib/genesis";
import { useActions, useCompoundPlan, useProtocol } from "@/lib/hooks";
import { depositFeeBps, GENESIS_POLICY, pct } from "@/lib/launch";
import { maskDecimalInput } from "@/lib/util/decimal";

/**
 * One Genesis pool (MasonryGenesisStaking pool 0 = standard asset, pool 1 =
 * xTOMB/USDC vault shares). Every action states why it's disabled.
 */

const fmt = (n: number | null | undefined, d = 4) => (n === null || n === undefined ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d }));

export function PoolPanel({ pool }: { pool: 0 | 1 }) {
  const p = useProtocol();
  const actions = useActions();
  const [amount, setAmount] = useState("");
  const [sheet, setSheet] = useState<"claim" | "compound" | null>(null);
  const c = p.clock;
  const pos = p.staking.positions[pool];
  const total = p.staking.totals[pool];
  const share = c ? emissionShare(pool, c) : 0;
  const lp = pool === 1;
  const asset = lp ? "xTOMB-USDC" : "USDC";
  const bal = p.balances[asset] ?? null;
  const amt = parseFloat(amount) || 0;
  const cooldown = Math.max(0, p.staking.nextCompoundAt[pool] - p.now);
  const pending = pos?.pending ?? 0;
  const tax = p.taxFor("xTOMB", (pending * GENESIS_POLICY.liquidShare * (p.prices.xTOMB ?? 1)) / 2);
  const live = useCompoundPlan(pool, tax.rateBps, p.poolFeeBps.xTOMB);

  // Why deposits are closed right now. Network problems come first: no read
  // below them can be trusted until the wallet is on a verified deployment.
  const netBlock = p.sim || p.net.canTransact ? null : (p.net.reason ?? "Transactions are unavailable.");
  const depositBlock = netBlock
    ? netBlock
    : !p.account
    ? "Connect a wallet."
    : p.genesisScheduled === false
      ? "Genesis isn't scheduled yet. Staking opens once the scheduler sets the start date in Admin."
      : !p.pass
      ? "Buy a Genesis pass first — every staking entry point checks it."
      : !c
        ? "Genesis schedule unavailable."
        : lp
          ? c.phase === "ended"
            ? "The LP pool closed with Genesis. Withdrawals and claims stay open."
            : !c.lpOpen
              ? `Opens at the start of Day ${LP_DAY} — in ${fmtDuration(c.secondsToLp)}.`
              : null
          : c.phase === "ended"
            ? "Genesis has ended. Withdrawals and claims stay open."
            : c.phase === "pre"
              ? p.pass === "ultra" && c.ultraEarly
                ? null
                : p.pass === "ultra"
                  ? `Ultra early staking opens 24 hours before the start — in ${fmtDuration(c.secondsToStart - GENESIS_POLICY.ultraEarlySeconds)}.`
                  : `Opens at the Genesis start — in ${fmtDuration(c.secondsToStart)}. Ultra can pre-stake in the last 24 hours.`
              : null;
  const amountBlock = !depositBlock && amt > 0 && bal !== null && amt > bal ? `Not enough ${asset} — you have ${fmt(bal)}.` : null;
  const claimBlock = netBlock ? netBlock : !p.account ? "Connect a wallet." : !(pending > 0) ? "Nothing accrued yet." : cooldown > 0 ? `Claims and compounds share one 3-hour clock per pool — ready in ${fmtDuration(cooldown)}.` : null;
  const compoundBlock =
    claimBlock ??
    (!c?.lpOpen ? (c?.phase === "ended" ? "Compounding closed with Genesis (the LP pool is closed)." : `Compounding goes into the LP pool, which opens on Day ${LP_DAY}.`) : tax.rateBps === null ? tax.blocked : !p.sim && !live.plan ? "Waiting for the vault range and validated spot to plan the compound." : null);

  const status = !c
    ? p.genesisScheduled === false
      ? "Not scheduled"
      : "—"
    : lp
      ? c.phase === "ended"
        ? "Closed · withdraw & claim"
        : c.lpOpen
          ? "Open"
          : `Opens Day ${LP_DAY}`
      : c.phase === "ended"
        ? "Ended · withdraw & claim"
        : c.phase === "pre"
          ? c.ultraEarly
            ? "Ultra early access"
            : "Not started"
          : "Open";

  return (
    <article data-testid={`pool-${pool}`} className="panel overflow-hidden p-0">
      <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:items-center">
        <div className="flex items-center gap-3">
          <TokenIcon symbol={asset} size={38} />
          <div className="min-w-0">
            <h3 className="font-display text-[17px] font-semibold text-bone">{lp ? "xTOMB/USDC LP" : "Standard pool"}</h3>
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ash">
              <span className="chip h-5 px-2 text-[10px]">pool {pool}</span>
              <span>{lp ? "vault shares · official pair" : "USDC (standard asset, deployment-bound)"}</span>
            </div>
          </div>
        </div>
        <Metric label="Emissions now" value={`${Math.round(share * 100)}%`} sub={lp ? "75% from Day 2" : "100% on Day 1, then 25%"} tone={share >= 0.75 ? "text-ember-hot" : undefined} />
        <Metric label={p.sim ? "Your stake · sim" : "Your stake"} value={fmt(pos?.shares ?? null, lp ? 4 : 2)} sub={total !== null ? `of ${fmt(total, 0)} staked` : undefined} />
        <div>
          <div className="label mb-1">{p.sim ? "Pending xTOMB · sim" : "Pending xTOMB"}</div>
          <AnimatedNumber value={pos ? pending : null} format={(n) => fmt(n, 4)} className="num text-[18px] text-ember-hot" />
          <div className="text-[11px] text-ash">{p.sim ? "accrues every second" : "stored; accrual since last checkpoint not shown"}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 border-t border-white/5 bg-black/15 p-5 lg:grid-cols-2">
        {/* Stake / withdraw */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className={`chip h-6 ${status === "Open" || status === "Ultra early access" ? "chip-ok" : ""}`}>{status}</span>
            <button type="button" onClick={() => bal && setAmount(String(bal))} className="font-mono text-[11px] text-ash hover:text-ember-hot">
              Wallet {fmt(bal, 2)} {asset === "USDC" ? "USDC" : "LP"} · MAX
            </button>
          </div>
          <label className="well flex items-center gap-2 px-3 py-2">
            <input
              aria-label={`Amount to stake in pool ${pool}`}
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(maskDecimalInput(e.target.value))}
              className="num min-w-0 flex-1 bg-transparent text-[20px] text-bone outline-none"
            />
            <span className="font-mono text-[11px] text-ash">{lp ? "LP shares" : "USDC"}</span>
          </label>
          {!lp && (
            <p className="mt-2 text-[12px] text-ash">
              {pct(depositFeeBps(p.pass))} deposit fee for your {p.pass ? "pass" : "Genesis pass"}
              {amt > 0 ? ` — you stake ${fmt(amt * (1 - depositFeeBps(p.pass) / 10_000), 2)} USDC, ${fmt((amt * depositFeeBps(p.pass)) / 10_000, 2)} goes to the Treasury` : ""}.
              {depositFeeBps(p.pass) > 0 ? " Ultra pays none." : ""}
            </p>
          )}
          {lp && <p className="mt-2 text-[12px] text-ash">The LP burn fee is {pct(GENESIS_POLICY.lpBurnFeeBps)} of the shares on each deposit or compound, taken once; only net shares are credited.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary h-10 px-4 text-[13px]" disabled={!!depositBlock || !!amountBlock || !(amt > 0) || actions.busy} onClick={() => actions.deposit(pool, amt, null, () => setAmount(""))}>
              Stake
            </button>
            <button
              type="button"
              className="btn h-10 px-4 text-[13px]"
              disabled={!p.account || !(pos && pos.shares > 0) || !(amt > 0) || amt > (pos?.shares ?? 0) || actions.busy}
              onClick={() => actions.withdraw(pool, amt, () => setAmount(""))}
              title="Principal can be withdrawn at any time, including after Genesis"
            >
              Withdraw
            </button>
            {lp && (
              <Link to="/swap?mode=liquidity" className="btn btn-ghost h-10 px-3 text-[13px]">
                Get LP shares →
              </Link>
            )}
          </div>
          {(depositBlock || amountBlock) && <Reason tone={amountBlock ? "warn" : "ash"}>{depositBlock ?? amountBlock}</Reason>}
        </div>

        {/* Claim / compound */}
        <div className="lg:border-l lg:border-white/5 lg:pl-4">
          <div className="label mb-2">Rewards</div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn h-10 px-4 text-[13px]" disabled={!!claimBlock || actions.busy} onClick={() => setSheet("claim")}>
              Claim to wallet
            </button>
            <CompoundButton
              readyIn={compoundBlock && cooldown > 0 ? cooldown : 0}
              pending={compoundBlock && cooldown === 0 ? 0 : pending}
              rewardSymbol="xTOMB"
              disabled={!!compoundBlock || actions.busy}
              onCompound={() => setSheet("compound")}
              readyTitle="Sell part of the liquid half for USDC and mint xTOMB/USDC LP into pool 1"
            />
          </div>
          {(claimBlock || compoundBlock) && <Reason>{compoundBlock ?? claimBlock}</Reason>}
          <p className="mt-2 text-[11.5px] text-ash">Half of every reward is liquid, half vests in 16 six-hour installments after Genesis.</p>
        </div>
      </div>

      {sheet && (
        <SettleSheet
          pool={pool}
          mode={sheet}
          reward={p.sim ? pending : (live.reward ?? pending)}
          taxBps={tax.rateBps ?? 0}
          taxDriver={tax.driver ? DRIVER_LABEL[tax.driver] : ""}
          simulated={p.sim}
          onClose={() => setSheet(null)}
          onConfirm={(close) => (sheet === "claim" ? actions.claim(pool, close) : actions.compound(pool, live.plan, close))}
          busy={actions.busy}
        />
      )}
    </article>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className={`num text-[18px] ${tone ?? "text-bone"}`}>{value}</div>
      {sub && <div className="text-[11px] text-ash">{sub}</div>}
    </div>
  );
}

function SettleSheet({
  pool,
  mode,
  reward,
  taxBps,
  taxDriver,
  simulated,
  onClose,
  onConfirm,
  busy,
}: {
  pool: 0 | 1;
  mode: "claim" | "compound";
  reward: number;
  taxBps: number;
  taxDriver: string;
  simulated: boolean;
  onClose: () => void;
  onConfirm: (close: () => void) => void;
  busy: boolean;
}) {
  const w = walletClaim(reward);
  const k = compoundSplit(reward, { automated: false, taxBps });
  const per = w.vested / GENESIS_POLICY.installments;
  return (
    <Modal kicker={`Pool ${pool} · ${simulated ? "simulated" : "estimate — the contract settles the exact amount"}`} title={mode === "claim" ? "Claim to wallet" : "Compound into the LP pool"} onClose={onClose}>
      {(close) => (
        <>
          {simulated && (
            <div className="mb-3 flex justify-end">
              <SimBadge label="Simulated · no wallet request" />
            </div>
          )}
          <dl className="space-y-2 text-[13px]">
            <Row k="Reward" v={`${fmt(reward)} xTOMB`} strong />
            <Row k="Vested half" v={`${fmt(w.vested)} xTOMB`} sub={`16 × ${fmt(per)} · first at Genesis end + 6h, each next 6h after the last claim`} />
            {mode === "claim" ? (
              <>
                <Row k="Liquid half" v={`${fmt(w.liquid)} xTOMB`} />
                <Row k={`Wallet claim fee (${pct(GENESIS_POLICY.walletFeeBps)})`} v={`−${fmt(w.treasury)} to Treasury`} tone="text-warn" />
                <Row k="To your wallet" v={`${fmt(w.toWallet)} xTOMB`} strong />
              </>
            ) : (
              <>
                <Row k="Liquid half to compound" v={`${fmt(k.budget)} xTOMB`} />
                <Row k="Sold for USDC (sell leg)" v={`≈ ${fmt(k.sold)} xTOMB`} sub="the rest pairs with the USDC in the vault range" />
                <Row k={`Fire Tax on the sell leg (${pct(taxBps)})`} v={`−${fmt(k.fireTax)} xTOMB`} sub={taxDriver} tone={taxBps > 100 ? "text-warn" : undefined} />
                <Row k="LP burn fee (once, from gross shares)" v={`−${fmt(k.lpBurn)} xTOMB-equivalent`} />
                <Row k="Credited to pool 1" v={`≈ ${fmt(k.net)} xTOMB of LP`} strong />
                <p className="pt-1 text-[11.5px] text-ash">No claim fee and no keeper fee on a manual compound. Unused xTOMB (at most 3%) returns to your wallet.</p>
              </>
            )}
          </dl>
          <button type="button" className="btn btn-primary mt-5 h-12 w-full" disabled={busy} onClick={() => onConfirm(close)}>
            {mode === "claim" ? "Claim" : "Compound"}
            {simulated ? " (simulated)" : ""}
          </button>
        </>
      )}
    </Modal>
  );
}
