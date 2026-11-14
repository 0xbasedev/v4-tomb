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
  const name = chainName(selected !== PRIMARY.id ? selected : chainId);
  const showWrongBanner = wrong && !preview.enabled;
  const showUnlaunchedBanner = !wrong && unavailable && !preview.enabled;

  return (
    <>
      {showWrongBanner && (
        <section className="mx-auto mt-4 max-w-7xl px-4 md:mt-6 md:px-8" aria-label="Chain availability">
          <div className="rounded-2xl border border-ember/40 bg-ember/10 p-5 md:p-6">
            <span className="font-mono text-xs uppercase tracking-widest text-ember">Read-only · not the live chain</span>
            <h1 className="mt-2 font-display text-2xl text-bone md:text-3xl">Coming soon on {name}</h1>
            <p className="mt-2 text-sm text-ash">You can still browse every page. Writes stay disabled until you are on live Robinhood Chain.</p>
            <button
              type="button"
              disabled={pending}
              className="btn btn-primary mt-4"
              onClick={async () => {
                setPending(true);
                setError("");
                try { await back(); }
                catch { setError("Network switch was not completed. Check your wallet and try again. Nothing was sent."); }
                finally { setPending(false); }
              }}
            >
              Switch back to Robinhood Chain
            </button>
            {error && <p role="alert" className="mt-3 text-warn">{error}</p>}
          </div>
        </section>
      )}
      {showUnlaunchedBanner && (
        <section className="mx-auto mt-4 max-w-7xl px-4 md:mt-6 md:px-8" aria-label="Chain availability">
          <div className="rounded-2xl border border-white/10 bg-basalt-2/80 p-5 md:p-6">
            <span className="font-mono text-xs uppercase tracking-widest text-ember">xTOMB / xSHARE</span>
            <h1 className="mt-2 font-display text-2xl text-bone md:text-3xl">Not launched yet</h1>
            <p className="mt-2 text-sm text-ash">Robinhood Chain is the first home for xTOMB. Verified protocol addresses are not available yet, so every page below is read-only. Trading, staking and Genesis writes stay disabled.</p>
            <p className="mt-2 text-sm text-ash">{PRIMARY.name} · Mainnet · {PRIMARY.nativeCurrency?.symbol} gas · {PRIMARY.referenceToken?.symbol} reference token ({PRIMARY.referenceToken?.decimals} decimals).</p>
            <button type="button" disabled className="btn btn-primary mt-4">Not launched yet</button>
            <p className="mt-3 font-mono text-xs text-ash-dim">RH icon placeholder · TODO official logo</p>
          </div>
        </section>
      )}
      {children}
    </>
  );
}
