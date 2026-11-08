import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Modal } from "@/components/Modal";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { PendingBadge, PendingPanel, Reason } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { useProtocol } from "@/lib/hooks";
import { DAO_WALLET, FARM_POLICY, SQUARE_SUPPLY } from "@/lib/launch";
import { useReveal } from "@/lib/motion/useReveal";
import type { TokenId } from "@/lib/tokens";

/**
 * Farm — after Genesis, xSHARE emissions for official LP. For first launch,
 * pending xSHARE cannot be claimed to the wallet; the only outlet is a zap
 * that stakes X Share/WETH LP into Masonry.
 */
const WHY = "No Farm staking contract is bound in the merge-branch deployment yet (Farm staking and migration remain pending on the backend).";

function formatCountdown(total: number) {
  const s = Math.max(0, Math.floor(total));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function Farm() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  useReveal(root, []);
  const perDay = SQUARE_SUPPLY.farming / FARM_POLICY.emissionDays;
  const [withdrawPool, setWithdrawPool] = useState<string | null>(null);
  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Farm · xSHARE emissions · pending"
        token="xSHARE"
        title={<span className="spectre-text">Farm</span>}
        lede={`After Genesis, official LP earns xSHARE: ${SQUARE_SUPPLY.farming.toLocaleString()} xSHARE over ${FARM_POLICY.emissionDays} days (≈${perDay.toFixed(1)} a day). Pending xSHARE is zapped into Masonry rather than claimed to your wallet.`}
        aside={
          <div className="panel p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Status</span>
              <PendingBadge />
            </div>
            <p className="text-[13px] leading-relaxed text-bone-dim">{WHY}</p>
            <Link to="/genesis" className="btn btn-ghost mt-3 h-9 px-3 text-[12.5px]">
              {p.clock?.phase === "ended" ? "Withdraw Genesis stakes →" : "Genesis is running →"}
            </Link>
          </div>
        }
      />
      <div className="mx-auto w-full max-w-7xl space-y-8 px-4 pb-10 md:px-8">
        <section>
          <SectionTitle kicker="Configured" title="Farm pools" right={<PendingBadge label="Staking pending" />} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {(["xTOMB-USDC", "xSHARE-USDC"] as TokenId[]).map((id) => (
              <article key={id} data-testid={`farm-pool-${id}`} data-reveal className="panel p-5">
                <div className="flex items-center gap-3">
                  <TokenIcon symbol={id} size={36} />
                  <div>
                    <h3 className="font-display text-[16px] font-semibold text-bone">{id === "xTOMB-USDC" ? "xTOMB/USDC LP" : "xSHARE/USDC LP"}</h3>
                    <div className="text-[12px] text-ash">vault shares · earns xSHARE</div>
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-[12.5px]">
                  <div>
                    <dt className="text-ash">Emission split</dt>
                    <dd className="text-bone-dim">pending</dd>
                  </div>
                  <div>
                    <dt className="text-ash">Compound</dt>
                    <dd className="text-bone">every {FARM_POLICY.compoundCooldownSeconds / 3600}h</dd>
                  </div>
                  <div>
                    <dt className="text-ash">Withdraw</dt>
                    <dd className="text-bone">{FARM_POLICY.withdrawCooldownSeconds / 60} min cooldown</dd>
                  </div>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" disabled className="btn h-9 px-4 text-[12.5px]">
                    Stake
                  </button>
                  <button type="button" disabled className="btn h-9 px-4 text-[12.5px] border-ok/40 bg-ok/15 text-ok">
                    {FARM_POLICY.zapLabel}
                  </button>
                  <button type="button" disabled className="btn h-9 px-4 text-[12.5px]">
                    {FARM_POLICY.compoundLabel}
                  </button>
                  <button
                    type="button"
                    className="btn h-9 px-4 text-[12.5px]"
                    onClick={() => setWithdrawPool(id)}
                  >
                    Withdraw
                  </button>
                </div>
                <p className="mt-3 text-[12.5px] leading-relaxed text-ok/90">{FARM_POLICY.zapNotice}</p>
                <p className="mt-2 text-[12px] leading-relaxed text-ash">{FARM_POLICY.fireTaxNote}</p>
                <Reason>{WHY}</Reason>
              </article>
            ))}
          </div>
        </section>
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PendingPanel title="Farm auto-compounder">
            The planned keeper product (one purchase covering both Farm pools) has no contract or ABI in the handoff. It will be offered only once a bound contract
            exposes its price and purchase call.
          </PendingPanel>
          <PendingPanel title="Genesis → Farm migration">
            Moving Genesis LP stakes into the Farm needs the Farm contract. Until then, withdraw from Genesis and keep the vault shares — they're redeemable for
            xTOMB and USDC at any time.
          </PendingPanel>
        </section>
      </div>
      {withdrawPool && (
        <WithdrawCooldownModal pool={withdrawPool} onClose={() => setWithdrawPool(null)} />
      )}
    </div>
  );
}

function WithdrawCooldownModal({ pool, onClose }: { pool: string; onClose: () => void }) {
  const total = FARM_POLICY.withdrawCooldownSeconds;
  const [left, setLeft] = useState(total);
  const [rewards, setRewards] = useState(1.25);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      setLeft(Math.max(0, total - elapsed));
      setRewards(1.25 + elapsed * 0.0008);
    }, 250);
    return () => window.clearInterval(id);
  }, [total]);
  const ready = left <= 0;
  return (
    <Modal kicker={`${pool} · preview`} title={FARM_POLICY.withdrawTitle} onClose={onClose} tone="ok">
      <div className="space-y-4">
        <div className="rounded-2xl border border-ok/30 bg-ok/[0.08] p-4 backdrop-blur-md">
          <div className="label mb-1 text-ok">Cooldown</div>
          <div className="font-display text-3xl font-semibold tracking-tight text-ok" data-testid="withdraw-countdown">
            {formatCountdown(left)}
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ok">{FARM_POLICY.cooldownNotice}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <div className="label mb-1">Pending xSHARE</div>
          <div className="font-mono text-[18px] text-bone" data-testid="withdraw-live-rewards">
            {rewards.toFixed(4)} xSHARE
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ok/90">{FARM_POLICY.forfeitNotice}</p>
          <p className="mt-2 text-[12.5px] text-ash">{FARM_POLICY.cancelHint}</p>
          <p className="mt-1 text-[11px] text-ash">DAO wallet · {DAO_WALLET}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn border-ok/40 bg-ok/15 text-ok hover:bg-ok/25">
            {FARM_POLICY.compoundLabel}
          </button>
          <button type="button" className="btn border-ok/40 bg-ok/15 text-ok hover:bg-ok/25">
            {FARM_POLICY.cancelLabel}
          </button>
          <button type="button" disabled={!ready} className="btn border-ok/40 bg-ok/15 text-ok hover:bg-ok/25">
            {FARM_POLICY.completeWithdrawLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
