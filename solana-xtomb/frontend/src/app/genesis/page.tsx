"use client";
import { useEffect, useState } from "react";
import { Card, Cta, Modal, SectionTitle, SimBadge, SimNote, TokenPicker, ZapPanel } from "@/components/ui";
import { config, type TokenSymbol } from "@/lib/config";

type Pass = "Genesis" | "Pro" | "Ultra";
const PASSES: Pass[] = ["Genesis", "Pro", "Ultra"];

function Cooldown({ label }: { label: string }) {
  const [left, setLeft] = useState(3 * 3600);
  useEffect(() => {
    const t = setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  return (
    <p className="font-mono text-xs text-amberx">
      {label} cooldown: {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")} (3h shared cap)
    </p>
  );
}

export default function GenesisPage() {
  const [buyPass, setBuyPass] = useState<Pass | null>(null);
  const [upgrade, setUpgrade] = useState(false);
  const [flow, setFlow] = useState<"stake" | "claim" | "compound" | null>(null);
  const [asset, setAsset] = useState<TokenSymbol>("USDC");
  const [amount, setAmount] = useState("");
  const [ultraStaked, setUltraStaked] = useState(false);
  const g = config.genesis;
  const vest = Array.from({ length: g.vesting_installments }, (_, i) => ({
    n: i + 1, claimed: false, opensAt: `Genesis end + ${(i + 1) * g.vesting_installment_hours}h`,
  }));

  return (
    <div>
      <SectionTitle title="Genesis" sub={`${g.duration_days} days · ${g.reward_split_liquid_percent}/${g.reward_split_vested_percent} liquid/vested · ${g.vesting_installments} vesting installments of ${g.vesting_installment_hours}h`} />
      <div className="mb-4 flex flex-wrap gap-2"><SimBadge /><SimBadge label="DEVNET" /></div>

      <h2 className="mb-2 font-display text-base font-bold text-bone">Passes — soulbound, one per wallet</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {PASSES.map((p) => {
          const cfg = config.passes[p];
          return (
            <Card key={p}>
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-bold text-bone">{p}</h3>
                <span className="font-mono text-[10px] text-dust">soulbound</span>
              </div>
              <p className="mt-2 font-mono text-2xl font-bold text-ember">${cfg.price_usdc} <span className="text-xs text-ash">USDC</span></p>
              <ul className="mt-2 space-y-1 text-xs text-ash">
                <li>Deposit fee: {cfg.deposit_fee_percent}%</li>
                <li>Auto-compound: {cfg.auto_compound_hours ? `every ${cfg.auto_compound_hours}h (opt-in keeper)` : "manual only"}</li>
                {cfg.early_stake_hours ? <li>Early standard staking: {cfg.early_stake_hours}h before T</li> : null}
                {p === "Ultra" && <li>Ultra-NFT stake: {g.ultra_nft_stake_share_percent}% of Genesis emissions</li>}
              </ul>
              <div className="mt-3"><Cta onClick={() => setBuyPass(p)}>Buy {p} pass</Cta></div>
            </Card>
          );
        })}
      </div>
      <div className="mt-3"><Cta tone="ghost" onClick={() => setUpgrade(true)}>Upgrade pass — pay only the difference</Cta></div>
      <p className="mt-2 text-xs text-ash">
        Upgrades in place, same NFT kept: Genesis→Pro +${config.passes.upgrade_costs.Genesis_to_Pro}, Pro→Ultra +${config.passes.upgrade_costs.Pro_to_Ultra}, Genesis→Ultra +${config.passes.upgrade_costs.Genesis_to_Ultra}. Upgrades close at Genesis end.
      </p>

      <h2 className="mb-2 mt-6 font-display text-base font-bold text-bone">Stake</h2>
      <Card>
        <TokenPicker value={asset} onChange={setAsset} label="Stake asset" />
        <p className="mt-2 text-xs text-ash">Stake assets: {g.stake_assets.join(" · ")}. Day 1: standard 100%. Day 2+: LP 75% / standard 25%. LP deposit fee {g.lp_deposit_fee_percent_of_gross_shares}% of gross shares, to Treasury as POL.</p>
        <label className="mt-3 block font-mono text-[10px] tracking-widest text-dust">AMOUNT</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0.00" className="mt-1 w-full rounded-lg border border-white/15 bg-panel2 px-3 py-2.5 font-mono text-lg outline-none focus:border-ember" />
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Cta onClick={() => setFlow("stake")}>Stake</Cta>
          <Cta tone="ghost" onClick={() => setFlow("claim")}>Claim</Cta>
          <Cta tone="ghost" onClick={() => setFlow("compound")}>Compound</Cta>
        </div>
        <div className="mt-3 space-y-1"><Cooldown label="Claim / compound" /><Cooldown label="Stake" /></div>
        <p className="mt-2 text-xs text-ash">Claims during Genesis pay the Fire Tax (3% at peg, burned); after Genesis, claim fee {g.claim_fee_percent}% to Treasury. Hard compound cap: once per 3h per user per pool, enforced on-chain.</p>
      </Card>

      <div className="mt-3"><ZapPanel target="xTOMB·USDC LP (Genesis)" /></div>

      <h2 className="mb-2 mt-6 font-display text-base font-bold text-bone">Ultra-NFT stake card</h2>
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-sm font-bold text-bone">Ultra pass as its own position</h3>
            <p className="mt-1 text-xs text-ash">Receives {g.ultra_nft_stake_share_percent}% of Genesis emissions. No token deposit needed.</p>
          </div>
          <SimBadge />
        </div>
        <div className="mt-3"><Cta onClick={() => setUltraStaked(!ultraStaked)}>{ultraStaked ? "Simulated — Ultra NFT staked (preview)" : "Stake Ultra NFT"}</Cta></div>
      </Card>

      <h2 className="mb-2 mt-6 font-display text-base font-bold text-bone">Vesting tracker — {g.vesting_installments} installments</h2>
      <Card>
        <p className="text-xs text-ash">First claimable at Genesis end + {g.first_vesting_claim_hours_after_genesis_end}h. Each installment opens only when the previous one is claimed. Fastest full vest: 4 days from Genesis end. Claim fee {g.claim_fee_percent}%.</p>
        <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-8">
          {vest.map((v) => (
            <div key={v.n} className="rounded-lg border border-white/10 bg-panel2 p-2 text-center">
              <p className="font-mono text-xs font-bold text-bone">#{v.n}</p>
              <p className="font-mono text-[9px] text-dust">{v.opensAt}</p>
              <p className="mt-1 font-mono text-[9px] text-ash">locked</p>
            </div>
          ))}
        </div>
      </Card>
      <div className="mt-4"><SimNote /></div>

      {buyPass && (
        <Modal title={`Buy ${buyPass} pass — $${config.passes[buyPass].price_usdc} USDC`} onClose={() => setBuyPass(null)}>
          <p className="text-sm text-ash">Soulbound Metaplex Core NFT, one per wallet, frozen at mint. Proceeds go to the config treasury wallet, not a contract. Deposit fee {config.passes[buyPass].deposit_fee_percent}%.</p>
          <div className="mt-4"><Cta>Simulated — no program deployed yet</Cta></div>
        </Modal>
      )}
      {upgrade && (
        <Modal title="Upgrade pass in place" onClose={() => setUpgrade(false)}>
          <ul className="space-y-2 text-sm text-ash">
            <li>Genesis → Pro: +${config.passes.upgrade_costs.Genesis_to_Pro} USDC</li>
            <li>Pro → Ultra: +${config.passes.upgrade_costs.Pro_to_Ultra} USDC</li>
            <li>Genesis → Ultra: +${config.passes.upgrade_costs.Genesis_to_Ultra} USDC</li>
          </ul>
          <p className="mt-2 text-xs text-ash">Same NFT kept, tier changes on-chain. Closes at Genesis end.</p>
          <div className="mt-4"><Cta>Simulated — no program deployed yet</Cta></div>
        </Modal>
      )}
      {flow && (
        <Modal title={`${flow[0].toUpperCase() + flow.slice(1)} — ${asset}`} onClose={() => setFlow(null)}>
          <p className="text-sm text-ash">
            {flow === "stake" && `Stake ${amount || "0"} ${asset} into Genesis. Deposit fee per your pass tier (Genesis 2% / Pro 1% / Ultra 0%) to the treasury wallet.`}
            {flow === "claim" && `Claim liquid xTOMB rewards. During Genesis the claim pays the Fire Tax (3% at peg, burned); after Genesis a ${g.claim_fee_percent}% claim fee to Treasury. Vested half releases in ${g.vesting_installments} × ${g.vesting_installment_hours}h installments.`}
            {flow === "compound" && `Compound liquid xTOMB: sells for USDC, adds xTOMB/USDC liquidity, stakes it. Sell leg pays the withdrawal Fire Tax. Hard cap: once per 3h.`}
          </p>
          <div className="mt-4"><Cta>Simulated — no program deployed yet</Cta></div>
        </Modal>
      )}
    </div>
  );
}
