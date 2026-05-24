import { useAccount, useConnect, useDisconnect } from "wagmi";

/**
 * ConnectButton — Art Deco.
 *
 * Two visually distinct states (intentional — the disconnected state is a
 * primary CTA, the connected state is a status pill, not something we want
 * to draw the eye to):
 *
 *   Disconnected:  big btn-deco "Enter The Trust" — formal CTA, gold-framed,
 *                   fills on hover. This is the action.
 *   Connected:     compact chip — gold dot + truncated address inside a small
 *                   gold-outlined box. Stays outlined on hover (no fill).
 *                   Clicking disconnects. This is just an indicator.
 *
 * Earlier version used the same btn-deco for both states. After connecting,
 * mouse remained over the button → hover fill activated → the connected pill
 * appeared dramatically larger than the disconnected CTA. Splitting the
 * styles fixes the perceived size jump.
 */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        title="Click to disconnect"
        className="label-deco flex items-center gap-2 border border-deco-gold/50 bg-deco-ground px-3 py-2 text-deco-gold transition-colors hover:border-deco-gold hover:text-deco-gold-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-deco-gold"
      >
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
