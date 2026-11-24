import type { Abi, Address } from "viem";

/** A loosely-typed contract read, so heterogeneous batches stay readable. */
export interface ReadCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  chainId: number;
}

type Result = { status: string; result?: unknown } | undefined;

/** The value of a successful read, or undefined (reverted, pending, or never issued). */
export const ok = <T,>(r: Result): T | undefined => (r && r.status === "success" ? (r.result as T) : undefined);

export const results = (data: unknown): readonly Result[] => (data ?? []) as readonly Result[];

/** Builds a batch and remembers each call's index under a name. */
export function batch<K extends string>(chainId: number, calls: Record<K, Omit<ReadCall, "chainId"> | null>) {
  const keys = (Object.keys(calls) as K[]).filter((k) => calls[k] !== null);
  const contracts = keys.map((k) => ({ ...(calls[k] as Omit<ReadCall, "chainId">), chainId })) as ReadCall[];
  const index = Object.fromEntries(keys.map((k, i) => [k, i])) as Record<K, number | undefined>;
  return {
    contracts,
    get: <T,>(data: unknown, key: K): T | undefined => {
      const i = index[key];
      return i === undefined ? undefined : ok<T>(results(data)[i]);
    },
  };
}
