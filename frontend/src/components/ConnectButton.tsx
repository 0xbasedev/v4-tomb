import { useAccount, useConnect, useDisconnect } from "wagmi";

/**
 * Minimal connect button styled to the eighties grammar. Uses Wagmi's injected
 * connector (typically MetaMask / browser-injected wallet). Replace with RainbowKit
 * or a multi-wallet picker later.
 */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        className="btn-hard bg-miami-yellow text-miami-night shadow-hard-pink hover:shadow-hard-teal"
      >
        <span>{address.slice(0, 6)}…{address.slice(-4)}</span>
      </button>
    );
  }

  const connector = connectors[0];
  return (
    <button
      onClick={() => connector && connect({ connector })}
      disabled={isPending || !connector}
      className="btn-hard bg-miami-pink text-miami-ground shadow-hard-teal disabled:opacity-50"
    >
      {isPending ? "CONNECTING…" : "CONNECT WALLET"}
    </button>
  );
}
