import { useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useReadContracts } from "wagmi";
import { isAddress, zeroAddress, type Abi, type Address } from "viem";

import { masonryContractKeys, masonryContractLabels, type MasonryContractKey } from "@config/masonry-deployment.mjs";
import { GenesisSchedulePanel } from "@/components/admin/GenesisSchedulePanel";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { Reason, SimBadge } from "@/components/Status";
import {
  masonryBuybackGuardAbi,
  masonryCriticalDefenseAbi,
  masonryGenesisLPBurnFeeAbi,
  masonryGenesisScheduleAbi,
  masonryGenesisSettlementAbi,
  masonryGenesisStakingAbi,
  masonryLevelHookAbi,
  masonryLevelOracleAbi,
  masonrySquareHookAbi,
} from "@/lib/abis/masonry";
import { useActions, useIsAdmin, useProtocol, type AdminRole } from "@/lib/hooks";
import { LAUNCH, POLICY } from "@/lib/launch";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Admin — for role holders only (lpBurnFee owner, settlement binder, xSHARE
 * hook POL binder). It shows what's deployed and offers only the writes the
 * connected contracts support for the connected wallet's role, each with the
 * reason it's disabled. Values are labelled Fixed (contract constants),
 * Deployment-bound (constructor immutables), Settable (owner setters) or Set
 * once (Genesis start, by the schedule's immutable scheduler).
 * There is no timelock, tax switch, forced epoch or Genesis registration:
 * the xTOMB contracts don't have them.
 */

type Kind = "Fixed" | "Deployment-bound" | "Settable" | "Set once" | "State";
interface Item {
  label: string;
  kind: Kind;
  contract: MasonryContractKey;
  abi: Abi;
  fn: string;
  /** Expected value from the launch config, shown in Preview and compared live. */
  expect?: string;
  fmt?: (v: unknown) => string;
}

const bps = (v: unknown) => `${Number(v) / 100}%`;
const secs = (v: unknown) => {
  const n = Number(v);
  return n >= 86_400 ? `${n / 86_400} d` : n >= 3_600 ? `${n / 3_600} h` : `${n / 60} min`;
};
const price18 = (v: unknown) => `$${(Number(v) / 1e18).toFixed(2)}`;
const addr = (v: unknown) => (typeof v === "string" ? `${v.slice(0, 8)}…${v.slice(-6)}` : "—");
const big18 = (v: unknown) => (typeof v === "bigint" ? (Number(v) / 1e18).toLocaleString() : String(v));

const ITEMS: Item[] = [
  { label: "Genesis length", kind: "Fixed", contract: "schedule", abi: masonryGenesisScheduleAbi as Abi, fn: "DURATION", expect: secs(POLICY.genesisDurationSeconds), fmt: secs },
  { label: "LP pool opens after", kind: "Fixed", contract: "schedule", abi: masonryGenesisScheduleAbi as Abi, fn: "LP_DELAY", expect: secs(POLICY.genesisLpOpenDelaySeconds), fmt: secs },
  { label: "Genesis scheduler", kind: "Deployment-bound", contract: "schedule", abi: masonryGenesisScheduleAbi as Abi, fn: "scheduler", fmt: addr },
  { label: "Genesis start", kind: "Set once", contract: "schedule", abi: masonryGenesisScheduleAbi as Abi, fn: "start", fmt: (v) => (Number(v) === 0 ? "unscheduled (0)" : new Date(Number(v) * 1000).toUTCString()) },
  { label: "xTOMB sell tax cap", kind: "Fixed", contract: "levelHook", abi: masonryLevelHookAbi as Abi, fn: "MAX_TAX_BPS", expect: bps(POLICY.fireTaxHardCapBps), fmt: bps },
  { label: "xTOMB Genesis floor", kind: "Fixed", contract: "levelHook", abi: masonryLevelHookAbi as Abi, fn: "GENESIS_MIN_TAX_BPS", expect: bps(POLICY.genesisLevelSellMinimumBps), fmt: bps },
  { label: "xTOMB tax recipient", kind: "Deployment-bound", contract: "levelHook", abi: masonryLevelHookAbi as Abi, fn: "taxRecipient", fmt: addr },
  { label: "xSHARE sell tax cap", kind: "Fixed", contract: "squareHook", abi: masonrySquareHookAbi as Abi, fn: "MAX_TAX_BPS", expect: bps(POLICY.fireTaxHardCapBps), fmt: bps },
  { label: "xSHARE Genesis floor", kind: "Fixed", contract: "squareHook", abi: masonrySquareHookAbi as Abi, fn: "BOOTSTRAP_TAX_BPS", expect: bps(POLICY.squareGenesisSellMinimumBps), fmt: bps },
  { label: "xSHARE reference price", kind: "Deployment-bound", contract: "squareHook", abi: masonrySquareHookAbi as Abi, fn: "squareReferencePrice", fmt: price18 },
  { label: "Max xSHARE per route", kind: "Deployment-bound", contract: "squareHook", abi: masonrySquareHookAbi as Abi, fn: "maxSquarePerRoute", fmt: big18 },
  { label: "Max route deviation", kind: "Deployment-bound", contract: "squareHook", abi: masonrySquareHookAbi as Abi, fn: "maxDeviationBps", fmt: bps },
  { label: "xSHARE POL vault", kind: "State", contract: "squareHook", abi: masonrySquareHookAbi as Abi, fn: "polVault", fmt: addr },
  { label: "Compound cooldown", kind: "Fixed", contract: "staking", abi: masonryGenesisStakingAbi as Abi, fn: "COMPOUND_COOLDOWN", expect: secs(POLICY.genesisCompoundCooldownSeconds), fmt: secs },
  { label: "Ultra early access", kind: "Fixed", contract: "staking", abi: masonryGenesisStakingAbi as Abi, fn: "ULTRA_EARLY_ACCESS", expect: "1 d", fmt: secs },
  { label: "Reward budget", kind: "Deployment-bound", contract: "staking", abi: masonryGenesisStakingAbi as Abi, fn: "rewardBudget", fmt: big18 },
  { label: "Funded", kind: "State", contract: "staking", abi: masonryGenesisStakingAbi as Abi, fn: "funded", fmt: (v) => (v ? "yes" : "no") },
  { label: "Vesting installments", kind: "Fixed", contract: "settlement", abi: masonryGenesisSettlementAbi as Abi, fn: "INSTALLMENTS", expect: String(POLICY.genesisVestingInstallments), fmt: String },
  { label: "Installment interval", kind: "Fixed", contract: "settlement", abi: masonryGenesisSettlementAbi as Abi, fn: "RELEASE_INTERVAL", expect: secs(POLICY.genesisVestingIntervalSeconds), fmt: secs },
  { label: "Wallet claim fee", kind: "Fixed", contract: "settlement", abi: masonryGenesisSettlementAbi as Abi, fn: "WALLET_FEE_BPS", expect: bps(POLICY.genesisWalletClaimFeeBps), fmt: bps },
  { label: "Keeper fee", kind: "Fixed", contract: "settlement", abi: masonryGenesisSettlementAbi as Abi, fn: "AUTOMATION_FEE_BPS", expect: bps(POLICY.genesisAutomationFeeBps), fmt: bps },
  { label: "Max compound refund", kind: "Fixed", contract: "settlement", abi: masonryGenesisSettlementAbi as Abi, fn: "MAX_REFUND_BPS", expect: "3%", fmt: bps },
  { label: "Bound staking", kind: "State", contract: "settlement", abi: masonryGenesisSettlementAbi as Abi, fn: "staking", fmt: addr },
  { label: "LP burn fee", kind: "Fixed", contract: "lpBurnFee", abi: masonryGenesisLPBurnFeeAbi as Abi, fn: "DEPOSIT_BURN_FEE_BPS", expect: bps(POLICY.genesisLevelUsdcLpBurnFeeBps), fmt: bps },
  { label: "Max fee shares / call", kind: "Settable", contract: "lpBurnFee", abi: masonryGenesisLPBurnFeeAbi as Abi, fn: "maxFeeSharesPerCall", expect: LAUNCH.genesisBurnExecution.maxFeeSharesPerCallBaseUnits, fmt: String },
  { label: "Max USDC / call", kind: "Settable", contract: "lpBurnFee", abi: masonryGenesisLPBurnFeeAbi as Abi, fn: "maxUsdcPerCall", expect: LAUNCH.genesisBurnExecution.maxUsdcPerCallBaseUnits, fmt: String },
  { label: "Authorized Genesis caller", kind: "Settable", contract: "lpBurnFee", abi: masonryGenesisLPBurnFeeAbi as Abi, fn: "genesis", fmt: addr },
  { label: "Defense entry", kind: "Fixed", contract: "criticalDefense", abi: masonryCriticalDefenseAbi as Abi, fn: "ENTER_PRICE", expect: `$${(POLICY.criticalDefenseEntryBps / 10_000).toFixed(2)}`, fmt: price18 },
  { label: "Defense exit", kind: "Fixed", contract: "criticalDefense", abi: masonryCriticalDefenseAbi as Abi, fn: "EXIT_PRICE", expect: `$${(POLICY.criticalDefenseExitBps / 10_000).toFixed(2)}`, fmt: price18 },
  { label: "Defense oracle max age", kind: "Fixed", contract: "criticalDefense", abi: masonryCriticalDefenseAbi as Abi, fn: "MAX_ORACLE_AGE", expect: secs(POLICY.criticalOracleMaxAgeSeconds), fmt: secs },
  { label: "TWAP window", kind: "Fixed", contract: "levelOracle", abi: masonryLevelOracleAbi as Abi, fn: "WINDOW", fmt: secs },
  { label: "Oracle min liquidity", kind: "Deployment-bound", contract: "levelOracle", abi: masonryLevelOracleAbi as Abi, fn: "minLiquidity", fmt: String },
  { label: "Guard spot tolerance", kind: "Deployment-bound", contract: "buybackGuard", abi: masonryBuybackGuardAbi as Abi, fn: "maxSpotDeviationBps", fmt: bps },
  { label: "Guard impact tolerance", kind: "Deployment-bound", contract: "buybackGuard", abi: masonryBuybackGuardAbi as Abi, fn: "maxPriceImpactBps", fmt: bps },
  { label: "Guard loss tolerance", kind: "Deployment-bound", contract: "buybackGuard", abi: masonryBuybackGuardAbi as Abi, fn: "maxExecutionLossBps", fmt: bps },
];

export function Admin() {
  const root = useRef<HTMLDivElement>(null);
  const admin = useIsAdmin();
  const p = useProtocol();
  useReveal(root, []);
  const d = p.net.deployment;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: d ? ITEMS.map((i) => ({ address: d.contracts[i.contract], abi: i.abi, functionName: i.fn })) : [],
    query: { enabled: !!d },
  });
  if (!admin.isAdmin) return <Navigate to="/dashboard" replace />;

  const value = (i: number): string => {
    if (!d) return ITEMS[i].expect ?? "set at deploy";
    const r = reads.data?.[i];
    return r?.status === "success" ? (ITEMS[i].fmt ?? String)(r.result) : "—";
  };
  const state = (fn: string) => {
    const i = ITEMS.findIndex((x) => x.fn === fn);
    return d ? reads.data?.[i]?.result : undefined;
  };

  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Admin · role holders only"
        title="Deployment"
        lede="What's deployed, what's fixed, and the few changes these contracts allow — each one gated by the role that can make it."
        aside={
          <div className="panel p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Your roles</span>
              {p.sim && <SimBadge label="Simulated owner" />}
            </div>
            <ul className="space-y-1 font-mono text-[12px] text-bone-dim">
              {(["lpBurnFee.owner", "settlement.binder", "squareHook.polBinder", "schedule.scheduler"] as AdminRole[]).map((r) => (
                <li key={r} className="flex justify-between gap-2">
                  <span>{r}</span>
                  <span className={admin.roles.includes(r) ? "text-ok" : "text-ash"}>{admin.roles.includes(r) ? "you" : admin.holders[r] ? addr(admin.holders[r]) : "—"}</span>
                </li>
              ))}
            </ul>
          </div>
        }
      />
      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-12 md:px-8">
        {!d && (
          <div data-reveal className="rounded-xl border border-warn/30 bg-warn/[0.05] p-4 text-[13px] text-bone-dim">
            No verified deployment on this network. Values below are the launch configuration's expected values; addresses appear once{" "}
            <span className="font-mono">config/masonry-deployments.json</span> lists a validated deployment. Plan one in the{" "}
            <Link to="/wizard" className="text-ember-hot hover:underline">
              Wizard
            </Link>
            .
          </div>
        )}

        <section>
          <SectionTitle kicker="Bound values" title={d ? "Deployed values" : "Expected values"} />
          <div data-reveal className="panel overflow-x-auto p-0">
            <table className="w-full min-w-[620px] text-[12.5px]">
              <thead>
                <tr className="border-b border-white/5 text-left text-ash">
                  <th className="px-4 py-2 font-medium">Value</th>
                  <th className="px-4 py-2 font-medium">Contract</th>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 text-right font-medium">{d ? "On-chain" : "Expected"}</th>
                </tr>
              </thead>
              <tbody>
                {ITEMS.map((it, i) => {
                  const v = value(i);
                  const mismatch = d && it.expect && v !== "—" && v !== it.expect;
                  return (
                    <tr key={it.label} className="border-b border-white/[0.04]">
                      <td className="px-4 py-2 text-bone">{it.label}</td>
                      <td className="px-4 py-2 font-mono text-[11px] text-ash">
                        {it.contract}.{it.fn}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`chip h-5 px-2 text-[10px] ${it.kind === "Fixed" ? "" : it.kind === "Settable" || it.kind === "Set once" ? "chip-ember" : it.kind === "State" ? "chip-spectre" : "chip-amethyst"}`}>{it.kind}</span>
                      </td>
                      <td className={`num px-4 py-2 text-right ${mismatch ? "text-bad" : "text-bone"}`}>
                        {v}
                        {mismatch && <span className="block text-[10.5px]">config says {it.expect}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <GenesisSchedulePanel />

        <AdminActions roles={admin.roles} state={state} />

        <section>
          <SectionTitle kicker="Addresses" title="Contracts" />
          <div data-reveal className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {masonryContractKeys.map((k) => (
              <div key={k} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2">
                <span className="text-[12.5px] text-bone-dim">{masonryContractLabels[k]}</span>
                <span className="font-mono text-[11px] text-ash">{d ? addr(d.contracts[k]) : "not deployed"}</span>
              </div>
            ))}
          </div>
        </section>

        <section data-reveal className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="panel p-5">
            <div className="label mb-2">Release plan · CREATE3</div>
            <p className="text-[13px] leading-relaxed text-bone-dim">
              Every project address is predicted from the deployment signer and release ID before deploy, and the deploy scripts check each one before broadcasting. Plan or review it in the{" "}
              <Link to="/wizard" className="text-ember-hot hover:underline">
                Wizard's release step
              </Link>
              .
            </p>
          </div>
          <div className="panel p-5">
            <div className="label mb-2">Compound gate · not bound</div>
            <p className="text-[13px] leading-relaxed text-bone-dim">
              MasonryCompoundGate holds the hard-coded 3-hour clock shared by manual and keeper compounds, with an owner-set executor list. Its Genesis and Farm adapters aren't wired yet, so it has no deployment entry and{" "}
              <span className="font-mono">setExecutor</span> isn't offered here.
            </p>
          </div>
        </section>

        <section data-reveal className="panel p-5">
          <div className="label mb-2">Not offered</div>
          <p className="text-[13px] leading-relaxed text-bone-dim">
            No governance timelock, no Fire Tax on/off switch, no forced epoch, no owner trading pause and no Genesis pool registration — the xTOMB contracts
            don't have them (governance timelocks and the trading pause are disabled in the release invariants).
          </p>
        </section>
      </div>
    </div>
  );
}

function AdminActions({ roles, state }: { roles: AdminRole[]; state: (fn: string) => unknown }) {
  const p = useProtocol();
  const actions = useActions();
  const d = p.net.deployment;
  const [limits, setLimits] = useState({ shares: LAUNCH.genesisBurnExecution.maxFeeSharesPerCallBaseUnits, usdc: LAUNCH.genesisBurnExecution.maxUsdcPerCallBaseUnits });
  const [genesisCaller, setGenesisCaller] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [bindStaking, setBindStaking] = useState("");
  const [polVault, setPolVault] = useState("");
  const owner = roles.includes("lpBurnFee.owner");
  const binder = roles.includes("settlement.binder");
  const polBinder = roles.includes("squareHook.polBinder");
  const bound = d ? state("staking") !== undefined && state("staking") !== zeroAddress : false;
  const polBound = d ? state("polVault") !== undefined && state("polVault") !== zeroAddress : false;
  const funded = d ? state("funded") === true : false;
  const started = p.clock ? p.clock.phase !== "pre" : false;
  const c = d?.contracts;
  const send = (label: string, contract: MasonryContractKey, abi: Abi, fn: string, args: readonly unknown[]) =>
    actions.admin(label, (c?.[contract] ?? zeroAddress) as Address, abi, fn, args);

  const rows: { title: string; who: string; body: React.ReactNode; disabled: string | null; run: () => void }[] = [
    {
      title: "Set LP burn execution limits",
      who: "lpBurnFee owner",
      body: (
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="Max fee shares per call" value={limits.shares} onChange={(e) => setLimits({ ...limits, shares: e.target.value.replace(/\D/g, "") })} className="well px-2 py-1.5 font-mono text-[12px] text-bone" />
          <input aria-label="Max USDC per call" value={limits.usdc} onChange={(e) => setLimits({ ...limits, usdc: e.target.value.replace(/\D/g, "") })} className="well px-2 py-1.5 font-mono text-[12px] text-bone" />
        </div>
      ),
      disabled: !owner ? "Only the LP burn fee owner can change execution limits." : !/^[1-9]\d*$/.test(limits.shares) || !/^[1-9]\d*$/.test(limits.usdc) ? "Both limits must be positive base-unit integers." : null,
      run: () => send("Set LP burn execution limits", "lpBurnFee", masonryGenesisLPBurnFeeAbi as Abi, "setExecutionLimits", [BigInt(limits.shares), BigInt(limits.usdc)]),
    },
    {
      title: "Set the authorized Genesis caller",
      who: "lpBurnFee owner",
      body: <input aria-label="Genesis staking address" placeholder="0x… staking contract" value={genesisCaller} onChange={(e) => setGenesisCaller(e.target.value.trim())} className="well w-full px-2 py-1.5 font-mono text-[12px] text-bone" />,
      disabled: !owner ? "Only the LP burn fee owner can change the Genesis caller." : !isAddress(genesisCaller) ? "Enter the Genesis staking address." : null,
      run: () => send("Set Genesis caller", "lpBurnFee", masonryGenesisLPBurnFeeAbi as Abi, "setGenesis", [genesisCaller]),
    },
    {
      title: "Transfer LP burn fee ownership",
      who: "lpBurnFee owner",
      body: <input aria-label="New owner" placeholder="0x… new owner" value={newOwner} onChange={(e) => setNewOwner(e.target.value.trim())} className="well w-full px-2 py-1.5 font-mono text-[12px] text-bone" />,
      disabled: !owner ? "Only the current owner can transfer ownership." : !isAddress(newOwner) ? "Enter the new owner's address." : null,
      run: () => send("Transfer ownership", "lpBurnFee", masonryGenesisLPBurnFeeAbi as Abi, "transferOwnership", [newOwner]),
    },
    {
      title: "Bind settlement to staking",
      who: "settlement binder · once",
      body: <input aria-label="Staking address to bind" placeholder="0x… staking" value={bindStaking} onChange={(e) => setBindStaking(e.target.value.trim())} className="well w-full px-2 py-1.5 font-mono text-[12px] text-bone" />,
      disabled: !binder ? "Only the settlement binder can bind." : bound ? "Already bound — binding happens once." : !isAddress(bindStaking) ? "Enter the staking address." : null,
      run: () => send("Bind settlement", "settlement", masonryGenesisSettlementAbi as Abi, "bind", [bindStaking]),
    },
    {
      title: "Bind the xSHARE POL vault",
      who: "xSHARE hook POL binder · once",
      body: <input aria-label="POL vault address" placeholder="0x… xSHARE/USDC vault" value={polVault} onChange={(e) => setPolVault(e.target.value.trim())} className="well w-full px-2 py-1.5 font-mono text-[12px] text-bone" />,
      disabled: !polBinder ? "Only the POL binder can bind the vault." : polBound ? "Already bound — binding happens once." : !isAddress(polVault) ? "Enter the vault address." : null,
      run: () => send("Bind POL vault", "squareHook", masonrySquareHookAbi as Abi, "bindPolVault", [polVault]),
    },
    {
      title: "Fund the Genesis reward budget",
      who: "anyone holding the budget · before start",
      body: <p className="text-[12px] text-ash">Transfers the full reward budget of xTOMB into staking. Approve the staking contract for that amount first.</p>,
      disabled: funded ? "Already funded." : started ? "Funding is only possible before Genesis starts." : null,
      run: () => send("Fund Genesis", "staking", masonryGenesisStakingAbi as Abi, "fund", []),
    },
    {
      title: "Sync Critical Defense",
      who: "anyone",
      body: <p className="text-[12px] text-ash">Applies the latest fresh TWAP to the defense state machine. Stale readings change nothing.</p>,
      disabled: null,
      run: () => send("Sync Critical Defense", "criticalDefense", masonryCriticalDefenseAbi as Abi, "sync", []),
    },
    {
      title: "Checkpoint the xTOMB oracle",
      who: "anyone",
      body: <p className="text-[12px] text-ash">Records an observation without counting as a price-moving swap.</p>,
      disabled: null,
      run: () => send("Checkpoint oracle", "levelHook", masonryLevelHookAbi as Abi, "checkpoint", []),
    },
  ];

  return (
    <section>
      <SectionTitle kicker="Supported changes" title="Actions" right={p.sim ? <SimBadge label="Simulated" /> : undefined} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows.map((r) => (
          <div key={r.title} data-reveal className="panel p-4">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[14px] font-semibold text-bone">{r.title}</span>
              <span className="font-mono text-[10.5px] text-ash">{r.who}</span>
            </div>
            {r.body}
            <button type="button" className="btn mt-3 h-9 px-4 text-[12.5px]" disabled={!!r.disabled || actions.busy || (!p.sim && !p.net.canTransact)} onClick={r.run}>
              {p.sim ? "Simulate" : "Send"}
            </button>
            {(r.disabled || (!p.sim && !p.net.canTransact)) && <Reason>{r.disabled ?? p.net.reason}</Reason>}
          </div>
        ))}
      </div>
    </section>
  );
}
