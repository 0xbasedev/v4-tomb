import { useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";

import { getDeployment } from "@/lib/addresses";
import { networks, useSelectedNetwork } from "@/lib/networks";

/**
 * Network picker. Lists exactly the networks in config/networks.json and says
 * which have a deployment. With a wallet connected, choosing one asks the
 * wallet to switch chain (never a transaction); without one it only changes
 * which network the page reads.
 */
export function ChainPicker() {
  const { selected, select } = useSelectedNetwork();
  const { isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [error, setError] = useState(false);
  const onManifest = isConnected && networks.some((n) => n.id === chainId);
  const value = onManifest ? chainId! : selected;

  return (
    <label className="relative flex h-9 shrink-0 items-center">
      <span className="sr-only">Network</span>
      <select
        aria-label="Network"
        value={value}
        onChange={async (e) => {
          const id = Number(e.target.value);
          setError(false);
          select(id);
          if (!isConnected) return;
          try {
            await switchChainAsync({ chainId: id });
          } catch {
            setError(true);
          }
        }}
        className={`h-9 max-w-[132px] cursor-pointer appearance-none truncate rounded-full border bg-basalt-2 py-0 pl-3 pr-7 font-mono text-[12px] text-bone outline-none transition-colors hover:border-white/25 sm:max-w-[190px] ${
          error || (isConnected && !onManifest) ? "border-bad/60" : "border-white/10"
        }`}
      >
        {networks.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name} · {getDeployment(n.id) ? "live" : "not deployed"}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-3 text-[10px] text-ash">
        ▾
      </span>
      {error && (
        <span role="alert" className="sr-only">
          The network switch was not completed. Check your wallet and try again.
        </span>
      )}
    </label>
  );
}
