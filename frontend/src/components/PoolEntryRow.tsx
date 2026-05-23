/**
 * PoolEntryRow — single registered stake-token entry inside a reward pool's
 * entries table. Each pool can have multiple PIDs (different LP/stake tokens
 * with their own allocPoint weights).
 *
 * Rendered inside a deco-panel as a row. Includes a Stake / Withdraw action
 * dropdown (placeholder for v0 — Sprint B opens an ActionPanel modal or
 * inline form when clicked).
 */

interface PoolEntryRowProps {
  pid: number;
  stakeToken: string;
  allocPoint: number;
  yourBalance: string;
  yourStake: string;
  poolBalance: string;
}

export function PoolEntryRow({
  pid,
  stakeToken,
  allocPoint,
  yourBalance,
  yourStake,
  poolBalance,
}: PoolEntryRowProps) {
  return (
    <tr className="border-b border-deco-gold/15 last:border-b-0">
      <td className="font-ornament px-5 py-4 text-deco-gold" style={{ letterSpacing: "0.2em" }}>
        {pid + 1}
      </td>
      <td className="px-5 py-4 font-display text-lg text-deco-ivory">{stakeToken}</td>
      <td className="px-5 py-4 font-body text-base text-deco-ivory-soft">{allocPoint}</td>
      <td className="px-5 py-4 font-display text-lg text-deco-ivory">{poolBalance}</td>
      <td className="px-5 py-4 font-display text-lg text-deco-ivory">{yourStake}</td>
      <td className="px-5 py-4 text-right font-body text-base italic text-deco-gold">
        {yourBalance} <span className="text-deco-gold-dark">available</span>
      </td>
    </tr>
  );
}
