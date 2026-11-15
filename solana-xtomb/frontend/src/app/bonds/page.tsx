"use client";
import { useState } from "react";
import { Card, Cta, Modal, SectionTitle, SimBadge, SimNote, TokenPicker } from "@/components/ui";
import { config, type TokenSymbol } from "@/lib/config";

export default function BondsPage() {
  const [flow, setFlow] = useState<"buy" | "redeem" | null>(null);
  const [token, setToken] = useState<TokenSymbol>("xTOMB");
  const [twap, setTwap] = useState(0.9);
  const b = config.xbond;
  const buyOk = twap < b.buy_only_below_twap;
  const redeemOk = twap > b.redeem_only_above_twap;
  return (
    <div>
      <SectionTitle title="Bonds" sub="xBOND — pure discount / redeem instrument. No farm, no Masonry stake, no vote." />
      <div className="mb-4 flex gap-2"><SimBadge /></div>
      <Card>
        <p className="font-mono text-[10px] tracking-widest text-dust">SIMULATED TWAP</p>
        <p className="mt-1 font-mono text-2xl font-bold text-bone">${twap.toFixed(2)}</p>
        <input type="range" min={0.8} max={1.1} step={0.01} value={twap} onChange={(e) => setTwap(parseFloat(e.target.value))} className="mt-2 w-full accent-[#ff6a2b]" />
        <ul className="mt-3 space-y-1 text-sm text-ash">
          <li>Buy: only when TWAP &lt; $1.00 — pay TWAP × 1 xTOMB per xBOND ({twap.toFixed(2)} xTOMB now). xTOMB paid is burned immediately.</li>
          <li>Redeem: only when TWAP &gt; $1.00 — burn 1 xBOND → mint 1 xTOMB from expansion allowance only. No partial fill; queues if allowance exhausted.</li>
          <li>Max discount / max outstanding: in config.</li>
        </ul>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Cta disabled={!buyOk} onClick={() => setFlow("buy")}>{buyOk ? "Buy xBOND" : "Buy closed — TWAP ≥ $1.00"}</Cta>
          <Cta tone="ghost" disabled={!redeemOk} onClick={() => setFlow("redeem")}>{redeemOk ? "Redeem xBOND" : "Redeem closed — TWAP ≤ $1.00"}</Cta>
        </div>
      </Card>
      <div className="mt-3"><Card><TokenPicker value={token} onChange={setToken} label="Pay with" /></Card></div>
      <div className="mt-4"><SimNote /></div>
      {flow && (
        <Modal title={flow === "buy" ? "Buy xBOND" : "Redeem xBOND"} onClose={() => setFlow(null)}>
          <p className="text-sm text-ash">
            {flow === "buy" ? `Pay ${twap.toFixed(2)} xTOMB per xBOND at TWAP $${twap.toFixed(2)}. The xTOMB is burned immediately.` : "Burn 1 xBOND → mint 1 xTOMB, paid from expansion mint allowance only."}
          </p>
          <div className="mt-4"><Cta>Simulated — no program deployed yet</Cta></div>
        </Modal>
      )}
    </div>
  );
}
