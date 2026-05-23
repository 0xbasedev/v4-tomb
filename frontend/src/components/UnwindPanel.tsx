import { useEffect, useRef, useState } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";

import { lpWrapperAbi, positionManagerAbi } from "@/lib/abis";
import { useDeployment } from "@/lib/hooks";
import { useToast } from "@/components/ToastProvider";
import { encodeBurnPosition } from "@/lib/swap/encodeBurnPosition";

/**
 * UnwindPanel — the inverse of MintPositionPanel + WrapPanel. Two actions
 * stacked, one panel:
 *
 *   1. Unwrap: wrapper.unwrap(tokenId) — burns your wrapper shares, returns
 *      the V4 LP NFT to your wallet.
 *   2. Burn:   positionManager.modifyLiquidities(BURN_POSITION + TAKE_PAIR)
 *      — burns the LP position, transfers the underlying MONEY + WETH back
 *      to your wallet.
 *
 * Status line reads on-chain state and tells the user which step is next:
 *   - "Wrapper holds this NFT. Unwrap to reclaim it."
 *   - "You own this NFT. Burn it to recover the underlying MONEY + WETH."
 *   - "Already burned" / "Owned by someone else" / etc.
 *
 * Each action is a single wallet pop. Slippage on the burn defaults to 0n
 * (accept any positive output) — fine for testnet, mainnet polish can
 * compute a tighter min based on current spot.
 */

interface UnwindPanelProps {
  poolName: string;
  /**
   * Optional: pre-fill the tokenId input. Vault wires this to the same shared
   * `recentTokenId` state that MintPositionPanel and WrapPanel use, so the
   * unwind step picks up whatever NFT the user has been working with —
   * mint → wrap → stake → withdraw → unwrap → burn flows on one prefill.
   */
  prefillTokenId?: bigint | null;
}

