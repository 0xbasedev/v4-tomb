import { useAccount, useChainId } from "wagmi";
import { networks } from "@/lib/networks";

export function NetworkStatus() {
  const selectedChain = useChainId();
  const { chainId, isConnected } = useAccount();
  const network = networks.find((entry) => entry.id === (isConnected ? chainId : selectedChain));
  if (network?.deployment) return null;
  return (
    <div role="status" className="border-b border-deco-gold/30 px-6 py-3 text-center font-body text-deco-ivory-soft">
      {network
        ? `${network.name} has no protocol deployment configured. You can browse the protocol; transactions are unavailable.`
        : "Your wallet is on an unsupported network. Select a configured network to continue."}
    </div>
  );
}
