import { useRef, useState } from "react";
import { useReadContracts } from "wagmi";
import { isAddressEqual, zeroAddress, type Abi, type Address } from "viem";

import { Reason, SimBadge } from "@/components/Status";
import { masonryGenesisScheduleAbi, masonryGenesisSettlementAbi, masonryGenesisStakingAbi } from "@/lib/abis/masonry";
import { GENESIS_DAYS, LP_DAY } from "@/lib/genesis";
import { useActions, useProtocol } from "@/lib/hooks";
import { GENESIS_POLICY } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { usePreview } from "@/lib/preview";

/**
 * Deferred Genesis scheduling — MasonryGenesisSchedule.schedule(uint256).
 *
 * The schedule can be deployed with start = 0. Its immutable `scheduler`
 * then sets the start exactly once; the contract rejects a past start, a
 * second call, or any other caller. Before the wallet is asked to sign, this
 * panel checks what the contract and the rest of Genesis need:
 *   - a verified deployment on the wallet's chain,
 *   - the connected wallet is `scheduler()`,
 *   - start() is still 0,
 *   - staking reads this schedule and this settlement, and is funded,
 *   - settlement is bound to this staking,
 *   - the chosen time is in the future.
 * The write itself goes through the shared action path: simulate first, then
 * re-check the account and chain at the signature prompt, then wait for the
 * receipt and re-read the on-chain start.
 */