export function UnwindPanel({ poolName, prefillTokenId }: UnwindPanelProps) {
  const deployment = useDeployment();
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const [tokenIdInput, setTokenIdInput] = useState("");
  const lastPrefillRef = useRef<bigint | null>(null);

  // Same prefill pattern as WrapPanel — react once per new value via ref
  // so we don't clobber edits the user is actively making.
  useEffect(() => {
    if (
      prefillTokenId !== undefined &&
      prefillTokenId !== null &&
      prefillTokenId !== lastPrefillRef.current
    ) {
      lastPrefillRef.current = prefillTokenId;
      setTokenIdInput(prefillTokenId.toString());
    }
  }, [prefillTokenId]);

  // Parse tokenId from input.
  let tokenId: bigint | null = null;
  if (tokenIdInput.trim() !== "") {
    try {
      tokenId = BigInt(tokenIdInput.trim());
    } catch {
      tokenId = null;
    }
  }

  const enabled = !!deployment && !!address && tokenId !== null;

  // Read who owns the NFT + whether it's still wrapped.
  const ownerRead = useReadContract({
    address: deployment?.positionManager,
    abi: positionManagerAbi,
    functionName: "ownerOf",
    args: tokenId !== null ? [tokenId] : undefined,
    query: { enabled, refetchInterval: 15_000 },
  });
  const wrappedByRead = useReadContract({
    address: deployment?.lpWrapper,
    abi: lpWrapperAbi,
    functionName: "wrappedBy",
    args: tokenId !== null ? [tokenId] : undefined,
    query: { enabled, refetchInterval: 15_000 },
  });

  const owner = ownerRead.data as `0x${string}` | undefined;
  const wrappedBy = wrappedByRead.data as `0x${string}` | undefined;

  const wrapperHoldsIt =
    !!owner && !!deployment && owner.toLowerCase() === deployment.lpWrapper.toLowerCase();
  const youOwnIt =
    !!owner && !!address && owner.toLowerCase() === address.toLowerCase();
  const youWrapped =
    !!wrappedBy && !!address && wrappedBy.toLowerCase() === address.toLowerCase();

  // Two independent write hooks because the two actions target different
  // contracts. Each has its own receipt watcher.
  const unwrap = useWriteContract();
  const burn = useWriteContract();
  const unwrapReceipt = useWaitForTransactionReceipt({ hash: unwrap.data });
  const burnReceipt = useWaitForTransactionReceipt({ hash: burn.data });
  const unwrapToastId = useRef<string | null>(null);
  const burnToastId = useRef<string | null>(null);

  useEffect(() => {
    if (unwrap.data && unwrapToastId.current === null) {
      unwrapToastId.current = toast.push({
        variant: "pending",
        title: "Unwrap Position",
        message: "Awaiting confirmation.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unwrap.data]);

  useEffect(() => {
    if (unwrapReceipt.isSuccess && unwrapToastId.current) {
      toast.update(unwrapToastId.current, {
        variant: "success",
        title: "Unwrap Confirmed",
        message: "NFT returned to your wallet. Burn below to recover MONEY + WETH.",
        txHash: unwrap.data,
      });
      ownerRead.refetch();
      wrappedByRead.refetch();
    }
    if (unwrapReceipt.isError && unwrapToastId.current) {
      toast.update(unwrapToastId.current, {
        variant: "error",
        title: "Unwrap Reverted",
        message: unwrap.error?.message?.split("\n")[0]?.slice(0, 120) ?? "Reverted",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unwrapReceipt.isSuccess, unwrapReceipt.isError]);

  useEffect(() => {
    if (burn.data && burnToastId.current === null) {
      burnToastId.current = toast.push({
        variant: "pending",
        title: "Burn Position",
        message: "Awaiting confirmation.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burn.data]);

  useEffect(() => {
    if (burnReceipt.isSuccess && burnToastId.current) {
      toast.update(burnToastId.current, {
        variant: "success",
        title: "Burn Confirmed",
        message: "Position closed. MONEY + WETH are in your wallet.",
        txHash: burn.data,
      });
      ownerRead.refetch();
      wrappedByRead.refetch();
      setTokenIdInput("");
    }
    if (burnReceipt.isError && burnToastId.current) {
      toast.update(burnToastId.current, {
        variant: "error",
        title: "Burn Reverted",
        message: burn.error?.message?.split("\n")[0]?.slice(0, 120) ?? "Reverted",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burnReceipt.isSuccess, burnReceipt.isError]);

  // Status line drives the user's "what's next" mental model.
  let statusLine = "Paste a V4 LP token ID to inspect.";
  let canUnwrap = false;
  let canBurn = false;

  if (tokenIdInput.trim() !== "" && tokenId !== null && deployment) {
    if (ownerRead.isLoading) {
      statusLine = "Reading position…";
    } else if (ownerRead.isError) {
      statusLine = "Token ID not found on the V4 PositionManager.";
    } else if (wrapperHoldsIt) {
      if (youWrapped) {
        statusLine = "Wrapper holds this NFT. Unwrap to reclaim it.";
        canUnwrap = true;
      } else {
        statusLine = "Wrapper holds this NFT, but it was wrapped by someone else.";
      }
    } else if (youOwnIt) {
      statusLine = "You own this NFT. Burn it to recover the underlying MONEY + WETH.";
      canBurn = true;
    } else {
      statusLine = `NFT is owned by ${owner?.slice(0, 6)}…${owner?.slice(-4)}, not you.`;
    }
  }

  const disabledShared =
    !isConnected || unwrap.isPending || unwrapReceipt.isLoading || burn.isPending || burnReceipt.isLoading;

  function handleUnwrap() {
    if (!deployment || tokenId === null) return;
    unwrapToastId.current = null;
    unwrap.writeContract({
      address: deployment.lpWrapper,
      abi: lpWrapperAbi,
      functionName: "unwrap",
      args: [tokenId],
    });
  }

  function handleBurn() {
    if (!deployment || !address || tokenId === null) return;
    const wethIsToken0 =
      (deployment.weth as string).toLowerCase() < (deployment.money as string).toLowerCase();
    const c0 = wethIsToken0 ? deployment.weth : deployment.money;
    const c1 = wethIsToken0 ? deployment.money : deployment.weth;
    burnToastId.current = null;
    const unlockData = encodeBurnPosition({
      tokenId,
      amount0Min: 0n,
      amount1Min: 0n,
      currency0: c0,
      currency1: c1,
      recipient: address,
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
    burn.writeContract({
      address: deployment.positionManager,
      abi: positionManagerAbi,
      functionName: "modifyLiquidities",
      args: [unlockData, deadline],
    });
  }

  return (
    <div className="deco-panel">
      <div className="label-deco mb-3 text-deco-gold-dark">Unwind a Position</div>
      <h2
        className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl"
        style={{ letterSpacing: "0.06em" }}
      >
        Reclaim Your MONEY + WETH
      </h2>
      <div className="mx-auto mb-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
      <p className="mb-6 mx-auto max-w-xl font-body text-sm italic text-deco-ivory-soft">
        Two steps to fully exit a {poolName} position. First withdraw your
        wrapper shares above (returns them to your wallet), then <em>unwrap</em>
        (returns the NFT), then <em>burn</em> (returns the underlying MONEY +
        WETH). Each step is one wallet signature; no approvals required.
      </p>

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
          disabled={disabledShared}
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
          onClick={handleUnwrap}
          disabled={!canUnwrap || disabledShared}
          className="btn-deco flex-1 justify-center disabled:cursor-not-allowed disabled:opacity-40"
        >
          {unwrap.isPending || unwrapReceipt.isLoading ? "Unwrapping…" : "Unwrap"}
        </button>
        <button
          type="button"
          onClick={handleBurn}
          disabled={!canBurn || disabledShared}
          className="btn-deco btn-deco-primary flex-1 justify-center disabled:cursor-not-allowed disabled:opacity-40"
        >
          {burn.isPending || burnReceipt.isLoading ? "Burning…" : "Burn · Reclaim Tokens"}
        </button>
      </div>
    </div>
  );
}
