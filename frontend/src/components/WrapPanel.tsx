import { useEffect, useRef, useState } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";

import { lpWrapperAbi, positionManagerAbi } from "@/lib/abis";
import { useDeployment, useV4Position } from "@/lib/hooks";
import { useToast } from "@/components/ToastProvider";

/**
 * WrapPanel — converts a V4 MONEY-WETH LP NFT into wrapper ERC-20 share
 * certificates. Used on the Main + Share tabs of /vault.
 *
 * Flow:
 *   1. User pastes a tokenId.
 *   2. We read ownerOf / getApproved / getPositionLiquidity / wrappedBy to
 *      surface a precise status line (owns it, already wrapped, wrong pool,
 *      not yet approved, etc.).
 *   3. CTA cycles: Connect → Approve → Wrap → Already Wrapped.
 *      Approve is positionManager.approve(wrapper, tokenId) — ERC-721 single-
 *      NFT approval, distinct from ERC-20 approve. wrap is wrapper.wrap(tokenId).
 *   4. After wrap, the user holds wrapper.balanceOf shares equal to position
 *      liquidity. The Make-a-Deposit ActionPanel can stake those shares.
 */

interface WrapPanelProps {
  /** Title shown above the panel — varies by pool tab ("Main" / "Share"). */
  poolName: string;
  /**
   * Optional: pre-fill the input with this tokenId. Vault wires this from
   * the MintPositionPanel's onMinted so a fresh mint flows straight into wrap.
   * Uses a useEffect to react when the value changes; doesn't clobber the
   * user's input if they're actively typing.
   */
  prefillTokenId?: bigint | null;
}

