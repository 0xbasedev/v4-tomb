"use client";
import { useState } from "react";
import { Card, Cta, Modal, SectionTitle, SimBadge, SimNote } from "@/components/ui";
import { config } from "@/lib/config";

export default function MasonryPage() {
  const [flow, setFlow] = useState<string | null>(null);
  const m = config.masonry;
  const epochs = Array.from({ length: 12 }, (_, i) => i);
  return (
    <div>
      <SectionTitle title="Masonry" sub="Expansion — lazy 6h epochs, no keeper crank. Epoch 0 opens only on manual Admin trigger." />
      <div className="mb-4 flex gap-2"><SimBadge /></div>
      <div className="grid grid-cols-2 gap-3">
        <Card><p className="font-mono text-[10px] tracking-widest text-dust">CURRENT EPOCH (SIM)</p><p className="mt-1 font-mono text-2xl font-bold text-bone">0</p><p className="text-xs text-ash">Not opened — Admin trigger required</p></Card>
        <Card><p className="font-mono text-[10px] tracking-widest text-dust">EXPANSION CAP</p><p className="mt-1 font-mono text-2xl font-bold text-bone">{m.expansion_cap_percent_per_epoch}% / epoch</p><p className="text-xs text-ash">Only on fresh TWAP strictly above ${m.expansion_requires_fresh_twap_above}</p></Card>
        <Card><p className="font-mono text-[10px] tracking-widest text-dust">BOOTSTRAP</p><p className="mt-1 font-mono text-2xl font-bold text-bone">{m.bootstrap_epochs} × {m.bootstrap_rate_percent_per_epoch}%</p><p className="text-xs text-ash">Only when TWAP above ${m.bootstrap_only_above_twap}; none at or below</p></Card>
        <Card><p className="font-mono text-[10px] tracking-widest text-dust">CRITICAL DEFENSE</p><p className="mt-1 font-mono text-2xl font-bold text-bone">Off</p><p className="text-xs text-ash">Enters at TWAP ≤ ${config.critical_defense.enter_at_fresh_twap_at_or_below}; exits after {config.critical_defense.exit_checkpoint_count} checkpoints above ${config.critical_defense.exit_after_consecutive_checkpoints_above}</p></Card>
      </div>
      <h2 className="mb-2 mt-6 font-display text-base font-bold text-bone">Epoch wheel — 12 epochs (simulated)</h2>
      <Card>
        <div className="flex flex-wrap gap-2">
          {epochs.map((e) => (
            <div key={e} className={`flex h-12 w-12 items-center justify-center rounded-full border font-mono text-xs font-bold ${e === 0 ? "border-ember bg-ember/20 text-ember" : "border-white/15 bg-panel2 text-ash"}`}>
              {e}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ash">Epochs advance on user interaction (lazy). No catch-up issuance. Oracle freshness: {config.oracle.freshness_minutes} min; withdrawals fail closed on stale data, buys stay available.</p>
      </Card>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Cta onClick={() => setFlow("Stake xSHARE in Masonry")}>Stake xSHARE</Cta>
        <Cta tone="ghost" onClick={() => setFlow("Claim Masonry rewards")}>Claim rewards</Cta>
      </div>
      <div className="mt-4"><SimNote /></div>
      {flow && (
        <Modal title={flow} onClose={() => setFlow(null)}>
          <p className="text-sm text-ash">Masonry action preview. Masonry exits pay the withdrawal Fire Tax.</p>
          <div className="mt-4"><Cta>Simulated — no program deployed yet</Cta></div>
        </Modal>
      )}
    </div>
  );
}
