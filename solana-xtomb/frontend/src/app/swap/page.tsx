"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { Card, Cta, Modal, SectionTitle, SimBadge, SimNote, TokenPicker, ZapPanel } from "@/components/ui";
import { config, fireTaxPercent, type TokenSymbol } from "@/lib/config";
import confirmAnimation from "@/lib/confirmAnimation.json";

const Lottie = dynamic(() => import("lottie-react"), { ssr: false });
const ROUTES = ["Buy", "Sell", "Enter LP", "Exit LP", "Add LP", "Remove LP"] as const;

export default function SwapPage() {
  const [route, setRoute] = useState<(typeof ROUTES)[number]>("Buy");
  const [from, setFrom] = useState<TokenSymbol>("USDC");
  const [to, setTo] = useState<TokenSymbol>("xTOMB");
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [zap, setZap] = useState(false);
  const twap = 0.97; // simulated TWAP for the Fire Tax preview
  const tax = fireTaxPercent(twap, from === "xSHARE");
  const amt = parseFloat(amount) || 0;
  const poolFee = amt * 0.003; // simulated 0.30% pool fee, itemized separately
  const taxAmt = amt * (tax / 100);

  return (
    <div>
      <SectionTitle title="Swap" sub="One TokenPicker, route chips, Fire Tax shown before signing." />
      <div className="mb-4 flex gap-2"><SimBadge /></div>
      <div className="mb-3 flex flex-wrap gap-2">
        {ROUTES.map((r) => (
          <button key={r} onClick={() => setRoute(r)} className={`rounded-full border px-3 py-1.5 font-mono text-xs font-bold ${route === r ? "border-ember bg-ember text-white" : "border-white/15 bg-panel2 text-ash"}`}>
            {r}
          </button>
        ))}
      </div>
      <Card>
        <TokenPicker value={from} onChange={setFrom} label="From" />
        <label className="mt-3 block font-mono text-[10px] tracking-widest text-dust">AMOUNT</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0.00" className="mt-1 w-full rounded-lg border border-white/15 bg-panel2 px-3 py-2.5 font-mono text-lg outline-none focus:border-ember" />
        <div className="mt-3"><TokenPicker value={to} onChange={setTo} label="To" /></div>
        <label className="mt-3 flex items-center gap-2 text-sm text-ash">
          <input type="checkbox" checked={zap} onChange={(e) => setZap(e.target.checked)} className="h-4 w-4 accent-[#ff6a2b]" />
          Zap — single-token into / out of LP in one step
        </label>
        <div className="mt-4 rounded-lg border border-white/10 bg-panel2 p-3 font-mono text-xs leading-relaxed text-ash">
          <p className="font-bold text-bone">Before signing — fees itemized</p>
          <p>Simulated TWAP: ${twap.toFixed(2)} · {config.withdrawal_fire_tax.display_name}: {tax}% = {taxAmt.toFixed(4)} {from} (withdrawals only; buys &amp; transfers 0%)</p>
          <p>Pool fee (simulated 0.30%): {poolFee.toFixed(4)} {from} — separate from {config.withdrawal_fire_tax.display_name}</p>
          <p>Route: {route} · {from} → {to}{zap ? " · zap" : ""}</p>
          <p className="text-dust">No program deployed — this preview sends nothing.</p>
        </div>
        <div className="mt-3"><Cta onClick={() => setConfirm(true)}>Review swap</Cta></div>
      </Card>
      <div className="mt-3"><ZapPanel target="xTOMB·USDC LP" /></div>
      <div className="mt-4"><SimNote /></div>
      {confirm && (
        <Modal title="Confirm swap" onClose={() => setConfirm(false)}>
          <div className="mx-auto h-[120px] w-[120px]">
            <Lottie animationData={confirmAnimation} loop={false} />
          </div>
          <p className="text-center font-mono text-[11px] text-dust">dot → ring → green check (Lottie, swap-confirm only)</p>
          <div className="mt-3 space-y-1 font-mono text-xs text-ash">
            <p>{route}: {amount || "0"} {from} → {to}</p>
            <p>{config.withdrawal_fire_tax.display_name}: {tax}% ({taxAmt.toFixed(4)} {from})</p>
            <p>Pool fee: {poolFee.toFixed(4)} {from}</p>
          </div>
          <div className="mt-4"><Cta>Simulated — no program deployed yet</Cta></div>
        </Modal>
      )}
    </div>
  );
}