const ZERO = zeroAddress as Address;
const fmtLocal = (s: number) => new Date(s * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function GenesisSchedulePanel() {
  const p = useProtocol();
  const preview = usePreview();
  const actions = useActions();
  const root = useRef<HTMLElement>(null);
  const d = p.net.deployment;
  const c = d?.contracts;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: c
      ? [
          { address: c.schedule, abi: masonryGenesisScheduleAbi, functionName: "scheduler" },
          { address: c.schedule, abi: masonryGenesisScheduleAbi, functionName: "start" },
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "schedule" },
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "settlement" },
          { address: c.staking, abi: masonryGenesisStakingAbi, functionName: "funded" },
          { address: c.settlement, abi: masonryGenesisSettlementAbi, functionName: "staking" },
        ]
      : [],
    query: { enabled: !!c, refetchInterval: 30_000 },
  });
  const r = (i: number) => (reads.data?.[i]?.status === "success" ? reads.data[i]!.result : undefined);
  const [date, setDate] = useState("");
  const startUnix = date ? Math.floor(new Date(date).getTime() / 1000) : NaN;
  const nowSec = p.sim ? preview.now : Math.floor(Date.now() / 1000);

  // Live readings, or the simulated equivalents in Preview.
  const scheduler = (p.sim ? (preview.owner ? "sample" : "someone else") : (r(0) as Address | undefined)) ?? null;
  const onChainStart = p.sim ? (p.genesisScheduled ? preview.start : 0) : r(1) !== undefined ? Number(r(1) as bigint) : null;
  const scheduled = onChainStart !== null && onChainStart !== 0;
  const isScheduler = p.sim ? preview.owner && preview.sampleWallet : !!p.net.walletAddress && !!r(0) && isAddressEqual(r(0) as Address, p.net.walletAddress);

  const checks: { label: string; ok: boolean | null; why: string }[] = p.sim
    ? [
        { label: "Verified deployment on this chain", ok: true, why: "" },
        { label: "Your wallet is the scheduler", ok: isScheduler, why: "Preview's sample wallet is the scheduler while Owner is on in the dock." },
        { label: "Start still unset (0)", ok: !scheduled, why: "The start can be set only once." },
        { label: "Staking reads this schedule and settlement", ok: true, why: "" },
        { label: "Genesis reward budget funded", ok: true, why: "" },
        { label: "Settlement bound to staking", ok: true, why: "" },
      ]
    : [
        { label: "Verified deployment on this chain", ok: !!d, why: p.net.reason ?? "No verified deployment on this network." },
        { label: "Your wallet is the scheduler", ok: r(0) === undefined ? null : isScheduler, why: r(0) ? `Only ${String(r(0)).slice(0, 8)}… can schedule.` : "Reading scheduler()…" },
        { label: "Start still unset (0)", ok: onChainStart === null ? null : !scheduled, why: "The start can be set only once." },
        {
          label: "Staking reads this schedule and settlement",
          ok: r(2) === undefined || r(3) === undefined ? null : isAddressEqual(r(2) as Address, c?.schedule ?? ZERO) && isAddressEqual(r(3) as Address, c?.settlement ?? ZERO),
          why: "Staking must point at this schedule and this settlement.",
        },
        { label: "Genesis reward budget funded", ok: r(4) === undefined ? null : r(4) === true, why: "Fund staking first (Actions below)." },
        { label: "Settlement bound to staking", ok: r(5) === undefined ? null : isAddressEqual(r(5) as Address, c?.staking ?? ZERO), why: "Bind settlement to staking first (Actions below)." },
      ];
  const failing = checks.find((x) => x.ok !== true);
  const future = Number.isFinite(startUnix) && startUnix > nowSec + 60;
  const reason = scheduled
    ? "Genesis is already scheduled — the contract allows this once."
    : failing
      ? failing.ok === null
        ? `Checking: ${failing.label.toLowerCase()}…`
        : failing.why
      : !date
        ? "Pick the start date and time."
        : !future
          ? "Choose a time at least a minute in the future — the contract rejects a past start."
          : null;

  // The preview timeline glides to the chosen date.
  useGSAP(
    () => {
      if (!future || prefersReducedMotion()) return;
      gsap.fromTo(".gs-seg", { scaleX: 0 }, { scaleX: 1, transformOrigin: "left center", duration: 0.5, stagger: 0.04, ease: EASE.settle });
    },
    { scope: root, dependencies: [date, future] },
  );

  const confirm = () => {
    if (reason) return;
    const label = `Schedule Genesis for ${fmtLocal(startUnix)}`;
    if (p.sim) return actions.admin(label, ZERO, masonryGenesisScheduleAbi as Abi, "schedule", [BigInt(startUnix)], () => preview.act.schedule(startUnix));
    actions.admin(label, c!.schedule, masonryGenesisScheduleAbi as Abi, "schedule", [BigInt(startUnix)], () => void reads.refetch());
  };

  const lp = startUnix + GENESIS_POLICY.lpDelaySeconds;
  const end = startUnix + GENESIS_POLICY.durationSeconds;

  return (
    <section ref={root} data-reveal className="panel panel-raised p-5 md:p-6" data-testid="genesis-schedule">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="label mb-1">Genesis schedule · set once</div>
          <h2 className="font-display text-xl font-semibold text-bone">
            {scheduled ? `Scheduled for ${fmtLocal(onChainStart!)}` : onChainStart === 0 ? "Genesis isn't scheduled yet" : "Genesis start"}
          </h2>
        </div>
        {p.sim && <SimBadge />}
      </div>

      {scheduled ? (
        <dl className="grid grid-cols-1 gap-2 text-[12.5px] sm:grid-cols-3">
          {[
            ["Start", onChainStart!],
            [`LP pool opens (Day ${LP_DAY})`, onChainStart! + GENESIS_POLICY.lpDelaySeconds],
            ["Ends", onChainStart! + GENESIS_POLICY.durationSeconds],
          ].map(([k, v]) => (
            <div key={k as string} className="rounded-xl bg-black/25 p-3">
              <dt className="label mb-1">{k}</dt>
              <dd className="num text-bone">{fmtLocal(v as number)}</dd>
              <dd className="font-mono text-[10.5px] text-ash">{new Date((v as number) * 1000).toUTCString()}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <>
          <p className="max-w-2xl text-[13px] text-bone-dim">
            The schedule was deployed with no start. The scheduler{scheduler && scheduler !== "sample" && scheduler !== "someone else" ? ` (${String(scheduler).slice(0, 8)}…)` : ""} sets it exactly once — after that it's permanent. Pass sales and staking open with it.
          </p>
          <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label="Readiness checks">
            {checks.map((x) => (
              <li key={x.label} className="flex items-center gap-2 text-[12.5px]">
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${x.ok === true ? "bg-ok/15 text-ok" : x.ok === false ? "bg-bad/15 text-bad" : "bg-white/[0.06] text-ash"}`}>
                  {x.ok === true ? "✓" : x.ok === false ? "✕" : "…"}
                </span>
                <span className={x.ok === false ? "text-bone" : "text-bone-dim"}>{x.label}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[260px_1fr] md:items-end">
            <label className="flex flex-col gap-1 text-[12.5px]">
              <span className="text-ash">Start (your local time)</span>
              <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} className="well px-2 py-2 font-mono text-bone" aria-label="Genesis start" />
            </label>
            {future && (
              <div aria-hidden className="flex h-10 overflow-hidden rounded-lg border border-white/[0.06]">
                {Array.from({ length: GENESIS_DAYS }, (_, i) => (
                  <span key={i} className={`gs-seg flex flex-1 items-center justify-center border-r border-black/40 font-mono text-[10px] ${i + 1 >= LP_DAY ? "bg-ember/40 text-bone" : "bg-[#2a8cff]/40 text-bone"}`}>
                    D{i + 1}
                  </span>
                ))}
              </div>
            )}
          </div>
          {future && (
            <p className="mt-2 font-mono text-[11px] text-ash">
              sent as {startUnix} · {new Date(startUnix * 1000).toUTCString()} · LP opens {fmtLocal(lp)} · ends {fmtLocal(end)}
            </p>
          )}
          <button type="button" className="btn btn-primary mt-4 h-11 px-5" disabled={!!reason || actions.busy} onClick={confirm}>
            {p.sim ? "Schedule Genesis (simulated)" : "Confirm Genesis date in wallet"}
          </button>
          {reason && <Reason tone={failing?.ok === false ? "warn" : "ash"}>{reason}</Reason>}
        </>
      )}
    </section>
  );
}
