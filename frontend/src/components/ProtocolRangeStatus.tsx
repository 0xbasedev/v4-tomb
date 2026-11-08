import { useReadContracts } from "wagmi";
import type { Address } from "viem";

import { masonryRangeManagerAbi } from "@/lib/abis/masonry";
import { useProtocol } from "@/lib/hooks";
import { RANGE_POLICY, pct } from "@/lib/launch";

/**
 * Read-only status of the protocol-owned concentrated ranges on the official
 * xTOMB/USDG and xSHARE/USDG pools. User Genesis vaults and Masonry
 * X Share/WETH staking are separate and stay on their fixed ticks.
 */
export function ProtocolRangeStatus() {
  const p = useProtocol();
  const c = p.net.deployment?.contracts;
  return (
    <section data-reveal className="panel p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-bone">Protocol-owned ranges</h2>
        <span className="font-mono text-[10.5px] text-ash">read-only · follows spot</span>
      </div>
      <p className="mb-4 text-[12.5px] leading-relaxed text-bone-dim">
        Official protocol liquidity is a concentrated band around the current price
        (±{pct(RANGE_POLICY.halfWidthBps)}), recentered when price drifts past ±{pct(RANGE_POLICY.recenterBps)}{" "}
        or out of range. A keeper (or the hook, when gas allows) calls rebalance after
        a TWAP check (max {pct(RANGE_POLICY.maxTwapDeviationBps)} from spot) and a{" "}
        {RANGE_POLICY.cooldownSeconds / 60}-minute cooldown. User Genesis LP vaults and
        Masonry X Share/WETH staking stay on fixed ticks so wrapping and chamber
        staking stay compatible.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <RangeCard title="xTOMB / USDG" address={c?.levelRangeManager as Address | undefined} />
        <RangeCard title="xSHARE / USDG" address={c?.squareRangeManager as Address | undefined} />
      </div>
    </section>
  );
}

function RangeCard({ title, address }: { title: string; address?: Address }) {
  const reads = useReadContracts({
    allowFailure: true,
    contracts: address
      ? [
          { address, abi: masonryRangeManagerAbi, functionName: "status" },
          { address, abi: masonryRangeManagerAbi, functionName: "halfWidthBps" },
          { address, abi: masonryRangeManagerAbi, functionName: "recenterBps" },
          { address, abi: masonryRangeManagerAbi, functionName: "cooldown" },
          { address, abi: masonryRangeManagerAbi, functionName: "maxTwapDeviationBps" },
        ]
      : [],
    query: { enabled: !!address },
  });
  const status = reads.data?.[0]?.result as
    | readonly [bigint, bigint, bigint, bigint, boolean, boolean, bigint, bigint]
    | undefined;
  const launched = Boolean(address && status);
  const width = reads.data?.[1]?.result ?? RANGE_POLICY.halfWidthBps;
  const inner = reads.data?.[2]?.result ?? RANGE_POLICY.recenterBps;
  const cooldown = Number(reads.data?.[3]?.result ?? RANGE_POLICY.cooldownSeconds);
  const inRange = launched ? Boolean(status?.[4]) : null;
  const needsMove = launched ? Boolean(status?.[5]) : null;
  return (
    <div className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[13px] font-semibold text-bone">{title}</div>
        <span className="font-mono text-[11px] text-ash">
          {launched ? (inRange ? "in range" : "out of range") : "Not launched yet"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-bone-dim">
        <span className="text-ash">Width</span>
        <span className="font-mono text-right text-bone">±{pct(Number(width))}</span>
        <span className="text-ash">Recenter band</span>
        <span className="font-mono text-right text-bone">±{pct(Number(inner))}</span>
        {launched ? (
          <>
            <span className="text-ash">Ticks</span>
            <span className="font-mono text-right text-bone">{String(status?.[0])} → {String(status?.[1])}</span>
            <span className="text-ash">Current tick</span>
            <span className="font-mono text-right text-bone">{String(status?.[3])}</span>
            <span className="text-ash">Liquidity</span>
            <span className="font-mono text-right text-bone">{String(status?.[2])}</span>
            <span className="text-ash">Needs recenter</span>
            <span className="font-mono text-right text-bone">{needsMove ? "yes" : "no"}</span>
            <span className="text-ash">Cooldown left</span>
            <span className="font-mono text-right text-bone">{String(status?.[7])}s / {cooldown / 60} min</span>
          </>
        ) : (
          <>
            <span className="text-ash">Status</span>
            <span className="text-right text-bone">Centered on spot after launch</span>
            <span className="text-ash">Cooldown</span>
            <span className="font-mono text-right text-bone">{RANGE_POLICY.cooldownSeconds / 60} min</span>
          </>
        )}
      </div>
    </div>
  );
}
