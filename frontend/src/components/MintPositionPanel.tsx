import { useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";

import { erc20Abi, hookAbi } from "@/lib/abis";
import { useDeployment, useMintPosition } from "@/lib/hooks";
import { formatToken } from "@/lib/format";
import { maskDecimalInput } from "@/lib/util/decimal";
import { getSqrtPriceAtTick, minUsableTick, maxUsableTick } from "@/lib/swap/tickMath";
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
} from "@/lib/swap/liquidityMath";

/**
 * MintPositionPanel — provide MONEY + WETH amounts → mint a full-range V4 LP NFT.
 *
 * Full range only (tickSpacing 60 → ±887220). This matches the V4PositionWrapper's
 * exact-range requirement: only positions at this canonical range can be wrapped.
 *
 * UX: user types either MONEY or WETH; the partner amount auto-populates at the
 * current pool ratio. Liquidity is computed client-side via the TickMath +
 * LiquidityAmounts ports.
 *
 * On confirmation the user holds a new V4 NFT in their wallet. The WrapPanel
 * below this on /vault is the next step in the chain.
 */

const TICK_SPACING = 60;
const DYNAMIC_FEE_FLAG = 0x800000;

interface MintPositionPanelProps {
  poolName: string;
  /**
   * Called when a mint receipt confirms with the parsed tokenId. The Vault
   * uses this to hand the tokenId straight to the WrapPanel below, so the
   * user doesn't have to copy/paste from BaseScan.
   */
  onMinted?: (tokenId: bigint) => void;
}

