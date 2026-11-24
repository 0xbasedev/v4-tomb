import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import document from "@protocol-manifest";
import { parseNetworks, transactionUrl } from "../../../config/schema.mjs";

/**
 * Networks and deployments come from one file: config/networks.json, validated
 * by config/schema.mjs — the same manifest the deploy scripts and the keeper
 * read. Nothing here invents a chain, an address or a deployment.
 */
export const networks = parseNetworks(document);
export type ManifestNetwork = (typeof networks)[number];

/** The first network in the manifest is the one the app opens on. */
export const PRIMARY = networks[0];

export const networkById = (id: number | undefined) => networks.find((n) => n.id === id);
export const chainName = (id: number | undefined) =>
  id === undefined ? "—" : (networkById(id)?.name ?? `Chain ${id}`);
export const explorerTransactionUrl = (chainId: number, hash?: string) => transactionUrl(networks, chainId, hash);

const STORAGE_KEY = "xtomb:selected-chain";

function initialSelection(): number {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (networkById(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return PRIMARY.id;
}

const NetworkContext = createContext<{ selected: number; select: (id: number) => void }>({
  selected: PRIMARY.id,
  select: () => {},
});

/** The network the visitor is looking at while no wallet (or an unsupported one) is connected. */
export function NetworkProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<number>(initialSelection);
  const select = useCallback((id: number) => {
    if (!networkById(id)) return;
    setSelected(id);
    try {
      localStorage.setItem(STORAGE_KEY, String(id));
    } catch {
      /* storage unavailable */
    }
  }, []);
  const value = useMemo(() => ({ selected, select }), [selected, select]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export const useSelectedNetwork = () => useContext(NetworkContext);
