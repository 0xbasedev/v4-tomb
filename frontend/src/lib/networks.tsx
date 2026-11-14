import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAccount, useConnectors } from "wagmi";
import config from "@config/frontend-networks.json";
import { DEPLOYMENTS } from "@/lib/launch";

export const NETWORKS = config.networks;
export const PRIMARY = NETWORKS.find((n) => n.id === config.primaryChainId)!;
export function liveDeployment(chainId: number) {
  return NETWORKS.find((n) => n.id === chainId)?.enabled
    ? DEPLOYMENTS.find((d) => d.chainId === chainId) ?? null : null;
}
const NetworkContext = createContext({ selected: PRIMARY.id, select: (_id: number) => {} });
export function NetworkProvider({ children }: { children: ReactNode }) {
  const { chainId, isConnected } = useAccount();
  const [selected, select] = useState<number>(PRIMARY.id);
  useEffect(() => { if (isConnected && chainId) select(chainId); }, [chainId, isConnected]);
  return <NetworkContext.Provider value={{ selected, select }}>{children}</NetworkContext.Provider>;
}
export const useSelectedNetwork = () => useContext(NetworkContext);

/** Switch only; never request accounts, signatures, approvals or transactions. */
export function useReturnToPrimary() {
  const { connector, isConnected } = useAccount();
  const connectors = useConnectors();
  const { select } = useSelectedNetwork();
  return async () => {
    if (isConnected) {
      const provider = await (connector ?? connectors[0])?.getProvider() as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> } | undefined;
      if (!provider) throw new Error("Wallet unavailable. Reconnect and try again.");
      const chainId = `0x${PRIMARY.id.toString(16)}`;
      try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] }); }
      catch (error) {
        const e = error as { code?: number; data?: { originalError?: { code?: number } } };
        if (e.code !== 4902 && e.data?.originalError?.code !== 4902) throw error;
        await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId, chainName: PRIMARY.name, nativeCurrency: PRIMARY.nativeCurrency, rpcUrls: [PRIMARY.rpcUrl], blockExplorerUrls: [PRIMARY.explorerUrl] }] });
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
      }
    }
    select(PRIMARY.id);
  };
}