export function MintPositionPanel({ poolName, onMinted }: MintPositionPanelProps) {
  const deployment = useDeployment();
  const { address } = useAccount();
  const mint = useMintPosition();

  // Driver: which side the user typed last.
  const [driver, setDriver] = useState<"money" | "weth">("money");
  const [moneyInput, setMoneyInput] = useState("");
  const [wethInput, setWethInput] = useState("");

  // Live reads — current tick (drives sqrtPriceX96), and the user's MONEY + WETH balances.
  const tickRead = useReadContracts({
    allowFailure: false,
    contracts:
      deployment && address
        ? [
            { address: deployment.hook, abi: hookAbi, functionName: "lastTick" },
            { address: deployment.money, abi: erc20Abi, functionName: "balanceOf", args: [address] },
            { address: deployment.weth, abi: erc20Abi, functionName: "balanceOf", args: [address] },
          ]
        : [],
    query: { enabled: !!deployment && !!address, refetchInterval: 15_000 },
  });
  const currentTick = (tickRead.data?.[0] as number) ?? 0;
  const moneyBal = (tickRead.data?.[1] as bigint) ?? 0n;
  const wethBal = (tickRead.data?.[2] as bigint) ?? 0n;

  // Sort tokens — V4 PoolKey requires currency0 < currency1.
  const wethIsToken0 = useMemo(() => {
    if (!deployment) return true;
    return (deployment.weth as string).toLowerCase() < (deployment.money as string).toLowerCase();
  }, [deployment]);

  // Precompute the three sqrt prices we need for liquidity math.
  const { sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96 } = useMemo(() => {
    const lower = minUsableTick(TICK_SPACING);
    const upper = maxUsableTick(TICK_SPACING);
    return {
      sqrtPriceX96: getSqrtPriceAtTick(currentTick),
      sqrtPriceAX96: getSqrtPriceAtTick(lower),
      sqrtPriceBX96: getSqrtPriceAtTick(upper),
    };
  }, [currentTick]);

  // Compute the partner-side amount from the driver. Single source of truth
  // for the form — re-runs whenever the driver, its input, or the price moves.
  const { moneyAmount, wethAmount, liquidity, error } = useMemo(() => {
    if (!deployment) {
      return { moneyAmount: 0n, wethAmount: 0n, liquidity: 0n, error: "Connect wallet." };
    }
    const clean = driver === "money" ? maskDecimalInput(moneyInput) : maskDecimalInput(wethInput);
    if (!clean) return { moneyAmount: 0n, wethAmount: 0n, liquidity: 0n, error: undefined };

    let driverAmount: bigint;
    try {
      driverAmount = parseUnits(clean, 18);
    } catch {
      return { moneyAmount: 0n, wethAmount: 0n, liquidity: 0n, error: "Bad number." };
    }
    if (driverAmount <= 0n)
      return { moneyAmount: 0n, wethAmount: 0n, liquidity: 0n, error: undefined };

    // The price hint: at the current spot, for full range, amount0 and amount1
    // are linked through liquidity. Approach: compute liquidity from the driver
    // assuming the other side has effectively infinite headroom, then back-solve
    // for the partner amount required to hit that exact liquidity.
    const driverIsToken0 =
      (driver === "money" && !wethIsToken0) || (driver === "weth" && wethIsToken0);

    // First pass — generous partner amount so the driver determines liquidity.
    const guess = getLiquidityForAmounts(
      sqrtPriceX96,
      sqrtPriceAX96,
      sqrtPriceBX96,
      driverIsToken0 ? driverAmount : 2n ** 127n - 1n,
      driverIsToken0 ? 2n ** 127n - 1n : driverAmount,
    );
    if (guess === 0n)
      return { moneyAmount: 0n, wethAmount: 0n, liquidity: 0n, error: "Position too small." };

    // Back-solve partner amount at that liquidity.
    const { amount0, amount1 } = getAmountsForLiquidity(
      sqrtPriceX96,
      sqrtPriceAX96,
      sqrtPriceBX96,
      guess,
    );

    const m = wethIsToken0 ? amount1 : amount0;
    const w = wethIsToken0 ? amount0 : amount1;
    return { moneyAmount: m, wethAmount: w, liquidity: guess, error: undefined };
  }, [deployment, driver, moneyInput, wethInput, sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, wethIsToken0]);

  // Display the partner-side amount in the form (read-only when not driving).
  const moneyDisplay = driver === "money" ? moneyInput : formatToken(moneyAmount, 6, false);
  const wethDisplay = driver === "weth" ? wethInput : formatToken(wethAmount, 6, false);

  const insufficientMoney = moneyAmount > moneyBal;
  const insufficientWeth = wethAmount > wethBal;
  const hasAmounts = moneyAmount > 0n && wethAmount > 0n;
  const canSubmit =
    !!deployment && !!address && hasAmounts && !insufficientMoney && !insufficientWeth && !mint.isInFlight;

  function handleSubmit() {
    if (!deployment || !address) return;
    const amount0 = wethIsToken0 ? wethAmount : moneyAmount;
    const amount1 = wethIsToken0 ? moneyAmount : wethAmount;
    const token0 = wethIsToken0 ? deployment.weth : deployment.money;
    const token1 = wethIsToken0 ? deployment.money : deployment.weth;
    // 1% headroom on the amount caps for any rounding the contract sees.
    const cap = (n: bigint) => n + n / 100n;
    mint.submit({
      poolKey: {
        currency0: token0 as Address,
        currency1: token1 as Address,
        fee: DYNAMIC_FEE_FLAG,
        tickSpacing: TICK_SPACING,
        hooks: deployment.hook,
      },
      tickLower: minUsableTick(TICK_SPACING),
      tickUpper: maxUsableTick(TICK_SPACING),
      liquidity,
      amount0Max: cap(amount0),
      amount1Max: cap(amount1),
      recipient: address,
      token0: token0 as Address,
      token1: token1 as Address,
      onSuccess: (_hash, tokenId) => {
        tickRead.refetch();
        setMoneyInput("");
        setWethInput("");
        if (tokenId !== null) onMinted?.(tokenId);
      },
    });
  }

  return (
    <div className="deco-panel">
      <div className="label-deco mb-3 text-deco-gold-dark">Mint a Liquidity Position</div>
      <h2
        className="mb-2 font-display text-2xl italic text-deco-ivory md:text-3xl"
        style={{ letterSpacing: "0.06em" }}
      >
        MONEY · WETH at Full Range
      </h2>
      <div className="mx-auto mb-5 h-[2px] w-12 bg-deco-gold" aria-hidden />
      <p className="mb-6 mx-auto max-w-xl font-body text-sm italic text-deco-ivory-soft">
        Provide MONEY and WETH at the current ratio. The PositionManager mints
        you a V4 LP NFT at the canonical full range (tick ±887220). Wrap it
        below to stake in {poolName}.
      </p>

      {/* MONEY input */}
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="label-deco text-deco-gold-dark">MONEY</span>
        <button
          type="button"
          onClick={() => {
            setDriver("money");
            setMoneyInput(formatUnits(moneyBal, 18));
          }}
          aria-label="Use full MONEY balance"
          className="label-deco text-deco-gold transition-colors hover:text-deco-gold-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-deco-gold"
        >
          Bal · {formatToken(moneyBal, 4)}
        </button>
      </div>
      <div className="mb-4 flex items-center border border-deco-gold/50 bg-deco-ground focus-within:border-deco-gold">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={moneyDisplay}
          onChange={(e) => {
            setDriver("money");
            setMoneyInput(maskDecimalInput(e.target.value));
          }}
          disabled={mint.isInFlight}
          aria-label="MONEY amount"
          className="font-display w-full bg-transparent px-4 py-3 text-right text-2xl text-deco-ivory placeholder:text-deco-gold-dark/40 focus:outline-none disabled:opacity-50"
        />
        <span className="font-ornament mr-4 text-sm text-deco-gold" style={{ letterSpacing: "0.2em" }}>
          MONEY
        </span>
      </div>

      {/* WETH input */}
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="label-deco text-deco-gold-dark">WETH</span>
        <button
          type="button"
          onClick={() => {
            setDriver("weth");
            setWethInput(formatUnits(wethBal, 18));
          }}
          aria-label="Use full WETH balance"
          className="label-deco text-deco-gold transition-colors hover:text-deco-gold-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-deco-gold"
        >
          Bal · {formatToken(wethBal, 4)}
        </button>
      </div>
      <div className="mb-6 flex items-center border border-deco-gold/50 bg-deco-ground focus-within:border-deco-gold">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={wethDisplay}
          onChange={(e) => {
            setDriver("weth");
            setWethInput(maskDecimalInput(e.target.value));
          }}
          disabled={mint.isInFlight}
          aria-label="WETH amount"
          className="font-display w-full bg-transparent px-4 py-3 text-right text-2xl text-deco-ivory placeholder:text-deco-gold-dark/40 focus:outline-none disabled:opacity-50"
        />
        <span className="font-ornament mr-4 text-sm text-deco-gold" style={{ letterSpacing: "0.2em" }}>
          WETH
        </span>
      </div>

      {/* Status row */}
      <p className="mb-5 min-h-[1.5em] text-center font-body text-sm italic text-deco-ivory-soft">
        {error
          ? error
          : insufficientMoney
            ? `Insufficient MONEY — need ${formatToken(moneyAmount, 4)}, have ${formatToken(moneyBal, 4)}.`
            : insufficientWeth
              ? `Insufficient WETH — need ${formatToken(wethAmount, 4)}, have ${formatToken(wethBal, 4)}.`
              : hasAmounts
                ? `Liquidity to mint: ${liquidity.toString()}`
                : "Type a MONEY or WETH amount to mint at the current ratio."}
      </p>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="btn-deco btn-deco-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-40"
      >
        {mint.isInFlight ? "Minting…" : "Authorize · Mint Position"}
      </button>
    </div>
  );
}
