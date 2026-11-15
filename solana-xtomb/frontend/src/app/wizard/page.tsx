"use client";
import { useMemo, useState } from "react";
import { Card, Cta, Modal, SectionTitle, SimBadge, SimNote } from "@/components/ui";
import { config } from "@/lib/config";

const STEPS = ["Chain/Network", "Tokens & Supply", "Allocations & Vesting", "Passes & Fees", "Pools", "Genesis Schedule", "Review & Deploy"] as const;

type Form = {
  network: string; programId: string;
  xshareCap: string; genesisBudget: string; xtombLaunch: string;
  farmEmissions: string; vestingDays: string;
  genesisPrice: string; proPrice: string; ultraPrice: string; depositFee: string;
  pools: string; genesisDays: string; startDate: string;
};
const DEFAULTS: Form = {
  network: "devnet",
  programId: config.meta.program_id_devnet,
  xshareCap: String(config.tokens.xSHARE.cap),
  genesisBudget: String(config.xtomb_launch.genesis_reward_budget),
  xtombLaunch: String(config.xtomb_launch.total_launch),
  farmEmissions: String(config.farm.emissions_xshare_365d),
  vestingDays: String(config.xtomb_launch.vesting_days),
  genesisPrice: String(config.passes.Genesis.price_usdc),
  proPrice: String(config.passes.Pro.price_usdc),
  ultraPrice: String(config.passes.Ultra.price_usdc),
  depositFee: String(config.genesis.default_deposit_fee_percent),
  pools: "xTOMB·USDC LP, xSHARE·USDC LP",
  genesisDays: String(config.genesis.duration_days),
  startDate: "",
};

function isInt(s: string) { return /^\d+$/.test(s.trim()); }
function isAddr(s: string) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim()); }

