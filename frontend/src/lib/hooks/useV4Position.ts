import { useReadContracts } from "wagmi";
import { zeroAddress, type Abi, type Address } from "viem";

import { positionManagerAbi, positionWrapperAbi } from "@/lib/abis";
import type { ProtocolDeployment } from "@/lib/addresses";
import { ok, results, type ReadCall } from "./reads";

/**
 * One Uniswap V4 position NFT, checked against one wrapper: who owns it, how
 * much liquidity it holds, and whether this wrapper already holds it (and for whom).
 */
export function useV4Position(d: ProtocolDeployment | null, wrapper: Address | null, tokenIdRaw: string, account: Address | null) {
  let tokenId: bigint | null = null;
  if (/^\d+$/.test(tokenIdRaw.trim())) tokenId = BigInt(tokenIdRaw.trim());
  const enabled = !!d && !!wrapper && tokenId !== null;

  const read = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? ([
          { address: d!.positionManager, abi: positionManagerAbi as Abi, functionName: "ownerOf", args: [tokenId], chainId: d!.chainId },
          { address: d!.positionManager, abi: positionManagerAbi as Abi, functionName: "getPositionLiquidity", args: [tokenId], chainId: d!.chainId },
          { address: wrapper!, abi: positionWrapperAbi as Abi, functionName: "wrappedBy", args: [tokenId], chainId: d!.chainId },
          { address: wrapper!, abi: positionWrapperAbi as Abi, functionName: "wrappedLiquidity", args: [tokenId], chainId: d!.chainId },
        ] as ReadCall[])
      : [],
    query: { enabled, refetchInterval: 15_000 },
  });
  const r = results(read.data);
  const owner = ok<Address>(r[0]);
  const wrappedBy = ok<Address>(r[2]);
  const eq = (a: Address | undefined, b: Address | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  return {
    tokenId,
    loading: enabled && !read.isFetched,
    exists: !!owner,
    liquidity: ok<bigint>(r[1]) ?? 0n,
    /** The connected wallet holds the NFT. */
    isOwner: eq(owner, account),
    /** This wrapper holds the NFT. */
    isWrapped: !!wrappedBy && wrappedBy !== zeroAddress,
    /** The connected wallet is the one that wrapped it — the only address that can unwrap. */
    isWrapper: eq(wrappedBy, account),
    wrappedLiquidity: ok<bigint>(r[3]) ?? 0n,
  };
}
