import { useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { NETWORKS, PRIMARY, liveDeployment, useReturnToPrimary, useSelectedNetwork } from "@/lib/networks";
import { usePreview } from "@/lib/preview";
import { chainName } from "@/lib/wagmi";

export function ChainPicker() {
  const { selected, select } = useSelectedNetwork();
  const [open, setOpen] = useState(false);
  return <div className="relative">
    <button type="button" aria-label="Select chain" aria-expanded={open} onClick={() => setOpen(!open)} className="h-9 max-w-[82px] truncate sm:max-w-[150px] rounded-full border border-white/10 px-3 font-mono text-xs text-bone">{chainName(selected)} ▾</button>
    {open && <div role="group" aria-label="Chains" className="absolute right-0 z-50 mt-2 max-h-96 w-72 overflow-auto rounded-2xl border border-white/10 bg-basalt-2 p-2 shadow-xl">
      {NETWORKS.map((n) => <button type="button" key={n.id} onClick={() => { select(n.id); setOpen(false); }} className="flex w-full items-center gap-3 rounded-xl p-3 text-left text-sm text-bone hover:bg-white/10">
        <span title={n.iconNote} aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ember/30 font-mono text-xs text-ember">{n.icon}</span>
        <span>{n.name} · {n.enabled ? (liveDeployment(n.id) ? "Live" : "Not launched") : "Coming soon"}</span>
      </button>)}
    </div>}
  </div>;
}
export function ChainGate({ children }: { children: ReactNode }) {
  const { selected } = useSelectedNetwork();
  const { chainId, isConnected } = useAccount();
  const preview = usePreview();
  const back = useReturnToPrimary();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const wrong = selected !== PRIMARY.id || (isConnected && chainId !== PRIMARY.id);
  const unavailable = !liveDeployment(selected);
  if (!wrong && (preview.enabled || !unavailable)) return <>{children}</>;
  const name = chainName(selected !== PRIMARY.id ? selected : chainId);
  return <section className="mx-auto my-16 max-w-xl rounded-3xl border border-white/10 bg-basalt-2/80 p-8 text-center md:my-24" aria-label="Chain availability">
    <span className="font-mono text-xs uppercase tracking-widest text-ember">xTOMB / xSHARE</span>
    <h1 className="mt-5 text-3xl text-bone">{wrong ? `Coming soon on ${name}` : "Not launched yet"}</h1>
    <p className="mt-4 text-ash">{wrong ? "This chain is not active for xTOMB yet." : "Robinhood Chain is the first home for xTOMB. Verified protocol addresses are not available yet. Trading, staking and Genesis participation are disabled."}</p>
    <p className="mt-4 text-sm text-ash">{PRIMARY.name} · Mainnet · {PRIMARY.nativeCurrency?.symbol} gas · {PRIMARY.referenceToken?.symbol} reference token ({PRIMARY.referenceToken?.decimals} decimals). No simulated balances or live prices are shown.</p>
    {wrong ? <button type="button" disabled={pending} className="btn btn-primary mt-6" onClick={async () => { setPending(true); setError(""); try { await back(); } catch { setError("Network switch was not completed. Check your wallet and try again. Nothing was sent."); } finally { setPending(false); } }}>Switch back to Robinhood Chain</button> : <button type="button" disabled className="btn btn-primary mt-6">Not launched yet</button>}
    {error && <p role="alert" className="mt-4 text-warn">{error}</p>}
    <p className="mt-5 font-mono text-xs text-ash-dim">RH icon placeholder · TODO official logo</p>
  </section>;
}
