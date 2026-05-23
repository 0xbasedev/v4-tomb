import { useAccount, useConnect, useDisconnect } from "wagmi";

/**
 * ConnectButton — Art Deco. Gold-framed, label-typography, formal voice.
 * When connected: shows truncated address with a small gold dot indicator.
 */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button onClick={() => disconnect()} className="btn-deco">
        <span className="inline-block h-2 w-2 rotate-45 bg-deco-gold" aria-hidden />
        <span>
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
      </button>
    );
  }

  const connector = connectors[0];
  return (
    <button
      onClick={() => connector && connect({ connector })}
      disabled={isPending || !connector}
      className="btn-deco disabled:opacity-50"
    >
      {isPending ? "Awaiting…" : "Enter The Trust"}
    </button>
  );
}
