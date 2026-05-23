import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem } from "viem";

import { useDeployment } from "./useDeployment";

/**
 * Scans the Treasury for the four "Funded" events and the two bond events,
 * merges them into a single chronological feed, and exposes the most recent
 * `limit` entries to the Dashboard's Record of Epochs table.
 *
 * Events scanned:
 *   - TreasuryFunded(timestamp, seigniorage)   — reserve accrual during expansion
 *   - BoardroomFunded(timestamp, seigniorage)  — Boardroom payout (the canonical
 *                                                 "epoch ticked" signal)
 *   - DaoFundFunded / DevFundFunded            — team rake (off by default)
 *   - BoughtBonds(from, moneyAmount, bondAmount)   — contraction-window bond buy
 *   - RedeemedBonds(from, moneyAmount, bondAmount) — premium-window redemption
 *
 * fromBlock is bounded by `deployment.deployBlock` so we stay within the RPC
 * provider's per-call range limits (Alchemy caps at 10k blocks per request;
 * tightly-scoped fromBlock keeps us in one call).
 *
 * Re-fetches on a 60s interval — slower than wagmi's default reads because the
 * event feed only changes on epoch boundaries (every 6h) or user bond actions.
 */

const EVENTS = {
  TreasuryFunded: parseAbiItem("event TreasuryFunded(uint256 timestamp, uint256 seigniorage)"),
  BoardroomFunded: parseAbiItem("event BoardroomFunded(uint256 timestamp, uint256 seigniorage)"),
  DaoFundFunded: parseAbiItem("event DaoFundFunded(uint256 timestamp, uint256 seigniorage)"),
  DevFundFunded: parseAbiItem("event DevFundFunded(uint256 timestamp, uint256 seigniorage)"),
  BoughtBonds: parseAbiItem(
    "event BoughtBonds(address indexed from, uint256 moneyAmount, uint256 bondAmount)",
  ),
  RedeemedBonds: parseAbiItem(
    "event RedeemedBonds(address indexed from, uint256 moneyAmount, uint256 bondAmount)",
  ),
} as const;

export type TreasuryEventKind =
  | "TreasuryFunded"
  | "BoardroomFunded"
  | "DaoFundFunded"
  | "DevFundFunded"
  | "BoughtBonds"
  | "RedeemedBonds";

export interface TreasuryEventRow {
  kind: TreasuryEventKind;
  blockNumber: bigint;
  logIndex: number;
  /** Block-level timestamp (sec). For Funded events this matches the event's own
   *  embedded `timestamp` arg; for Bond events we pull it from the block. */
  timestamp: bigint;
  /** Primary amount of this event — seigniorage / moneyAmount / etc. */
  amount: bigint;
  /** Secondary amount (only meaningful for bond events). */
  secondaryAmount?: bigint;
  /** Optional indexed address for bond events. */
  who?: `0x${string}`;
  transactionHash: `0x${string}`;
}

interface UseTreasuryEventsOptions {
  limit?: number;
}

export function useTreasuryEvents({ limit = 10 }: UseTreasuryEventsOptions = {}) {
  const deployment = useDeployment();
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<TreasuryEventRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (!deployment || !publicClient) return;
    let cancelled = false;

    async function scan() {
      try {
        if (!deployment || !publicClient) return;
        const baseFilter = {
          address: deployment.treasury,
          fromBlock: deployment.deployBlock,
          toBlock: "latest" as const,
        };
        const [tf, bf, daoF, devF, bb, rb] = await Promise.all([
          publicClient.getLogs({ ...baseFilter, event: EVENTS.TreasuryFunded }),
          publicClient.getLogs({ ...baseFilter, event: EVENTS.BoardroomFunded }),
          publicClient.getLogs({ ...baseFilter, event: EVENTS.DaoFundFunded }),
          publicClient.getLogs({ ...baseFilter, event: EVENTS.DevFundFunded }),
          publicClient.getLogs({ ...baseFilter, event: EVENTS.BoughtBonds }),
          publicClient.getLogs({ ...baseFilter, event: EVENTS.RedeemedBonds }),
        ]);

        // Inline mappers — viem's strict per-event Log typing makes a generic
        // mapper awkward, and the row shape is short enough that inlining is
        // clearer.
        const tfRows: TreasuryEventRow[] = tf.map((log) => ({
          kind: "TreasuryFunded",
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          timestamp: log.args.timestamp!,
          amount: log.args.seigniorage!,
          transactionHash: log.transactionHash!,
        }));
        const bfRows: TreasuryEventRow[] = bf.map((log) => ({
          kind: "BoardroomFunded",
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          timestamp: log.args.timestamp!,
          amount: log.args.seigniorage!,
          transactionHash: log.transactionHash!,
        }));
        const daoRows: TreasuryEventRow[] = daoF.map((log) => ({
          kind: "DaoFundFunded",
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          timestamp: log.args.timestamp!,
          amount: log.args.seigniorage!,
          transactionHash: log.transactionHash!,
        }));
        const devRows: TreasuryEventRow[] = devF.map((log) => ({
          kind: "DevFundFunded",
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          timestamp: log.args.timestamp!,
          amount: log.args.seigniorage!,
          transactionHash: log.transactionHash!,
        }));

        // Bond events don't include timestamp args; pull block timestamps in a
        // single batch. Most deploys have ≤ 0 bond events at launch, so this is
        // usually a no-op.
        const bondBlocks = new Set<bigint>([
          ...bb.map((l) => l.blockNumber!),
          ...rb.map((l) => l.blockNumber!),
        ]);
        const blockTimestamps = new Map<bigint, bigint>();
        for (const bn of bondBlocks) {
          // eslint-disable-next-line no-await-in-loop
          const block = await publicClient.getBlock({ blockNumber: bn });
          blockTimestamps.set(bn, block.timestamp);
        }

        const bbRows: TreasuryEventRow[] = bb.map((log) => ({
          kind: "BoughtBonds",
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          timestamp: blockTimestamps.get(log.blockNumber!) ?? 0n,
          amount: log.args.moneyAmount!,
          secondaryAmount: log.args.bondAmount,
          who: log.args.from,
          transactionHash: log.transactionHash!,
        }));
        const rbRows: TreasuryEventRow[] = rb.map((log) => ({
          kind: "RedeemedBonds",
          blockNumber: log.blockNumber!,
          logIndex: log.logIndex!,
          timestamp: blockTimestamps.get(log.blockNumber!) ?? 0n,
          amount: log.args.moneyAmount!,
          secondaryAmount: log.args.bondAmount,
          who: log.args.from,
          transactionHash: log.transactionHash!,
        }));

        const merged: TreasuryEventRow[] = [
          ...tfRows,
          ...bfRows,
          ...daoRows,
          ...devRows,
          ...bbRows,
          ...rbRows,
        ];

        merged.sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? 1 : -1;
          return b.logIndex - a.logIndex;
        });

        if (!cancelled) {
          setRows(merged.slice(0, limit));
          setIsLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setIsError(true);
          setIsLoading(false);
          // eslint-disable-next-line no-console
          console.error("useTreasuryEvents scan failed:", e);
        }
      }
    }

    scan();
    const interval = window.setInterval(scan, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [deployment, publicClient, limit]);

  return { rows, isLoading, isError };
}
