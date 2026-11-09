"use client";
import { useState } from "react";
import { Card, Cta, Modal, SectionTitle, SimBadge, SimNote, TokenPicker, ZapPanel } from "@/components/ui";
import { config, type TokenSymbol } from "@/lib/config";

export default function FarmPage() {
  const [flow, setFlow] = useState<string | null>(null);
  const [token, setToken] = useState<TokenSymbol>("xTOMB·USDC LP");
  const pools = [
    { name: "xTOMB·USDC LP", weight: "—", note: "Weights live in config; set at launch." },
    { name: "xSHARE·USDC LP", weight: "—", note: "Weights live in config; set at launch." },
    { name: "xTOMB single-stake", weight: "—", note: "Post-Genesis farm pool." },
  ];
  return (
    <div>
      <SectionTitle title="Farm" sub={`${config.farm.emissions_xshare_365d.toLocaleString()} xSHARE over 365 days · 3h compound gate`} />
      <div className="mb-4 flex gap-2"><SimBadge /></div>
      <div className="grid gap-3">
        {pools.map((p) => (
          <Card key={p.name}>
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-bold text-bone">{p.name}</h3>
              <SimBadge />
            </div>
            <p className="mt-1 text-xs text-ash">{p.note}</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Cta onClick={() => setFlow(`Stake ${p.name}`)}>Stake</Cta>
              <Cta tone="ghost" onClick={() => setFlow(`Harvest ${p.name}`)}>Harvest</Cta>
              <Cta tone="ghost" onClick={() => setFlow(`Withdraw ${p.name}`)}>Withdraw</Cta>
            </div>
            <p className="mt-2 text-xs text-ash">Withdrawals pay the withdrawal Fire Tax (1–12%). Compound gate: once per 3h per user per pool.</p>
          </Card>
        ))}
      </div>
      <div className="mt-3">
        <Card>
          <h3 className="font-display text-sm font-bold text-bone">Farm token</h3>
          <div className="mt-2"><TokenPicker value={token} onChange={setToken} label="Stake via TokenPicker" /></div>
        </Card>
      </div>
      <div className="mt-3"><ZapPanel target="Farm LP" /></div>
      <div className="mt-4"><SimNote /></div>
      {flow && (
        <Modal title={flow} onClose={() => setFlow(null)}>
          <p className="text-sm text-ash">Farm action preview. Rewards are xSHARE from the 25,641 / 365-day emission schedule. Farm migration terms are post-launch work, not in this build.</p>
          <div className="mt-4"><Cta>Simulated — no program deployed yet</Cta></div>
        </Modal>
      )}
    </div>
  );
}
