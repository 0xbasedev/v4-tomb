import { useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { erc20Abi, type Address } from "viem";

import { validateMasonryLaunch } from "@config/masonry-launch.mjs";
import { officialChain } from "@config/masonry-deployment.mjs";
import { ChainBadge } from "@/components/ChainBadge";
import { PageHeader } from "@/components/PageHeader";
import { Reason } from "@/components/Status";
import { bridgeInputGaps, emptyRelease, ReleaseStep, releaseJson, type ReleaseState } from "@/components/wizard/ReleaseStep";
import { BRIDGE_DOMAINS, loadRelease, ROLE_LABEL, type FullPlan } from "@/lib/create3";
import { LAUNCH, POLICY, REGISTRY } from "@/lib/launch";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Launch Wizard — owns everything decided before deploy:
 *   1 Chain       one listed in config/official-infrastructure.json (a Uniswap v4
 *                 PoolManager + Circle-issued USDC), confirmed on-chain on demand
 *   2 Allocations xSHARE (to the configured cap) and xTOMB launch funding,
 *                 validated by the same validateMasonryLaunch the deploy uses
 *   3 Pools       official pool keys, vault ranges, oracle and guard bounds,
 *                 Genesis start — the constructor-bound values
 *   4 Release     CREATE3: deployment signer + release ID → predicted addresses
 *                 for every Masonry component, the xSHARE bridge and Bridged xSHARE
 *   5 Review      fixed release invariants vs deployment-bound choices, then
 *                 export the plans. Deploying runs from the scripts, not here.
 */

type Step = 0 | 1 | 2 | 3 | 4;
const STEPS = ["Chain", "Allocations", "Pools", "Release", "Review"];
const LAST = (STEPS.length - 1) as Step;

const POLICY_LABEL: Record<string, string> = {
  fireTaxHardCapBps: "Fire Tax hard cap",
  fireTaxBaselineBps: "Fire Tax baseline",
  fullTaxAtOrBelowPegBps: "Full tax at or below (× reference)",
  fireTaxRecoverySeconds: "Fire Tax recovery",
  genesisDurationSeconds: "Genesis length",
  genesisLpOpenDelaySeconds: "LP pool opens after",
  genesisLevelSellMinimumBps: "Genesis xTOMB sell floor",
  genesisLevelSellBurnShareBps: "Genesis xTOMB tax burned",
  squareGenesisSellMinimumBps: "Genesis xSHARE sell floor",
  genesisNftRequired: "Pass required",
  genesisNftPriceUsdc: "Genesis pass (USDC)",
  genesisProNftPriceUsdc: "Pro pass (USDC)",
  genesisUltraNftPriceUsdc: "Ultra pass (USDC)",
  genesisUltraMultiplier: "Ultra reward weighting",
  genesisLiquidRewardBps: "Liquid share of rewards",
  genesisVestingInstallments: "Vesting installments",
  genesisVestingIntervalSeconds: "Installment interval",
  genesisWalletClaimFeeBps: "Wallet claim fee",
  genesisAutomationFeeBps: "Keeper fee",
  genesisLevelUsdcLpBurnFeeBps: "Genesis LP deposit fee (to the DAO wallet as POL)",
  genesisCompoundCooldownSeconds: "Genesis compound cooldown",
  genesisProKeeperIntervalSeconds: "Pro keeper interval",
  genesisUltraKeeperIntervalSeconds: "Ultra keeper interval",
  farmsCompoundCooldownSeconds: "Farm compound cooldown",
  farmEmissionDays: "Farm emissions",
  operationalVestingDays: "Operational vesting",
  maximumExpansionPerEpochBps: "Max expansion per epoch",
  epochAdvanceFeeUsd: "Advance-epoch fee (USD; USDC, USDG or ETH)",
  requiresFreshTwapStrictlyAbovePegBps: "Expansion gate (× peg)",
  squareTaxPolBps: "xSHARE tax → POL",
  squareTaxUsdcReserveBps: "xSHARE tax → USDC reserve",
  squareTaxSquareReserveBps: "xSHARE tax → xSHARE reserve",
  criticalDefenseEntryBps: "Critical Defense entry (× peg)",
  criticalDefenseExitBps: "Critical Defense exit (× peg)",
  criticalRecoveryEpochs: "Defense recovery checkpoints",
  epochSeconds: "Epoch",
  criticalOracleMaxAgeSeconds: "Defense oracle max age",
  governanceTimelocksEnabled: "Governance timelocks",
  ownerTradingPauseEnabled: "Owner trading pause",
};

function fmtPolicy(k: string, v: unknown): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v !== "number") return String(v);
  if (k.endsWith("Bps")) return k.includes("Peg") || k.includes("Defense") ? `${(v / 10_000).toFixed(2)}` : `${v / 100}%`;
  if (k.endsWith("Seconds")) return v >= 86_400 ? `${v / 86_400} days` : v >= 3_600 ? `${v / 3_600} h` : `${v / 60} min`;
  if (k.endsWith("Days")) return `${v} days`;
  return String(v);
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export function Wizard() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root, []);
  const [step, setStep] = useState<Step>(0);
  // Resume the plan saved in this browser, if any.
  const [saved] = useState(loadRelease);
  const [chainId, setChainId] = useState<number>(() => (saved && officialChain(REGISTRY, saved.canonicalDomain) ? saved.canonicalDomain : 84532));
  const [doc, setDoc] = useState(() => clone(LAUNCH));
  const [pools, setPools] = useState({
    genesisStart: "",
    scheduler: "",
    levelFee: 3000,
    squareFee: 3000,
    tickSpacing: 60,
    levelLower: -600,
    levelUpper: 600,
    squareLower: 47_400,
    squareUpper: 48_600,
    squareReferencePrice: "120",
    oracleMinLiquidity: "",
    spotBps: 200,
    impactBps: 300,
    lossBps: 300,
    maxSquarePerRoute: "",
    maxDeviationBps: 300,
  });

  const [release, setRelease] = useState<ReleaseState>(() =>
    saved
      ? {
          ...emptyRelease(),
          deployer: saved.deployer,
          releaseId: saved.releaseId,
          patterns: Object.fromEntries(Object.entries(saved.addressPatterns ?? {}).map(([k, v]) => [k, { prefix: v.prefix ?? "", suffix: v.suffix ?? "" }])),
        }
      : emptyRelease(),
  );
  const [plan, setPlan] = useState<FullPlan | null>(null);
  const importChain = (id: number) => {
    if (id === chainId) return null;
    if (!officialChain(REGISTRY, id)) return `Its home chain (${id}) isn't an official Uniswap v4 + USDC chain, so the current chain is kept.`;
    setChainId(id);
    return `Home chain set to ${officialChain(REGISTRY, id)!.name}.`;
  };
  const chain = officialChain(REGISTRY, chainId);
  const result = useMemo(() => {
    try {
      return { ok: true as const, summary: validateMasonryLaunch(doc) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [doc]);
  const poolIssues = poolProblems(pools);

  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Launch Wizard · owner tool"
        title="Plan a deployment"
        lede="Choose the chain, set allocations and pools, and review what's fixed versus chosen at deploy. The Wizard validates with the same schema the deploy scripts use and exports the plan; it never deploys."
      />
      <div className="mx-auto w-full max-w-5xl px-4 pb-12 md:px-8">
        <ol data-reveal className="mb-6 grid grid-cols-5 gap-1.5 sm:gap-2">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => setStep(i as Step)}
                aria-current={step === i ? "step" : undefined}
                className={`flex w-full min-w-0 flex-col items-start rounded-xl border px-2 py-2 text-left sm:px-3 ${step === i ? "border-ember/60 bg-ember/[0.07]" : "border-white/[0.07] hover:border-white/20"}`}
              >
                <span className="font-mono text-[10px] text-ash">
                  <span className="hidden sm:inline">Step </span>
                  {i + 1}
                </span>
                <span className="w-full truncate text-[11px] font-semibold text-bone sm:text-[13px]">{s}</span>
              </button>
            </li>
          ))}
        </ol>

        {step === 0 && <ChainStep chainId={chainId} setChainId={setChainId} />}
        {step === 1 && <AllocStep doc={doc} setDoc={setDoc} result={result} />}
        {step === 2 && <PoolsStep pools={pools} setPools={setPools} issues={poolIssues} />}
        {step === 3 && <ReleaseStep chainId={chainId} chainName={chain?.name ?? `chain ${chainId}`} release={release} setRelease={setRelease} plan={plan} setPlan={setPlan} onImportChain={importChain} />}
        {step === 4 && <ReviewStep chainName={chain?.name ?? `chain ${chainId}`} chainId={chainId} doc={doc} pools={pools} result={result} poolIssues={poolIssues} release={release} plan={plan} />}

        <div className="mt-6 flex justify-between">
          <button type="button" className="btn h-10 px-4" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1) as Step)}>
            Back
          </button>
          <button type="button" className="btn btn-primary h-10 px-5" disabled={step === LAST} onClick={() => setStep((s) => Math.min(LAST, s + 1) as Step)}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function ChainStep({ chainId, setChainId }: { chainId: number; setChainId: (n: number) => void }) {
  const chain = officialChain(REGISTRY, chainId)!;
  const client = usePublicClient({ chainId });
  const [checks, setChecks] = useState<{ pm: boolean | null; decimals: number | null; symbol: string | null; error: string | null } | null>(null);
  const [running, setRunning] = useState(false);
  async function run() {
    if (!client) return setChecks({ pm: null, decimals: null, symbol: null, error: "No RPC configured for this chain in the app." });
    setRunning(true);
    try {
      const [code, decimals, symbol] = await Promise.all([
        client.getCode({ address: chain.poolManager as Address }),
        client.readContract({ address: chain.usdc as Address, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address: chain.usdc as Address, abi: erc20Abi, functionName: "symbol" }),
      ]);
      setChecks({ pm: !!code && code !== "0x", decimals, symbol, error: null });
    } catch (e) {
      setChecks({ pm: null, decimals: null, symbol: null, error: (e as Error).message.split("\n")[0] });
    } finally {
      setRunning(false);
    }
  }
  const groups = [
    { name: "Testnets — rehearse here first", list: REGISTRY.chains.filter((c) => c.testnet) },
    { name: "Mainnets", list: REGISTRY.chains.filter((c) => !c.testnet) },
  ];
  return (
    <section data-reveal className="panel p-5 md:p-6">
      <h2 className="font-display text-lg font-semibold text-bone">1 · Chain</h2>
      <p className="mt-1 text-[13px] text-bone-dim">Only chains with an official Uniswap v4 PoolManager and Circle-issued USDC are offered. Anything else is rejected by the deployment schema.</p>
      {groups.map((g) => (
        <div key={g.name} className="mt-4">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ash-dim">{g.name}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {g.list.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => (setChainId(c.id), setChecks(null))}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left ${chainId === c.id ? "border-ember/60 bg-ember/[0.07]" : "border-white/[0.07] hover:border-white/20"}`}
              >
                <ChainBadge id={c.id} name={c.name} size={24} />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-bone">{c.name}</span>
                  <span className="block font-mono text-[10px] text-ash">
                    {c.id}
                    {BRIDGE_DOMAINS.includes(c.id) && <span className="ml-1.5 text-spectre">· bridge home</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <dl className="mt-5 grid grid-cols-1 gap-2 text-[12.5px] sm:grid-cols-2">
        <div className="rounded-xl bg-black/25 p-3">
          <dt className="label mb-1">Uniswap v4 PoolManager</dt>
          <dd className="break-all font-mono text-bone">{chain.poolManager}</dd>
          {checks && <dd className={`mt-1 ${checks.pm ? "text-ok" : "text-bad"}`}>{checks.pm ? "✓ contract code found" : checks.pm === false ? "✕ no code at this address" : "—"}</dd>}
        </div>
        <div className="rounded-xl bg-black/25 p-3">
          <dt className="label mb-1">Official USDC</dt>
          <dd className="break-all font-mono text-bone">{chain.usdc}</dd>
          {checks && (
            <dd className={`mt-1 ${checks.decimals === 6 && checks.symbol === "USDC" ? "text-ok" : "text-bad"}`}>
              {checks.decimals === null ? "—" : `${checks.decimals === 6 && checks.symbol === "USDC" ? "✓" : "✕"} ${checks.symbol} · ${checks.decimals} decimals`}
            </dd>
          )}
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn h-10 px-4 text-[13px]" disabled={running} onClick={run}>
          {running ? "Checking…" : "Run on-chain checks"}
        </button>
        <span className="text-[11.5px] text-ash">Read-only RPC calls: code at the PoolManager, USDC decimals and symbol. No wallet needed.</span>
      </div>
      {checks?.error && <Reason tone="warn">Couldn't reach the chain: {checks.error}</Reason>}
      {chain.id === 1 && <Reason tone="warn">Ethereum mainnet: rehearse the full launch on a testnet first.</Reason>}
      <Reason>
        This is the home chain for the release. The xSHARE bridge can only be planned when the home chain is one of its four networks (marked “bridge home”). Bridge support doesn't certify a chain for the Masonry launch.
      </Reason>
      <p className="mt-3 font-mono text-[10.5px] text-ash-dim">
        Sources: Uniswap v4 deployments and Circle USDC addresses, retrieved {REGISTRY.sources.retrieved}.
      </p>
    </section>
  );
}

type Doc = typeof LAUNCH;

function NumField({ label, value, onChange, hint }: { label: string; value: number | null; onChange: (n: number | null) => void; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-[12.5px]">
      <span className="text-ash">{label}</span>
      <input
        inputMode="numeric"
        value={value ?? ""}
        placeholder="unset"
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9]/g, "");
          onChange(t === "" ? null : Number(t));
        }}
        className={`well px-2 py-1.5 font-mono text-bone ${value === null ? "border-warn/40" : ""}`}
        aria-label={label}
      />
      {hint && <span className="text-[10.5px] text-ash-dim">{hint}</span>}
    </label>
  );
}

function AllocStep({ doc, setDoc, result }: { doc: Doc; setDoc: (d: Doc) => void; result: { ok: true; summary: { allocatedSquare: number; squareCap: number } } | { ok: false; error: string } }) {
  const set = (mut: (d: Doc) => void) => {
    const next = clone(doc);
    mut(next);
    setDoc(next);
  };
  const s = doc.square;
  const sum =
    s.farming + s.saleEscrow + s.deployer + s.initial.ownerTeamDeveloper + s.initial.deployerDao + s.initial.treasury + s.initial.arbitrage + Object.values(s.vesting).reduce((a: number, b) => a + ((b as number | null) ?? 0), 0);
  return (
    <section data-reveal className="panel p-5 md:p-6">
      <h2 className="font-display text-lg font-semibold text-bone">2 · Allocations</h2>
      <p className="mt-1 text-[13px] text-bone-dim">Whole tokens. xSHARE must reconcile exactly to the cap; xTOMB launch funding can't exceed the authorized launch supply.</p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <NumField label="xSHARE cap" value={s.maxSupply} onChange={(n) => set((d) => void (d.square.maxSupply = n ?? 0))} hint="configured; default 33,333" />
        <NumField label="Farming" value={s.farming} onChange={(n) => set((d) => void (d.square.farming = n ?? 0))} />
        <NumField label="Sale escrow" value={s.saleEscrow} onChange={(n) => set((d) => void (d.square.saleEscrow = n ?? 0))} />
        <NumField label="Deployer" value={s.deployer} onChange={(n) => set((d) => void (d.square.deployer = n ?? 0))} />
        <NumField label="Initial · owner/team/dev" value={s.initial.ownerTeamDeveloper} onChange={(n) => set((d) => void (d.square.initial.ownerTeamDeveloper = n ?? 0))} />
        <NumField label="Initial · Treasury" value={s.initial.treasury} onChange={(n) => set((d) => void (d.square.initial.treasury = n ?? 0))} />
        <NumField label="Initial · arbitrage" value={s.initial.arbitrage} onChange={(n) => set((d) => void (d.square.initial.arbitrage = n ?? 0))} />
        <NumField label="Initial · deployer/DAO outright" value={s.initial.deployerDao} onChange={(n) => set((d) => void (d.square.initial.deployerDao = n ?? 0))} hint="liquid, on top of Deployer" />
        {(["team", "developer", "treasury", "arbitrage"] as const).map((k) => (
          <NumField key={k} label={`Vesting · ${k}`} value={(s.vesting as Record<string, number | null>)[k]} onChange={(n) => set((d) => void ((d.square.vesting as Record<string, number | null>)[k] = n))} hint={`${POLICY.operationalVestingDays}-day linear`} />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between rounded-xl bg-black/25 px-3 py-2 text-[12.5px]">
        <span className="text-ash">Allocated</span>
        <span className={`num ${sum === s.maxSupply ? "text-ok" : "text-warn"}`}>
          {sum.toLocaleString()} / {s.maxSupply.toLocaleString()} xSHARE
        </span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <NumField label="xTOMB authorized launch supply" value={doc.level.authorizedLaunchSupply as number | null} onChange={(n) => set((d) => void ((d.level as { authorizedLaunchSupply: number | null }).authorizedLaunchSupply = n))} />
        <NumField label="xTOMB · owner/team/dev" value={doc.level.initial.ownerTeamDeveloper} onChange={(n) => set((d) => void (d.level.initial.ownerTeamDeveloper = n ?? 0))} />
        <NumField label="xTOMB · Treasury" value={doc.level.initial.treasury} onChange={(n) => set((d) => void (d.level.initial.treasury = n ?? 0))} />
        <NumField label="xTOMB · arbitrage" value={doc.level.initial.arbitrage} onChange={(n) => set((d) => void (d.level.initial.arbitrage = n ?? 0))} />
      </div>
      <div className={`mt-4 rounded-xl border p-3 text-[12.5px] ${result.ok ? "border-ok/30 bg-ok/[0.05] text-ok" : "border-warn/30 bg-warn/[0.05] text-warn"}`} role="status">
        {result.ok ? `✓ Reconciles: ${result.summary.allocatedSquare.toLocaleString()} of ${result.summary.squareCap.toLocaleString()} xSHARE allocated.` : `Blocked: ${result.error}`}
      </div>
    </section>
  );
}

type Pools = {
  genesisStart: string;
  scheduler: string;
  levelFee: number;
  squareFee: number;
  tickSpacing: number;
  levelLower: number;
  levelUpper: number;
  squareLower: number;
  squareUpper: number;
  squareReferencePrice: string;
  oracleMinLiquidity: string;
  spotBps: number;
  impactBps: number;
  lossBps: number;
  maxSquarePerRoute: string;
  maxDeviationBps: number;
};

function poolProblems(p: Pools): string[] {
  const out: string[] = [];
  // Blank start = deploy unscheduled (start 0); the scheduler sets it once, later, in Admin.
  if (p.genesisStart && new Date(p.genesisStart).getTime() <= Date.now()) out.push("Genesis start must be in the future, or blank to schedule later in Admin.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.scheduler) || BigInt(p.scheduler || "0x0") === 0n) out.push("Genesis scheduler must be a nonzero address (governance wallet or multisig).");
  for (const [k, v] of [
    ["xTOMB/USDC fee", p.levelFee],
    ["xSHARE/USDC fee", p.squareFee],
  ] as const)
    if (!(v >= 0 && v < 1_000_000)) out.push(`${k} must be a static fee below 1,000,000 pips.`);
  if (!(p.tickSpacing >= 1 && p.tickSpacing <= 32767)) out.push("Tick spacing must be 1–32,767.");
  for (const [k, lo, hi] of [
    ["xTOMB vault", p.levelLower, p.levelUpper],
    ["xSHARE vault", p.squareLower, p.squareUpper],
  ] as const) {
    if (lo >= hi) out.push(`${k}: lower tick must be below upper.`);
    if (lo % p.tickSpacing || hi % p.tickSpacing) out.push(`${k}: ticks must be multiples of the tick spacing.`);
  }
  for (const [k, v] of [
    ["Spot deviation", p.spotBps],
    ["Price impact", p.impactBps],
    ["Execution loss", p.lossBps],
  ] as const)
    if (!(v > 0 && v <= 500)) out.push(`${k} tolerance must be 1–500 bps (the guard caps each at 5%).`);
  if (!(parseFloat(p.squareReferencePrice) > 0)) out.push("xSHARE reference price must be positive.");
  if (!/^[1-9][0-9]*$/.test(p.oracleMinLiquidity)) out.push("Oracle minimum active liquidity is unset (calibrate on the target chain).");
  if (!/^[1-9][0-9]*$/.test(p.maxSquarePerRoute)) out.push("Max xSHARE per route is unset.");
  if (!(p.maxDeviationBps > 0 && p.maxDeviationBps <= 10_000)) out.push("Max route deviation must be 1–10,000 bps.");
  return out;
}

function PoolsStep({ pools, setPools, issues }: { pools: Pools; setPools: (p: Pools) => void; issues: string[] }) {
  const f = (k: keyof Pools) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setPools({ ...pools, [k]: typeof pools[k] === "number" ? Number(e.target.value.replace(/[^0-9-]/g, "")) || 0 : e.target.value });
  const field = (k: keyof Pools, label: string, hint?: string, type = "text") => (
    <label className="flex flex-col gap-1 text-[12.5px]">
      <span className="text-ash">{label}</span>
      <input type={type} value={pools[k] as string | number} onChange={f(k)} aria-label={label} className="well px-2 py-1.5 font-mono text-bone" />
      {hint && <span className="text-[10.5px] text-ash-dim">{hint}</span>}
    </label>
  );
  return (
    <section data-reveal className="panel p-5 md:p-6">
      <h2 className="font-display text-lg font-semibold text-bone">3 · Pools and bounds</h2>
      <p className="mt-1 text-[13px] text-bone-dim">These are constructor arguments — fixed once deployed. Hook addresses are mined in the release plan (next step) for their permission bits.</p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        {field("genesisStart", "Genesis start (optional)", "blank = deploy unscheduled; set it once later in Admin", "datetime-local")}
        {field("scheduler", "Genesis scheduler", "governance wallet or multisig — the only account that can set the start later")}
        {field("levelFee", "xTOMB/USDC LP fee (pips)", "static fee; 3000 = 0.30%")}
        {field("squareFee", "xSHARE/USDC LP fee (pips)")}
        {field("tickSpacing", "Tick spacing")}
        {field("levelLower", "xTOMB vault lower tick")}
        {field("levelUpper", "xTOMB vault upper tick")}
        {field("squareLower", "xSHARE vault lower tick")}
        {field("squareUpper", "xSHARE vault upper tick")}
        {field("squareReferencePrice", "xSHARE reference price (USDC)", "the xSHARE Fire Tax curve's reference")}
        {field("oracleMinLiquidity", "Oracle minimum active liquidity", "calibrate on the target chain")}
        {field("spotBps", "Guard: spot deviation (bps)", "≤ 500")}
        {field("impactBps", "Guard: price impact (bps)", "≤ 500")}
        {field("lossBps", "Guard: execution loss (bps)", "≤ 500")}
        {field("maxSquarePerRoute", "Max xSHARE per route", "caps each routed sale")}
        {field("maxDeviationBps", "Max route deviation (bps)")}
      </div>
      {issues.length > 0 && (
        <ul className="mt-3 space-y-1 text-[12px] text-warn" role="status">
          {issues.map((x) => (
            <li key={x}>• {x}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewStep({
  chainName,
  chainId,
  doc,
  pools,
  result,
  poolIssues,
  release,
  plan,
}: {
  chainName: string;
  chainId: number;
  doc: Doc;
  pools: Pools;
  result: { ok: boolean; error?: string };
  poolIssues: string[];
  release: ReleaseState;
  plan: FullPlan | null;
}) {
  const ready = result.ok && poolIssues.length === 0;
  const gaps = bridgeInputGaps(release, chainId);
  function downloadRelease() {
    const blob = new Blob([JSON.stringify(releaseJson(release, chainId), null, 2) + "\n"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "release.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function download() {
    // genesisStart goes out as unix seconds; 0 deploys the schedule unscheduled.
    const genesisStart = pools.genesisStart ? Math.floor(new Date(pools.genesisStart).getTime() / 1000) : 0;
    const out = { chainId, chain: chainName, launch: doc, deploymentBound: { ...pools, genesisStart }, predicted: plan, generatedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `xtomb-launch-plan-${chainId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  return (
    <section data-reveal className="space-y-5">
      <div className="panel p-5 md:p-6">
        <h2 className="font-display text-lg font-semibold text-bone">5 · Review</h2>
        <div className={`mt-3 rounded-xl border p-3 text-[13px] ${ready ? "border-ok/30 bg-ok/[0.05] text-ok" : "border-warn/30 bg-warn/[0.05] text-warn"}`} role="status">
          {ready ? `✓ Ready to export for ${chainName}.` : `Not ready: ${[!result.ok ? result.error : null, ...poolIssues].filter(Boolean).join(" ")}`}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary h-11 px-5" disabled={!ready} onClick={download}>
            Export launch plan (JSON)
          </button>
          <button type="button" className="btn h-11 px-5" disabled={!plan} onClick={downloadRelease}>
            Export release.json
          </button>
        </div>
        {!plan && <Reason>Set the deployment signer and release ID in step 4 to export the release plan.</Reason>}
        {plan && gaps.length > 0 && <Reason tone="warn">The release exports without complete bridge inputs; the bridge planner will ask for {gaps.join("; ")}.</Reason>}
        <Reason>Deployment runs from the deploy scripts with this plan; the Wizard never sends a transaction.</Reason>
      </div>
      <div className="panel p-5 md:p-6">
        <div className="mb-3 flex items-center gap-2">
          <span className="label">Fixed</span>
          <span className="text-[12px] text-ash">release invariants — the validator rejects any other value</span>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
          {Object.entries(POLICY).map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] py-1">
              <dt className="text-bone-dim">{POLICY_LABEL[k] ?? k}</dt>
              <dd className="num text-bone">{fmtPolicy(k, v)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="panel p-5 md:p-6">
        <div className="mb-3 flex items-center gap-2">
          <span className="label">Deployment-bound</span>
          <span className="text-[12px] text-ash">chosen now, immutable after deploy</span>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
          {[
            ["Chain", `${chainName} (${chainId})`],
            ["Genesis start", pools.genesisStart ? new Date(pools.genesisStart).toUTCString() : "unscheduled — set once in Admin"],
            ["xTOMB/USDC fee · spacing", `${pools.levelFee} pips · ${pools.tickSpacing}`],
            ["xSHARE/USDC fee", `${pools.squareFee} pips`],
            ["xTOMB vault range", `${pools.levelLower} → ${pools.levelUpper}`],
            ["xSHARE vault range", `${pools.squareLower} → ${pools.squareUpper}`],
            ["xSHARE reference price", `${pools.squareReferencePrice} USDC`],
            ["Oracle min liquidity", pools.oracleMinLiquidity || "unset"],
            ["Guard tolerances", `${pools.spotBps} / ${pools.impactBps} / ${pools.lossBps} bps`],
            ["Max xSHARE per route", pools.maxSquarePerRoute || "unset"],
            ["Release ID", release.releaseId ? `${release.releaseId.slice(0, 10)}…${release.releaseId.slice(-6)}` : "unset"],
            ["Deployment signer", release.deployer || "unset"],
            [ROLE_LABEL.masonryTaxHook, plan ? `${plan.masonry.addresses.masonryTaxHook.slice(0, 8)}… · nonce ${plan.masonry.hookNonces.masonryTaxHook}` : "predicted in step 4"],
            [ROLE_LABEL.masonryShareTaxHook, plan ? `${plan.masonry.addresses.masonryShareTaxHook.slice(0, 8)}… · nonce ${plan.masonry.hookNonces.masonryShareTaxHook}` : "predicted in step 4"],
            ["Custom address patterns", plan ? String(Object.keys(plan.masonry.patterns).length) : "—"],
            ["Genesis scheduler", pools.scheduler || "unset"],
            ["Treasury, fee recipient, binders", "set at deploy"],
          ].map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] py-1">
              <dt className="text-bone-dim">{k}</dt>
              <dd className="num text-right text-bone">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
