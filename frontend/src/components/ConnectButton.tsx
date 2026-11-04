import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { PREVIEW_ADDRESS, usePreview } from "@/lib/preview";

/**
 * Wallet control.
 *
 *   Real wallet connected → network picker (supported chains only) + address
 *                           chip; the chip disconnects.
 *   Preview, sample wallet → "Sample" chip; clicking it hides the sample
 *                           wallet so the disconnected state can be reviewed.
 *   Otherwise             → "Connect wallet" (injected). Connecting asks for
 *                           accounts only — never a transaction.
 */
export function ConnectButton({ compact = false }: { compact?: boolean }) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, isError } = useConnect();
  const { disconnect } = useDisconnect();
  const { chains, switchChain, isPending: switching } = useSwitchChain();
  const preview = usePreview();

  if (isConnected && address) {
    const known = chains.some((c) => c.id === chainId);
    return (
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Network"
          value={known ? chainId : ""}
          disabled={switching}
          onChange={(e) => switchChain({ chainId: Number(e.target.value) })}
          className={`hidden h-9 max-w-[150px] rounded-full border bg-white/[0.03] px-3 font-mono text-[11.5px] outline-none sm:block ${known ? "border-white/10 text-bone-dim" : "border-bad/50 text-bad"}`}
        >
          <option value="" disabled>
            Unsupported network
          </option>
          {chains.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => disconnect()}
          aria-label="Disconnect wallet"
          className="flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] pl-2.5 pr-3 font-mono text-[12px] text-bone-dim hover:border-white/20 hover:text-bone"
        >
          <span className={`h-2 w-2 rounded-full ${known ? "bg-ok" : "bg-bad"}`} />
          {address.slice(0, 6)}…{address.slice(-4)}
        </button>
      </div>
    );
  }

  if (preview.enabled && preview.sampleWallet) {
    return (
      <button
        type="button"
        onClick={() => preview.setSampleWallet(false)}
        title="Sample wallet with simulated balances — click to view the disconnected state"
        className="flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-warn/35 bg-warn/[0.06] pl-2.5 pr-3 font-mono text-[12px] text-warn hover:border-warn/60"
      >
        <span className="h-2 w-2 rounded-full bg-warn" />
        Sample {PREVIEW_ADDRESS.slice(0, 6)}…{PREVIEW_ADDRESS.slice(-4)}
      </button>
    );
  }

  const connector = connectors[0];
  return (
    <div className="flex items-center gap-2">
      {preview.enabled && (
        <button type="button" onClick={() => preview.setSampleWallet(true)} className="hidden font-mono text-[11px] text-ash hover:text-bone sm:inline">
          use sample
        </button>
      )}
      <button
        type="button"
        onClick={() => connector && connect({ connector })}
        disabled={isPending || !connector}
        className={`btn btn-primary ${compact ? "h-9 px-4 text-[13px]" : "h-10 px-5"}`}
      >
        {isPending ? "Confirm in wallet…" : !connector ? "No wallet found" : "Connect wallet"}
      </button>
      {isError && <span className="sr-only" role="alert">Check your wallet and try again.</span>}
    </div>
  );
}
