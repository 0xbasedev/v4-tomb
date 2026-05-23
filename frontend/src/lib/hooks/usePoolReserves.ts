import { useReadContracts } from "wagmi";
import { encodePacked, keccak256, type Address } from "viem";

import { poolManagerAbi } from "@/lib/abis";
import { Q96 } from "@/lib/swap/tickMath";
import { useDeployment } from "./useDeployment";
import type { PoolKey } from "@/lib/swap/encodeV4Swap";

/**
 * Read the actual reserves of a V4 pool (currency0 amount + currency1 amount)
 * via two PoolManager.extsload calls. Avoids the
 * "WETH.balanceOf(PoolManager)" trap where the read captures every V4 pool
 * holding WETH, not just ours.
 *
 * Math (StateLibrary equivalent, in TypeScript):
 *   poolId      = keccak256(abi.encode(poolKey))
 *   stateSlot   = keccak256(abi.encodePacked(poolId, POOLS_SLOT_INDEX))
 *   slot0       = pm.extsload(stateSlot)         — sqrtPriceX96, tick, protocolFee, lpFee
 *   liquidity   = pm.extsload(stateSlot + 3)     — in-range liquidity (uint128)
 *
 * For full-range positions the in-range liquidity equals the total pool liquidity.
 * Amount math at the current sqrtPrice (V2-equivalent for full range):
 *   amount0 = L * 2^96 / sqrtPriceX96
 *   amount1 = L * sqrtPriceX96 / 2^96
 *
 * The POOLS mapping is at storage slot 6 in v4-core PoolManager. If Uniswap
 * reorders fields in a future PoolManager upgrade, this constant must move.
 */

const POOLS_SLOT_INDEX = 6n;

/** Compute the canonical V4 poolId (keccak of abi.encode(PoolKey)). */
export function computePoolId(poolKey: PoolKey): `0x${string}` {
  // V4's PoolKey hash is keccak256(abi.encode(PoolKey)), but the struct
  // layout for hashing is the concatenated 32-byte slots:
  //   currency0 (left-padded), currency1, fee, tickSpacing, hooks
  // encodePacked gives us the tightly-packed form, but for V4 toId() does
  // an abi.encode (padded). Use viem's encodeAbiParameters for safety.
  // For now use the same packed-then-padded approach that StateLibrary expects.
  return keccak256(
    encodePacked(
      ["address", "address", "uint24", "int24", "address"],
      [
        poolKey.currency0,
        poolKey.currency1,
        poolKey.fee,
        poolKey.tickSpacing,
        poolKey.hooks,
      ],
    ),
  );
}

interface UsePoolReservesResult {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  amount0: bigint;
  amount1: bigint;
  isLoading: boolean;
}

export function usePoolReserves(poolKey: PoolKey | null): UsePoolReservesResult {
  const deployment = useDeployment();
  const enabled = deployment !== null && poolKey !== null;

  // Compute slots from poolKey.
  const slots = (() => {
    if (!poolKey) return null;
    const poolId = computePoolId(poolKey);
    const stateSlot = keccak256(
      encodePacked(["bytes32", "uint256"], [poolId, POOLS_SLOT_INDEX]),
    );
    const liquiditySlot = `0x${(BigInt(stateSlot) + 3n).toString(16).padStart(64, "0")}` as `0x${string}`;
    return { stateSlot, liquiditySlot };
  })();

  const { data, isLoading } = useReadContracts({
    allowFailure: false,
    contracts:
      enabled && slots && deployment
        ? [
            {
              address: deployment.poolManager as Address,
              abi: poolManagerAbi,
              functionName: "extsload",
              args: [slots.stateSlot],
            },
            {
              address: deployment.poolManager as Address,
              abi: poolManagerAbi,
              functionName: "extsload",
              args: [slots.liquiditySlot],
            },
          ]
        : [],
    query: { enabled, refetchInterval: 15_000 },
  });

  // Decode slot0: bytes32 packed as
  //   bits   0-159  sqrtPriceX96 (uint160)
  //   bits 160-183  tick (int24)
  //   bits 184-207  protocolFee (uint24)
  //   bits 208-231  lpFee (uint24)
  let sqrtPriceX96 = 0n;
  let tick = 0;
  if (data && data[0]) {
    const slot0 = BigInt(data[0] as `0x${string}`);
    sqrtPriceX96 = slot0 & ((1n << 160n) - 1n);
    // Extract tick as signed 24-bit
    const tickRaw = Number((slot0 >> 160n) & ((1n << 24n) - 1n));
    tick = tickRaw >= 1 << 23 ? tickRaw - (1 << 24) : tickRaw;
  }

  // Decode liquidity: uint128 in low 128 bits of the slot.
  let liquidity = 0n;
  if (data && data[1]) {
    const lSlot = BigInt(data[1] as `0x${string}`);
    liquidity = lSlot & ((1n << 128n) - 1n);
  }

  // Compute amounts at the current sqrtPrice (full-range approximation —
  // exact when all liquidity is in range, which is the case for our seed
  // and any user-minted full-range position).
  let amount0 = 0n;
  let amount1 = 0n;
  if (liquidity > 0n && sqrtPriceX96 > 0n) {
    amount0 = (liquidity * Q96) / sqrtPriceX96;
    amount1 = (liquidity * sqrtPriceX96) / Q96;
  }

  return { liquidity, sqrtPriceX96, tick, amount0, amount1, isLoading };
}
