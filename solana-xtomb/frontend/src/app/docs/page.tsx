"use client";
import { useState } from "react";
import { Card, SectionTitle, SimBadge } from "@/components/ui";
import { config, fireTaxPercent } from "@/lib/config";

const SECTIONS = [
  { n: "I", t: "Overview", b: "xTOMB targets 1 USDC. xSHARE is capped at 33,333. Regular SPL tokens, 6 decimals — no Token-2022." },
  { n: "II", t: "Tokens", b: "xTOMB (peg, Genesis reward), xSHARE (capped share), xBOND (discount/redeem), USDC (quote & payment)." },
  { n: "III", t: "Supply & allocations", b: "xSHARE: farm 25,641 · sale escrow 100 · deployer 1 · team/dev launch 100 · treasury launch 550 · vesting 6,941 (Team 2,500 / Developer 2,000 / Treasury 2,441, 180-day linear). xTOMB launch 11,000 + Genesis budget 30,000." },
  { n: "IV", t: "Passes", b: "Genesis $50 / Pro $100 / Ultra $300, soulbound, one per wallet, upgrades in place paying only the difference. Ultra stakes as its own Genesis position for 5% of emissions." },
  { n: "V", t: "Genesis", b: "7 days. Ultra pre-stake T−24h. Day 1 standard 100%. Day 2+ LP 75% / standard 25%. 50/50 liquid/vested, 16 × 6h installments, claims during Genesis pay the Fire Tax (burned) instead of the 2% claim fee, 3h shared cooldown." },
  { n: "VI", t: "Withdrawal Fire Tax", b: "Exits only — buys and transfers 0%. At/above peg: 3% xTOMB / 6% xSHARE, rising on one shared quadratic curve to the 12% cap — xSHARE caps sooner (~$0.89), both capped at/below $0.85. Genesis minima are the same 3% / 6%. Recovery floor settles back to 3% over 7h. One debit, highest applicable. Admin-configurable; the admin can zero both taxes while the protocol is healthy. See the explorer below." },
  { n: "VII", t: "xBOND", b: "Buy below $1.00 at TWAP × 1 xTOMB (burned). Redeem above $1.00: 1 xBOND → 1 xTOMB from expansion allowance only." },
  { n: "VIII", t: "Farm", b: "25,641 xSHARE over 365 days. 3h compound gate. Pools added by Admin / launch wizard." },
  { n: "IX", t: "Masonry", b: "Lazy 6h epochs, Epoch 0 by manual Admin trigger only. Bootstrap 2 epochs at 3% above $0.90, then expansion capped 2% per epoch on fresh TWAP strictly above $1.01." },
  { n: "X", t: "Critical Defense", b: "Enters at fresh TWAP ≤ $0.90 (100% of xSHARE tax → buy-and-burn). Exits after 2 consecutive 6h checkpoints above $1.01." },
  { n: "XI", t: "Fees & wallets", b: "Four wallets in config: team, dev, treasury, trading bot. Operational split Treasury 50% / Team 20% / Dev 15% / Arb 15%. xSHARE tax keeps the 12/20/68 split." },
  { n: "XII", t: "Launch wizard & Admin", b: "7-step wizard deploys (dry-run first, devnet only, gates acknowledged). Admin maintains: pools, fees, wallets, oracle, epoch, TWAP, reserve, roles, bonds, maintenance toggle." },
];

export default function DocsPage() {
  const [twap, setTwap] = useState(0.92);
  const tax = fireTaxPercent(twap);
  const [epoch, setEpoch] = useState(0);
  const [claimed, setClaimed] = useState(0);
  const g = config.genesis;
  return (
    <div>
      <SectionTitle title="Docs" sub="Sections I–XII · interactive explorers · all numbers from config" />
      <div className="mb-4 flex gap-2"><SimBadge /></div>

      <h2 className="mb-2 font-display text-base font-bold text-bone">Fire Tax explorer</h2>
      <Card>
        <p className="font-mono text-[10px] tracking-widest text-dust">TWAP — DRAG TO EXPLORE</p>
        <p className="mt-1 font-mono text-2xl font-bold text-bone">${twap.toFixed(2)} <span className="text-sm text-ash">→ {config.withdrawal_fire_tax.display_name} {tax}%</span></p>
        <input type="range" min={0.8} max={1.05} step={0.01} value={twap} onChange={(e) => setTwap(parseFloat(e.target.value))} className="mt-2 w-full accent-[#ff6a2b]" />
        <div className="mt-2 h-3 w-full rounded bg-panel2">
          <div className="h-3 rounded bg-gradient-to-r from-[#34e3a0] via-[#ffc24b] to-[#ff4d6a]" style={{ width: `${(tax / 12) * 100}%` }} />
        </div>
        <p className="mt-2 text-xs text-ash">3% xTOMB / 6% xSHARE at/above $1.00 · shared quadratic curve to the 12% cap (xSHARE ~$0.89, xTOMB ~$0.86) · max 12% · recovery floor decays to 3% over 7h · admin can zero both when healthy.</p>
      </Card>

      <h2 className="mb-2 mt-6 font-display text-base font-bold text-bone">TWAP slider &amp; epoch wheel</h2>
      <Card>
        <p className="text-xs text-ash">Epoch {epoch} of 6h. Bootstrap {config.masonry.bootstrap_epochs} × {config.masonry.bootstrap_rate_percent_per_epoch}% above ${config.masonry.bootstrap_only_above_twap}; expansion ≤ {config.masonry.expansion_cap_percent_per_epoch}%/epoch above ${config.masonry.expansion_requires_fresh_twap_above}.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {Array.from({ length: 12 }, (_, i) => (
            <button key={i} onClick={() => setEpoch(i)} className={`flex h-11 w-11 items-center justify-center rounded-full border font-mono text-xs font-bold ${epoch === i ? "border-ember bg-ember text-white" : "border-white/15 bg-panel2 text-ash"}`}>{i}</button>
          ))}
        </div>
      </Card>

      <h2 className="mb-2 mt-6 font-display text-base font-bold text-bone">Claim–settle visual</h2>
      <Card>
        <p className="text-xs text-ash">Claim {g.reward_split_liquid_percent}% liquid now, {g.reward_split_vested_percent}% vested in {g.vesting_installments} × {g.vesting_installment_hours}h installments. Click installments to simulate claiming in order.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {Array.from({ length: g.vesting_installments }, (_, i) => (
            <button key={i} onClick={() => setClaimed(i + 1)} disabled={i + 1 > claimed + 1} className={`rounded-lg border px-3 py-2 font-mono text-xs font-bold ${i < claimed ? "border-mint bg-mint/20 text-mint" : "border-white/15 bg-panel2 text-ash"} disabled:opacity-40`}>
              #{i + 1} {i < claimed ? "✓ claimed" : "locked"}
            </button>
          ))}
        </div>
        <p className="mt-2 font-mono text-[11px] text-dust">{claimed} / {g.vesting_installments} installments claimed (simulated). Each opens only when the previous one is claimed.</p>
      </Card>

      <div className="mt-6 grid gap-3">
        {SECTIONS.map((s) => (
          <Card key={s.n}>
            <h3 className="font-display text-sm font-bold text-bone"><span className="text-ember">{s.n}.</span> {s.t}</h3>
            <p className="mt-1 text-sm text-ash">{s.b}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
