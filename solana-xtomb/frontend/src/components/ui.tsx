"use client";
import { useState, type ReactNode } from "react";
import { TOKENS, type TokenSymbol, SIM_NOTE } from "@/lib/config";

export function SimBadge({ label = "SIMULATED" }: { label?: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-amberx/50 bg-amberx/10 px-2 py-0.5 font-mono text-[10px] tracking-widest text-amberx">
      {label}
    </span>
  );
}
export function PlannedBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-cyanx/50 bg-cyanx/10 px-2 py-0.5 font-mono text-[10px] tracking-widest text-cyanx">
      PLANNED
    </span>
  );
}
export function SimNote() {
  return (
    <p className="font-mono text-[11px] leading-relaxed text-dust">
      {SIM_NOTE}. Nothing here sends a transaction or reads a live balance.
    </p>
  );
}
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`clip-card border border-white/10 bg-panel p-4 ${className}`}>{children}</div>
  );
}
export function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-4">
      <h1 className="font-display text-2xl font-bold text-bone">{title}</h1>
      {sub && <p className="mt-1 text-sm text-ash">{sub}</p>}
    </div>
  );
}
export function Cta({
  children, onClick, disabled, tone = "ember",
}: { children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: "ember" | "ghost"; }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        tone === "ember"
          ? "clip-cta w-full bg-gradient-to-r from-[#ff6a2b] to-[#ff3d1f] px-4 py-3 font-display text-sm font-bold text-white disabled:opacity-50"
          : "clip-cta w-full border border-white/20 bg-panel2 px-4 py-3 font-display text-sm font-bold text-bone disabled:opacity-50"
      }
    >
      {children}
    </button>
  );
}

/** The ONE TokenPicker — used everywhere. Zero native select elements in the app. */
export function TokenPicker({
  value, onChange, label = "Token",
}: { value: TokenSymbol; onChange: (t: TokenSymbol) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const cur = TOKENS.find((t) => t.symbol === value)!;
  return (
    <div className="relative">
      <span className="font-mono text-[10px] tracking-widest text-dust">{label}</span>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-1 flex w-full items-center justify-between rounded-lg border border-white/15 bg-panel2 px-3 py-2.5"
      >
        <span className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: cur.color }} />
          <span className="font-mono text-sm font-bold">{cur.symbol}</span>
        </span>
        <span className="text-ash">▾</span>
      </button>
      {open && (
        <div className="absolute z-40 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-white/15 bg-panel2 shadow-2xl">
          {TOKENS.map((t) => (
            <button
              key={t.symbol}
              type="button"
              onClick={() => { onChange(t.symbol); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/5"
            >
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: t.color }} />
              <span className="font-mono text-sm font-bold">{t.symbol}</span>
              <span className="truncate text-xs text-dust">{t.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Heavy modal shell for all flows. */
export function Modal({
  title, onClose, children,
}: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="clip-card max-h-[88vh] w-full max-w-md overflow-auto border border-white/15 bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-bold text-bone">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded border border-white/15 px-2 py-1 text-ash">✕</button>
        </div>
        {children}
        <div className="mt-4 rounded-lg border border-amberx/40 bg-amberx/10 p-3">
          <p className="font-mono text-[11px] leading-relaxed text-amberx">{SIM_NOTE} — this modal previews the flow only.</p>
        </div>
      </div>
    </div>
  );
}

/** Zap panel: single-token zap into an LP / farm target. */
export function ZapPanel({ target }: { target: string }) {
  const [token, setToken] = useState<TokenSymbol>("USDC");
  const [amount, setAmount] = useState("");
  const [done, setDone] = useState(false);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-sm font-bold text-bone">Zap in — single token</h3>
        <SimBadge />
      </div>
      <TokenPicker value={token} onChange={setToken} label="Zap from" />
      <label className="mt-3 block font-mono text-[10px] tracking-widest text-dust">AMOUNT</label>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        inputMode="decimal"
        placeholder="0.00"
        className="mt-1 w-full rounded-lg border border-white/15 bg-panel2 px-3 py-2.5 font-mono text-lg outline-none focus:border-ember"
      />
      <p className="mt-2 text-xs text-ash">
        Zap {token || "—"} → {target}. Simulated route: half swaps, half pairs, LP is staked in one step.
      </p>
      <div className="mt-3">
        <Cta onClick={() => setDone(true)}>{done ? "Simulated — no program deployed yet" : "Preview zap"}</Cta>
      </div>
      {done && <p className="mt-2 font-mono text-[11px] text-mint">Zap preview only. No transaction was sent.</p>}
    </Card>
  );
}