export function WrapPanel({ poolName, prefillTokenId }: WrapPanelProps) {
  const deployment = useDeployment();
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const [tokenIdInput, setTokenIdInput] = useState("");
  const lastPrefillRef = useRef<bigint | null>(null);

  // How many V4 LP NFTs does the connected wallet hold? Surfaced as a hint so
  // users know whether they have positions to wrap before they start hunting
  // for a tokenId. Doesn't enumerate the tokenIds themselves (PositionManager
  // isn't ERC-721 Enumerable) — Sprint C polish would scan Transfer events.
  const nftCountRead = useReadContract({
    address: deployment?.positionManager,
    abi: positionManagerAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!deployment && !!address, refetchInterval: 15_000 },
  });
  const nftCount = nftCountRead.data ?? 0n;

  // When the parent hands us a fresh tokenId from a successful mint, fill the
  // input. Tracked with a ref to fire only once per new value — re-runs across
  // re-renders for the same prefill don't clobber user edits.
  useEffect(() => {
    if (prefillTokenId !== undefined && prefillTokenId !== null && prefillTokenId !== lastPrefillRef.current) {
      lastPrefillRef.current = prefillTokenId;
      setTokenIdInput(prefillTokenId.toString());
    }
  }, [prefillTokenId]);

  const pos = useV4Position(tokenIdInput);

  // Two-step write — approve(positionManager) then wrap(wrapper). Each has its
  // own writeContract since the targets differ.
  const approve = useWriteContract();
  const wrap = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data });
  const wrapReceipt = useWaitForTransactionReceipt({ hash: wrap.data });

  // Surface tx outcomes as toasts. Tracked refs prevent re-toasting on rerender.
  const [approveToastId, setApproveToastId] = useState<string | null>(null);
  const [wrapToastId, setWrapToastId] = useState<string | null>(null);

  useEffect(() => {
    if (approve.data && approveToastId === null) {
      const id = toast.push({
        variant: "pending",
        title: "Approve NFT",
        message: "Awaiting confirmation.",
      });
      setApproveToastId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approve.data]);

  useEffect(() => {
    if (approveReceipt.isSuccess && approveToastId) {
      toast.update(approveToastId, {
        variant: "success",
        title: "Approval Confirmed",
        message: "Submit the wrap now to mint your share certificate.",
        txHash: approve.data,
      });
      pos.refetch();
    }
    if (approveReceipt.isError && approveToastId) {
      toast.update(approveToastId, {
        variant: "error",
        title: "Approval Reverted",
        message: approve.error?.message?.split("\n")[0]?.slice(0, 120) ?? "Reverted",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt.isSuccess, approveReceipt.isError]);

  useEffect(() => {
    if (wrap.data && wrapToastId === null) {
      const id = toast.push({
        variant: "pending",
        title: "Wrap Position",
        message: "Awaiting confirmation.",
      });
      setWrapToastId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrap.data]);

  useEffect(() => {
    if (wrapReceipt.isSuccess && wrapToastId) {
      toast.update(wrapToastId, {
        variant: "success",
        title: "Wrap Confirmed",
        message: "Wrapper shares are now in your wallet. You may deposit below.",
        txHash: wrap.data,
      });
      pos.refetch();
      // Reset the input so the user can wrap another or move on
      setTokenIdInput("");
    }
    if (wrapReceipt.isError && wrapToastId) {
      toast.update(wrapToastId, {
        variant: "error",
        title: "Wrap Reverted",
        message: wrap.error?.message?.split("\n")[0]?.slice(0, 120) ?? "Reverted",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapReceipt.isSuccess, wrapReceipt.isError]);

  // Status line — most useful piece of feedback. Tells the user exactly what
  // state their tokenId is in.
  let statusLine = "Paste a V4 LP token ID to inspect it.";
  let canApprove = false;
  let canWrap = false;

  if (tokenIdInput.trim() !== "" && deployment && pos.tokenId !== null) {
    if (pos.isLoading) {
      statusLine = "Reading position…";
    } else if (!pos.exists) {
      statusLine = "Token ID not found on the V4 PositionManager.";
    } else if (pos.isAlreadyWrapped) {
      statusLine = "Already wrapped. The wrapper holds this NFT.";
    } else if (!pos.isOwner) {
      statusLine = `Position is owned by ${pos.owner?.slice(0, 6)}…${pos.owner?.slice(-4)}, not your wallet.`;
    } else if (pos.liquidity === 0n) {
      statusLine = "Position has zero liquidity — cannot wrap an empty NFT.";
    } else if (pos.isApproved) {
      statusLine = `Approved. Ready to wrap ${pos.liquidity.toString()} liquidity into shares.`;
      canWrap = true;
    } else {
      statusLine = `Owned, with ${pos.liquidity.toString()} liquidity. Approve, then wrap.`;
      canApprove = true;
    }
  }

  const disabled =
    !deployment ||
    approve.isPending ||
    approveReceipt.isLoading ||
    wrap.isPending ||
    wrapReceipt.isLoading;

  return (
    <div className="deco-panel">
      <div className="label-deco mb-3 text-deco-gold-dark">Mint a Wrap Certificate</div>
      <h2
        className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl"
        style={{ letterSpacing: "0.06em" }}
      >
        Wrap your MONEY · WETH Position
      </h2>
      <div className="mx-auto mb-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
      <p className="mb-4 mx-auto max-w-xl font-body text-sm italic text-deco-ivory-soft">
        The {poolName} accepts only the wrapper's ERC-20 share certificate. Provide
        the token ID of your full-range MONEY-WETH V4 LP, and the wrapper will
        mint you shares equal to its liquidity. Mint a position above if you do
        not yet hold one.
      </p>

      {/* Wallet-context strip: shows how many V4 LP NFTs the wallet owns,
          or a 'connect' nudge when no wallet is connected. */}
      <div className="mb-6 flex items-center justify-center gap-3 border border-deco-gold/30 bg-deco-ground-soft px-4 py-2">
        {!isConnected ? (
          <span className="label-deco text-deco-gold-dark">
            Connect a wallet on Base Sepolia to inspect your positions
          </span>
        ) : (
          <>
            <span className="label-deco text-deco-gold-dark">Your V4 LP NFTs</span>
            <span className="font-display text-base italic text-deco-ivory">
              {nftCount.toString()}
            </span>
            {nftCount === 0n && (
              <span className="font-body text-xs italic text-deco-gold-dark">
                · mint a position above
              </span>
            )}
          </>
        )}
      </div>

      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="label-deco text-deco-gold-dark">V4 LP Token ID</span>
      </div>
      <div className="mb-4 flex items-center border border-deco-gold/50 bg-deco-ground focus-within:border-deco-gold">
        <input
          type="text"
          inputMode="numeric"
          placeholder="e.g. 23347"
          value={tokenIdInput}
          onChange={(e) => setTokenIdInput(e.target.value.replace(/[^\d]/g, ""))}
          disabled={disabled}
          aria-label="V4 LP token ID"
          className="font-display w-full bg-transparent px-4 py-3 text-right text-2xl text-deco-ivory placeholder:text-deco-gold-dark/40 focus:outline-none disabled:opacity-50"
        />
      </div>

      <p className="mb-5 min-h-[1.5em] text-center font-body text-sm italic text-deco-ivory-soft">
        {statusLine}
      </p>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => {
            if (!deployment || pos.tokenId === null) return;
            approve.writeContract({
              address: deployment.positionManager,
              abi: positionManagerAbi,
              functionName: "approve",
              args: [deployment.lpWrapper, pos.tokenId],
            });
          }}
          disabled={!canApprove || disabled}
          className="btn-deco flex-1 justify-center disabled:cursor-not-allowed disabled:opacity-40"
        >
          {approve.isPending || approveReceipt.isLoading ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!deployment || pos.tokenId === null) return;
            setWrapToastId(null);
            wrap.writeContract({
              address: deployment.lpWrapper,
              abi: lpWrapperAbi,
              functionName: "wrap",
              args: [pos.tokenId],
            });
          }}
          disabled={!canWrap || disabled}
          className="btn-deco btn-deco-primary flex-1 justify-center disabled:cursor-not-allowed disabled:opacity-40"
        >
          {wrap.isPending || wrapReceipt.isLoading ? "Wrapping…" : "Wrap"}
        </button>
      </div>
    </div>
  );
}
