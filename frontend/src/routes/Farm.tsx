import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";

import { Modal } from "@/components/Modal";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { PendingBadge, PendingPanel, Reason } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { masonryFarmAbi } from "@/lib/abis/masonry";
import { useProtocol } from "@/lib/hooks";
import { DAO_WALLET, FARM_POLICY, pct, SQUARE_SUPPLY } from "@/lib/launch";
import { useReveal } from "@/lib/motion/useReveal";
import type { TokenId } from "@/lib/tokens";

/**
 * Farm — after Genesis, xSHARE emissions for official LP. For first launch,
 * pending xSHARE cannot be claimed to the wallet; the only outlet is a zap
 * that stakes X Share/WETH LP into Masonry.
 *
 * Compound is restyled (not blocked) from each pool's on-chain lastCompoundAt.
 * The 3-hour window is policy.farmsCompoundCooldownSeconds (10800).
 */
const WHY = "No Farm staking contract is bound in the merge-branch deployment yet (Farm staking and migration remain pending on the backend).";
const POOLS = ["xTOMB-USDC", "xSHARE-USDC"] as const;
const POOL_PID: Record<(typeof POOLS)[number], number> = { "xTOMB-USDC": 0, "xSHARE-USDC": 1 };

function formatCountdown(total: number) {
  const s = Math.max(0, Math.floor(total));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function formatWindowLeft(total: number) {
  const s = Math.max(0, Math.floor(total));
  if (s <= 0) return "0";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

function previewStamp(pool: string, compounded: string | null): number {
  if (!compounded) return 0;
  if (compounded === "1" || compounded === pool) return Math.floor(Date.now() / 1000) - 120;
  return 0;
}

function useFarmLastCompoundAt(pid: number, fallback: number) {
  const p = useProtocol();
  const { address } = useAccount();
  const farm = p.net.deployment?.contracts?.farm as Address | undefined;
  const read = useReadContract({
    address: farm,
    abi: masonryFarmAbi,
    functionName: "lastCompoundAt",
    args: address ? [BigInt(pid), address] : undefined,
    query: { enabled: Boolean(farm && address) },
  });
  if (farm && address && read.data !== undefined) return Number(read.data);
  return fallback;
}

function CompoundControl({
  lastCompoundAt,
  onCompound,
}: {
  lastCompoundAt: number;
  onCompound: () => void;
}) {
  const windowSec = FARM_POLICY.compoundCooldownSeconds;
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 250);
    return () => window.clearInterval(id);
  }, []);
  const readyAt = lastCompoundAt ? lastCompoundAt + windowSec : 0;
  const left = lastCompoundAt && now < readyAt ? readyAt - now : 0;
  const ready = left <= 0;
  const returnAt = lastCompoundAt
    ? new Date(readyAt * 1000).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  const title = ready
    ? "Compound is ready"
    : `Green returns at ${returnAt} America/New_York (${formatWindowLeft(left)})`;
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onCompound}
        title={title}
        data-testid="compound-button"
        data-ready={ready ? "true" : "false"}
        className={`btn h-9 px-4 text-[12.5px] ${
          ready
            ? "border-ok/40 bg-ok/15 text-ok hover:bg-ok/25"
            : "border-white/10 bg-white/[0.04] text-ash hover:bg-white/[0.08]"
        }`}
      >
        {FARM_POLICY.compoundLabel}
      </button>
      <div
        data-testid="next-compound"
        className={`font-mono text-[11px] ${ready ? "text-ok" : "text-ash"}`}
      >
        Next Compound: {formatWindowLeft(left)}
      </div>
    </div>
  );
}

export function Farm() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  const [search] = useSearchParams();
  useReveal(root, []);
  const perDay = SQUARE_SUPPLY.farming / FARM_POLICY.emissionDays;
  const [withdrawPool, setWithdrawPool] = useState<string | null>(null);
  const [stamps, setStamps] = useState<Record<string, number>>({});
  const compounded = search.get("compounded");
  const lastFor = (id: string) => stamps[id] ?? previewStamp(id, compounded);
  const mark = (id: string) => setStamps((prev) => ({ ...prev, [id]: Math.floor(Date.now() / 1000) }));
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
            {POOLS.map((id) => (
              <FarmPoolCard
                key={id}
                id={id}
                lastCompoundAt={lastFor(id)}
                onCompound={() => mark(id)}
                onWithdraw={() => setWithdrawPool(id)}
              />
            ))}
          </div>
        </section>
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PendingPanel title="Farm auto-compounder">
            The planned keeper product (one purchase covering both Farm pools) has no contract or ABI in the handoff. It will be offered only once a bound contract
            exposes its price and purchase call.
          </PendingPanel>
          <PendingPanel title="Genesis → Farm migration">
            Moving Genesis LP stakes into the Farm needs the Farm contract. Until then, withdraw from Genesis and keep the vault shares — they&apos;re redeemable for
            xTOMB and USDC at any time.
          </PendingPanel>
        </section>
      </div>
      {withdrawPool && (
        <WithdrawCooldownModal
          pool={withdrawPool}
          lastCompoundAt={lastFor(withdrawPool)}
          onCompound={() => mark(withdrawPool)}
          onClose={() => setWithdrawPool(null)}
        />
      )}
    </div>
  );
}

function FarmPoolCard({
  id,
  lastCompoundAt,
  onCompound,
  onWithdraw,
}: {
  id: (typeof POOLS)[number];
  lastCompoundAt: number;
  onCompound: () => void;
  onWithdraw: () => void;
}) {
  const chained = useFarmLastCompoundAt(POOL_PID[id], lastCompoundAt);
  return (
    <article data-testid={`farm-pool-${id}`} data-reveal className="panel p-5">
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
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <button type="button" disabled className="btn h-9 px-4 text-[12.5px]">
          Stake
        </button>
        <button type="button" disabled className="btn h-9 px-4 text-[12.5px] border-ok/40 bg-ok/15 text-ok">
          {FARM_POLICY.zapLabel}
        </button>
        <CompoundControl lastCompoundAt={chained} onCompound={onCompound} />
        <button type="button" className="btn h-9 px-4 text-[12.5px]" onClick={onWithdraw}>
          Withdraw
        </button>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ok/90">{FARM_POLICY.zapNotice}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-ash">{FARM_POLICY.fireTaxNote}</p>
      <Reason>{WHY}</Reason>
    </article>
  );
}

function WithdrawCooldownModal({
  pool,
  lastCompoundAt,
  onCompound,
  onClose,
}: {
  pool: string;
  lastCompoundAt: number;
  onCompound: () => void;
  onClose: () => void;
}) {
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
          <p className="mt-2 text-[13px] text-bone" data-testid="withdraw-fee">
            Withdrawal fee: {pct(FARM_POLICY.withdrawFeeBps)} of withdrawn liquidity, paid to the DAO wallet.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <CompoundControl lastCompoundAt={lastCompoundAt} onCompound={onCompound} />
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
