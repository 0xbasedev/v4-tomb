import { PRIMARY, liveDeployment, useSelectedNetwork } from "@/lib/networks";
import { useAccount } from "wagmi";
import type { Address } from "viem";

import type { MasonryDeployment } from "@config/masonry-deployment.mjs";
import { bridgeNetwork } from "@/lib/create3";
import { PREVIEW_ADDRESS, usePreview } from "@/lib/preview";
import { chainName } from "@/lib/wagmi";

/**
 * Where the app stands, in one place:
 *
 *   preview      no verified deployment (or ?preview=1): sample data, simulated
 *                actions, zero wallet transaction requests.
 *   disconnected live mode, no wallet.
 *   unsupported  the wallet's chain has no Uniswap v4 PoolManager with native
 *                USDC in config/official-infrastructure.json.
 *   undeployed   a supported chain with no verified xTOMB deployment.
 *   ready        a verified deployment on the wallet's chain.
 *
 * `canTransact` is true only for `ready`. Every disabled action reads `reason`.
 * The wallet's own network is reported in Preview too, so the header can warn
 * about an unsupported chain before anything goes live.
 */
export type NetworkStatus = "preview" | "disconnected" | "unsupported" | "undeployed" | "ready";

export interface NetworkState {
  status: NetworkStatus;
  preview: boolean;
  /** The account shown on screen: the sample wallet in Preview, else the connected one. */
  account: Address | null;
  walletConnected: boolean;
  walletAddress: Address | null;
  walletChainId: number | undefined;
  walletChainSupported: boolean;
  deployment: MasonryDeployment | null;
  canTransact: boolean;
  /** Why actions are disabled (null when they aren't). */
  reason: string | null;
  /** One line for the network note under the header. */
  message: string;
}

export function useNetworkStatus(): NetworkState {
  const preview = usePreview();
  const { address, isConnected, chainId } = useAccount();
  const { selected } = useSelectedNetwork();
  const supported = chainId === PRIMARY.id && selected === chainId;
  const deployment = chainId !== undefined ? liveDeployment(chainId) : null;
  const walletAddress = isConnected && address ? address : null;

  const bridgeOnly = !supported && bridgeNetwork(chainId) !== null;
  const walletLine = !isConnected
    ? null
    : bridgeOnly
      ? `${chainName(chainId)} is an xSHARE bridge network (planned), not a Masonry launch chain. xTOMB needs a chain with a Uniswap v4 PoolManager and native USDC.`
      : !supported
      ? `Your wallet is on an unsupported network (${chainName(chainId)}). xTOMB needs a chain with a Uniswap v4 PoolManager and native USDC.`
      : !deployment
        ? `${chainName(chainId)} has no verified xTOMB deployment yet. Transactions are unavailable.`
        : null;

  if (preview.enabled) {
    return {
      status: "preview",
      preview: true,
      // A real wallet still sees sample data in Preview — every panel says so.
      account: walletAddress ?? (preview.sampleWallet ? PREVIEW_ADDRESS : null),
      walletConnected: isConnected,
      walletAddress,
      walletChainId: chainId,
      walletChainSupported: supported,
      deployment: null,
      canTransact: false,
      reason: null,
      message: walletLine
        ? `${walletLine} Showing simulated data.`
        : "Preview · simulated data. No verified xTOMB deployment exists yet, so actions are simulated and nothing is sent to a wallet.",
    };
  }

  const status: NetworkStatus = !isConnected ? "disconnected" : !supported ? "unsupported" : !deployment ? "undeployed" : "ready";
  const reason =
    status === "disconnected"
      ? "Connect a wallet to continue."
      : status === "unsupported"
        ? "Switch to a supported network."
        : status === "undeployed"
          ? `No verified xTOMB deployment on ${chainName(chainId)}.`
          : null;
  return {
    status,
    preview: false,
    account: walletAddress,
    walletConnected: isConnected,
    walletAddress,
    walletChainId: chainId,
    walletChainSupported: supported,
    deployment: status === "ready" ? deployment : null,
    canTransact: status === "ready",
    reason,
    message:
      status === "ready"
        ? `${chainName(chainId)} · verified deployment from block ${deployment!.deployBlock}.`
        : status === "disconnected"
          ? "Wallet disconnected. Connect a wallet on a supported network to read live protocol state."
          : walletLine!,
  };
}