export default function WizardPage() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>(DEFAULTS);
  const [errors, setErrors] = useState<string[]>([]);
  const [ackAudit, setAckAudit] = useState(false);
  const [ackChain, setAckChain] = useState(false);
  const [dryRun, setDryRun] = useState<null | string>(null);
  const [deployed, setDeployed] = useState(false);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const validate = (s: number): string[] => {
    const e: string[] = [];
    if (s === 0) {
      if (!["devnet", "mainnet-beta", "testnet"].includes(form.network.trim())) e.push("Network must be devnet, testnet, or mainnet-beta. This build only deploys to devnet.");
      if (form.network.trim() !== "devnet") e.push("Deploy target is devnet only in this build — mainnet is refused.");
      if (!isAddr(form.programId)) e.push("Program ID is not a valid Solana address (base58, 32–44 chars).");
    }
    if (s === 1) {
      if (!isInt(form.xshareCap) || parseInt(form.xshareCap) !== 33333) e.push("xSHARE cap must be exactly 33,333 — it is immutable at deploy.");
      if (!isInt(form.genesisBudget) || parseInt(form.genesisBudget) <= 0) e.push("Genesis reward budget must be a whole number above 0.");
      if (!isInt(form.xtombLaunch) || parseInt(form.xtombLaunch) <= 0) e.push("xTOMB launch allocation must be a whole number above 0.");
    }
    if (s === 2) {
      if (!isInt(form.farmEmissions) || parseInt(form.farmEmissions) !== 25641) e.push("Farm emissions must be exactly 25,641 xSHARE over 365 days.");
      if (!isInt(form.vestingDays) || parseInt(form.vestingDays) !== 180) e.push("Vesting must be 180 days, linear, non-revocable.");
    }
    if (s === 3) {
      if (!isInt(form.genesisPrice) || !isInt(form.proPrice) || !isInt(form.ultraPrice)) e.push("Pass prices must be whole USDC numbers.");
      if (parseInt(form.genesisPrice) !== 50 || parseInt(form.proPrice) !== 100 || parseInt(form.ultraPrice) !== 300) e.push("Pass prices are locked: Genesis $50 / Pro $100 / Ultra $300.");
      if (!isInt(form.depositFee)) e.push("Deposit fee must be a whole percent.");
    }
    if (s === 4) {
      if (!form.pools.trim()) e.push("At least one pool is required (e.g. xTOMB·USDC LP).");
    }
    if (s === 5) {
      if (!isInt(form.genesisDays) || parseInt(form.genesisDays) !== 7) e.push("Genesis duration is locked at 7 days.");
      if (!form.startDate.trim()) e.push("Genesis start date/time is required.");
    }
    return e;
  };

  const next = () => {
    const e = validate(step);
    setErrors(e);
    if (e.length === 0) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const gatesOk = ackAudit && ackChain;
  const runDry = () => {
    const all = STEPS.map((_, i) => validate(i)).flat();
    if (all.length) { setErrors(all); return; }
    setDryRun(`Dry run passed: ${form.network} · xSHARE cap ${form.xshareCap} · Genesis budget ${form.genesisBudget} xTOMB · passes $${form.genesisPrice}/$${form.proPrice}/$${form.ultraPrice} · pools: ${form.pools} · Genesis ${form.genesisDays} days from ${form.startDate || "(unset)"}. No transaction sent.`);
  };

  const field = (label: string, k: keyof Form, placeholder?: string) => (
    <label className="block">
      <span className="font-mono text-[10px] tracking-widest text-dust">{label}</span>
      <input value={form[k]} onChange={set(k)} placeholder={placeholder} className="mt-1 w-full rounded-lg border border-white/15 bg-panel2 px-3 py-2 font-mono text-sm outline-none focus:border-ember" />
    </label>
  );

  return (
    <div>
      <SectionTitle title="Launch Wizard" sub="Config-first. Whole numbers and percentages only — never lamports or bps. The wizard deploys; Admin maintains." />
      <div className="mb-4 flex gap-2"><SimBadge /><SimBadge label="DEVNET ONLY" /></div>
      <div className="mb-4 flex flex-wrap gap-1">
        {STEPS.map((s, i) => (
          <button key={s} onClick={() => setStep(i)} className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ${i === step ? "bg-ember text-white" : i < step ? "bg-mint/20 text-mint" : "bg-panel2 text-ash"}`}>
            {i + 1}. {s}
          </button>
        ))}
      </div>
      {errors.length > 0 && (
        <div className="mb-4 rounded-lg border border-rose/50 bg-rose/10 p-3">
          {errors.map((e) => (<p key={e} className="font-mono text-xs leading-relaxed text-rose">✕ {e}</p>))}
        </div>
      )}
      <Card>
        <h2 className="font-display text-base font-bold text-bone">Step {step + 1}: {STEPS[step]}</h2>
        <div className="mt-3 grid gap-3">
          {step === 0 && (<>{field("NETWORK", "network", "devnet")}{field("PROGRAM ID", "programId")}<p className="text-xs text-ash">Devnet only in this build. Program ID default: {config.meta.program_id_devnet} (fresh devnet-only program, not deployed yet).</p></>)}
          {step === 1 && (<>{field("xSHARE CAP (locked 33,333)", "xshareCap")}{field("GENESIS REWARD BUDGET (xTOMB)", "genesisBudget")}{field("xTOMB LAUNCH ALLOCATION", "xtombLaunch")}<p className="text-xs text-ash">Authorized launch supply beyond budget + allocations stays unset until Jess sets it.</p></>)}
          {step === 2 && (<>{field("FARM EMISSIONS xSHARE / 365d (locked 25,641)", "farmEmissions")}{field("VESTING DAYS (locked 180, linear)", "vestingDays")}<p className="text-xs text-ash">Vesting split: Team 2,500 / Developer 2,000 / Treasury 2,441 = 6,941. Arbitrage gets 0 xSHARE.</p></>)}
          {step === 3 && (<>{field("GENESIS PASS PRICE (USDC, locked 50)", "genesisPrice")}{field("PRO PASS PRICE (USDC, locked 100)", "proPrice")}{field("ULTRA PASS PRICE (USDC, locked 300)", "ultraPrice")}{field("DEFAULT DEPOSIT FEE %", "depositFee")}<p className="text-xs text-ash">Deposit fees by tier: Genesis 2% / Pro 1% / Ultra 0%. Upgrades pay only the difference.</p></>)}
          {step === 4 && (<>{field("POOLS (comma separated)", "pools", "xTOMB·USDC LP, xSHARE·USDC LP")}<p className="text-xs text-ash">Pools are also addable later from Admin. Farm migration terms are post-launch work.</p></>)}
          {step === 5 && (<>{field("GENESIS DURATION DAYS (locked 7)", "genesisDays")}{field("GENESIS START (date/time, UTC)", "startDate", "2026-11-…T…:…Z")}<p className="text-xs text-ash">Ultra pre-stake opens 24h before T. Day 2: LP staking opens, LP 75% / standard 25%.</p></>)}
          {step === 6 && (
            <div className="space-y-3">
              <div className="rounded-lg bg-panel2 p-3 font-mono text-xs leading-relaxed text-ash">
                <p>Network: {form.network} · Program: {form.programId}</p>
                <p>xSHARE cap {form.xshareCap} · Genesis budget {form.genesisBudget} xTOMB · launch {form.xtombLaunch}</p>
                <p>Farm {form.farmEmissions} / 365d · vesting {form.vestingDays}d linear</p>
                <p>Passes ${form.genesisPrice} / ${form.proPrice} / ${form.ultraPrice} USDC · deposit fee {form.depositFee}%</p>
                <p>Pools: {form.pools} · Genesis {form.genesisDays} days from {form.startDate || "(unset)"}</p>
              </div>
              <label className="flex items-start gap-2 text-sm text-ash">
                <input type="checkbox" checked={ackAudit} onChange={(e) => setAckAudit(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#ff6a2b]" />
                I acknowledge: there is NO independent audit of this program. Deploy gate — do not deploy to mainnet without one.
              </label>
              <label className="flex items-start gap-2 text-sm text-ash">
                <input type="checkbox" checked={ackChain} onChange={(e) => setAckChain(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#ff6a2b]" />
                I acknowledge: there is NO live-chain verification yet. Deploy gate — dry-run first, devnet only.
              </label>
              <div className="grid grid-cols-2 gap-2">
                <Cta tone="ghost" onClick={runDry}>Dry-run first</Cta>
                <Cta disabled={!gatesOk} onClick={() => setDeployed(true)}>
                  {gatesOk ? "Deploy to devnet" : "Deploy locked — acknowledge gates"}
                </Cta>
              </div>
              {dryRun && <p className="font-mono text-[11px] leading-relaxed text-mint">{dryRun}</p>}
              {deployed && <p className="font-mono text-[11px] leading-relaxed text-amberx">Deploy preview only: no program is deployed yet, so nothing was sent to devnet. Run the real deploy from the repo scripts once the program builds and the deploy wallet is funded.</p>}
            </div>
          )}
        </div>
        {step < 6 && (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Cta tone="ghost" onClick={() => setStep((s) => Math.max(s - 1, 0))}>Back</Cta>
            <Cta onClick={next}>Continue</Cta>
          </div>
        )}
      </Card>
      <div className="mt-4"><SimNote /></div>
    </div>
  );
}
