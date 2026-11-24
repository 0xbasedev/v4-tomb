import { useAccount } from "wagmi";
import type { Address } from "viem";

import { getDeployment, type ProtocolDeployment } from "@/lib/addresses";
import { chainName, networkById, useSelectedNetwork, type ManifestNetwork } from "@/lib/networks";

/**
 *   disconnected  no wallet — reads still run on the selected network if it has a deployment
 *   unsupported   wallet is on a chain that is not in config/networks.json
 *   undeployed    wallet is on a manifest network that has no deployment
 *   ready         wallet is on a manifest network with a deployment — the only state that can transact
 */
export type NetworkStatus = "disconnected" | "unsupported" | "undeployed" | "ready";

export interface NetworkState {
  status: NetworkStatus;
  /** The manifest network in view: the wallet's when it is supported, otherwise the selected one. */
  network: ManifestNetwork;
  /** Deployment of the network in view. null → every protocol read and write is off. */
  deployment: ProtocolDeployment | null;
  account: Address | null;
  walletConnected: boolean;
  walletChainId: number | undefined;
  walletChainSupported: boolean;
  canTransact: boolean;
  /** Why an action is unavailable, in one sentence. null when it is available. */
  reason: string | null;
  /** The line shown under the header. */
  message: string;
}

export function useNetworkStatus(): NetworkState {
  const { address, isConnected, chainId } = useAccount();
  const { selected } = useSelectedNetwork();

  const walletNetwork = isConnected ? networkById(chainId) : undefined;
  const network = walletNetwork ?? networkById(selected)!;
  const deployment = getDeployment(network.id);
  const account = isConnected && address ? address : null;

  const status: NetworkStatus = !isConnected
    ? "disconnected"
    : !walletNetwork
      ? "unsupported"
      : !deployment
        ? "undeployed"
        : "ready";

  const undeployed = `${network.name} has no protocol deployment configured.`;
  const reason =
    status === "unsupported"
      ? `Switch your wallet to ${network.name}.`
      : !deployment
        ? `Not deployed on ${network.name} — nothing to transact with yet.`
        : status === "disconnected"
          ? "Connect a wallet to continue."
          : null;

  const message =
    status === "unsupported"
      ? `Your wallet is on an unsupported network (${chainName(chainId)}). Switch to ${network.name} to continue.`
      : !deployment
        ? `${undeployed} Prices, balances and actions stay off until a deployment is published in config/networks.json.`
        : status === "disconnected"
          ? `Reading live state from ${network.name}. Connect a wallet to act.`
          : `${network.name} · deployment from block ${deployment.deployBlock}.`;

  return {
    status,
    network,
    deployment,
    account,
    walletConnected: isConnected,
    walletChainId: chainId,
    walletChainSupported: !!walletNetwork,
    canTransact: status === "ready",
    reason,
    message,
  };
}
