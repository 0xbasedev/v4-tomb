import { useMemo, useState } from "react";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { formatUnits, parseUnits, zeroAddress, type Address } from "viem";

import {
  liteDeployment, liteFarmAbi, liteMasonryAbi, litePriceAbi, liteTokenAbi,
} from "@/lib/liteDeployment";

const ZERO = 0n;
const fmt = (v: bigint | undefined, decimals = 18) =>
  v === undefined ? "—" : Number(formatUnits(v, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
function tryAmount(text: string, decimals: number): bigint | null {
  try {
    const amount = parseUnits(text, decimals);
    return amount > 0n ? amount : null;
  } catch { return null; }
}

function TransactionStatus({ hash, error, success }: {
  hash: `0x${string}` | undefined; error: Error | null; success: boolean;
}) {
  if (error) return <p role="alert" className="mt-2 text-sm text-bad">{error.message}</p>;
  if (hash) return (
    <p className="mt-2 font-mono text-xs text-ash">
      {success ? "Confirmed: " : "Transaction pending: "}
      <a className="text-bone underline" href={liteDeployment?.network.explorerUrl
        ? `${liteDeployment.network.explorerUrl}/tx/${hash}` : "#"} target="_blank" rel="noreferrer">
        {hash.slice(0, 10)}…{hash.slice(-6)}
      </a>
    </p>
  );
  return null;
}

function FarmPanel({ title, farm, lp, active }: {
  title: string; farm: Address; lp: Address; active: boolean;
}) {
  const wallet = useAccount();
  const [quantity, setQuantity] = useState("");
  const [operation, setOperation] = useState<"stake" | "withdraw">("stake");
  const amount = useMemo(() => tryAmount(quantity, 18), [quantity]);
  const chainId = liteDeployment?.network.chainId;
  const account = wallet.address ?? zeroAddress;

  const balance = useReadContract({ address: lp, abi: liteTokenAbi, functionName: "balanceOf",
    args: [account], chainId, query: { enabled: active, refetchInterval: 15000 } });
  const allowance = useReadContract({ address: lp, abi: liteTokenAbi, functionName: "allowance",
    args: [account, farm], chainId, query: { enabled: active, refetchInterval: 15000 } });
  const stake = useReadContract({ address: farm, abi: liteFarmAbi, functionName: "staked",
    args: [account], chainId, query: { enabled: active, refetchInterval: 15000 } });
  const pending = useReadContract({ address: farm, abi: liteFarmAbi, functionName: "pending",
    args: [account], chainId, query: { enabled: active, refetchInterval: 15000 } });
  const fee = useReadContract({ address: farm, abi: liteFarmAbi, functionName: "withdrawalFeeBps",
    chainId, query: { enabled: active, refetchInterval: 15000 } });
  const tx = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: tx.data, query: { enabled: !!tx.data } });
  const allowed = !!amount && (operation === "stake" ? amount <= (balance.data ?? ZERO)
    : amount <= (stake.data ?? ZERO));
  const approveNeeded = operation === "stake" && allowed && amount! > (allowance.data ?? ZERO);

  const submit = () => {
    if (!active || !allowed || !amount) return;
    if (approveNeeded) tx.writeContract({ address: lp, abi: liteTokenAbi, functionName: "approve",
      args: [farm, amount], chainId });
    else if (operation === "stake") tx.writeContract({ address: farm, abi: liteFarmAbi,
      functionName: "stake", args: [amount], chainId });
    else tx.writeContract({ address: farm, abi: liteFarmAbi,
      functionName: "withdraw", args: [amount], chainId });
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <h3 className="mb-3 font-semibold text-bone">{title}</h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <p className="text-ash">Your LP <strong className="block text-bone">{fmt(balance.data)}</strong></p>
        <p className="text-ash">Staked LP <strong className="block text-bone">{fmt(stake.data)}</strong></p>
        <p className="text-ash">Earned xSHARE <strong className="block text-bone">{fmt(pending.data)}</strong></p>
        <p className="text-ash">Withdrawal fee <strong className="block text-bone">
          {fee.data === undefined ? "—" : `${Number(fee.data) / 100}%`}
        </strong></p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select aria-label={`${title} operation`} className="rounded-lg bg-black/60 p-2 text-bone"
          value={operation} onChange={(event) => setOperation(event.target.value as "stake" | "withdraw")}>
          <option value="stake">Stake</option><option value="withdraw">Withdraw</option>
        </select>
        <input className="w-36 rounded-lg border border-white/15 bg-black/60 p-2 text-bone"
          aria-label={`${title} amount`} placeholder="LP amount" value={quantity}
          onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" />
        <button type="button" className="rounded-lg bg-white/10 px-4 py-2 text-bone disabled:opacity-40"
          disabled={!active || !allowed || tx.isPending} onClick={submit}>
          {approveNeeded ? "Approve LP" : operation === "stake" ? "Stake LP" : "Withdraw LP"}
        </button>
        <button type="button" className="rounded-lg border border-white/15 px-4 py-2 text-bone disabled:opacity-40"
          disabled={!active || !(pending.data && pending.data > ZERO) || tx.isPending}
          onClick={() => tx.writeContract({ address: farm, abi: liteFarmAbi, functionName: "claim", chainId })}>
          Claim xSHARE
        </button>
      </div>
      <TransactionStatus hash={tx.data} error={tx.error} success={receipt.isSuccess} />
    </section>
  );
}

/** A distinct route: no changes to the existing v4 dashboard or simulated visuals.
 * It never enables wallet writes without an explicitly verified Lite deployment manifest.
 */
export function Lite() {
  const d = liteDeployment;
  const account = useAccount();
  const [quantity, setQuantity] = useState("");
  const [trancheIndex, setTrancheIndex] = useState("0");
  const [exitNow, setExitNow] = useState(false);
  const connected = !!d && !!account.address && account.chainId === d.network.chainId;
  const chainId = d?.network.chainId;
  const user = account.address ?? zeroAddress;
  const masonryAddress = d?.addresses.masonry ?? zeroAddress;
  const lp = d?.addresses.masonryLp ?? zeroAddress;
  const stable = d?.addresses.stable ?? zeroAddress;

  const lpBalance = useReadContract({ address: lp, abi: liteTokenAbi, functionName: "balanceOf",
    args: [user], chainId, query: { enabled: connected, refetchInterval: 15000 } });
  const lpAllowance = useReadContract({ address: lp, abi: liteTokenAbi, functionName: "allowance",
    args: [user, masonryAddress], chainId, query: { enabled: connected, refetchInterval: 15000 } });
  const stableAllowance = useReadContract({ address: stable, abi: liteTokenAbi, functionName: "allowance",
    args: [user, masonryAddress], chainId, query: { enabled: connected, refetchInterval: 15000 } });
  const stableDecimals = useReadContract({ address: stable, abi: liteTokenAbi, functionName: "decimals",
    chainId, query: { enabled: connected } });
  const stableUsd = useReadContract({ address: d?.addresses.stableUsd ?? zeroAddress,
    abi: litePriceAbi, functionName: "latestPrice", chainId,
    query: { enabled: connected, refetchInterval: 15000 } });
  const twap = useReadContract({ address: d?.addresses.twap ?? zeroAddress,
    abi: litePriceAbi, functionName: "latestPrice", chainId,
    query: { enabled: connected, refetchInterval: 15000 } });
  const pending = useReadContract({ address: masonryAddress, abi: liteMasonryAbi,
    functionName: "earned", args: [user], chainId,
    query: { enabled: connected, refetchInterval: 15000 } });
  const staked = useReadContract({ address: masonryAddress, abi: liteMasonryAbi,
    functionName: "stakedBalance", args: [user], chainId,
    query: { enabled: connected, refetchInterval: 15000 } });
  const nextEpoch = useReadContract({ address: masonryAddress, abi: liteMasonryAbi,
    functionName: "nextEpochAt", chainId,
    query: { enabled: connected, refetchInterval: 15000 } });
  const trancheCount = useReadContract({ address: masonryAddress, abi: liteMasonryAbi,
    functionName: "trancheCount", args: [user], chainId,
    query: { enabled: connected, refetchInterval: 15000 } });

  const amount = useMemo(() => tryAmount(quantity, 18), [quantity]);
  const index = Number(trancheIndex);
  const indexValid = Number.isInteger(index) && index >= 0 &&
    BigInt(index) < (trancheCount.data ?? 0n);
  const feeAmount = useMemo(() => {
    const price = stableUsd.data?.[0];
    const decimals = stableDecimals.data;
    if (!price || decimals === undefined || decimals > 18) return null;
    const numerator = 25n * 10n ** (18n + BigInt(decimals));
    return (numerator + price - 1n) / price;
  }, [stableUsd.data, stableDecimals.data]);

  const writable = connected && !account.isConnecting;
  const canAdvance = writable && !!twap.data &&
    twap.data[0] > 1_010_000_000_000_000_000n &&
    Number(twap.data[1]) > Date.now() / 1000 - 1800 &&
    (nextEpoch.data === undefined || Number(nextEpoch.data) <= Date.now() / 1000);

  const tx = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: tx.data, query: { enabled: !!tx.data } });
  const submitStake = () => {
    if (!writable || !amount || amount > (lpBalance.data ?? ZERO) || amount >= 2n ** 128n) return;
    if (amount > (lpAllowance.data ?? ZERO)) tx.writeContract({
      address: lp, abi: liteTokenAbi, functionName: "approve",
      args: [masonryAddress, amount], chainId
    });
    else tx.writeContract({ address: masonryAddress, abi: liteMasonryAbi,
      functionName: "deposit", args: [amount], chainId });
  };
  const submitExit = () => {
    if (!writable || !amount || amount >= 2n ** 128n || !indexValid) return;
    tx.writeContract({ address: masonryAddress, abi: liteMasonryAbi,
      functionName: exitNow ? "exitNow" : "withdraw", args: [BigInt(index), amount], chainId });
  };
  const advance = () => {
    if (!canAdvance || !feeAmount) return;
    if (feeAmount > (stableAllowance.data ?? ZERO)) tx.writeContract({
      address: stable, abi: liteTokenAbi, functionName: "approve",
      args: [masonryAddress, feeAmount], chainId
    });
    else tx.writeContract({ address: masonryAddress, abi: liteMasonryAbi,
      functionName: "advanceEpochStable", chainId });
  };

  if (!d) return (
    <div className="mx-auto max-w-4xl px-5 py-20 text-bone">
      <p className="font-mono text-xs uppercase tracking-widest text-ash">xTomb Lite</p>
      <h1 className="mt-4 text-3xl font-bold">Deployment not published</h1>
      <p className="mt-3 max-w-2xl text-ash">
        Lite contracts and ABIs are compiled separately, but no reviewed on-chain deployment
        manifest exists. Transaction controls are intentionally disabled. Existing V4 pages remain unchanged.
      </p>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-14 text-bone">
      <div>
        <p className="font-mono text-xs uppercase tracking-widest text-ash">{d.network.name}</p>
        <h1 className="mt-2 text-3xl font-bold">xTomb Lite</h1>
        <p className="mt-3 text-sm text-ash">Canonical V2 LP positions · xTOMB/xSHARE Masonry · pre-funded Farms.</p>
        {!connected && <p role="status" className="mt-3 text-warn">Connect a wallet on chain {d.network.chainId} to enable transactions.</p>}
      </div>
      <section className="grid gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:grid-cols-3">
        <p className="text-ash">xTOMB TWAP <strong className="block text-2xl text-bone">
          {twap.data ? `$${Number(formatUnits(twap.data[0], 18)).toFixed(4)}` : "Unavailable"}
        </strong></p>
        <p className="text-ash">Next eligible epoch <strong className="block text-base text-bone">
          {nextEpoch.data ? new Date(Number(nextEpoch.data) * 1000).toLocaleString() : "—"}
        </strong></p>
        <p className="text-ash">Pending xTOMB <strong className="block text-2xl text-bone">{fmt(pending.data)}</strong></p>
      </section>
      <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-xl font-semibold">The Masonry</h2>
        <p className="text-sm text-ash">Staked {fmt(staked.data)} LP · Wallet {fmt(lpBalance.data)} LP · {String(trancheCount.data ?? "—")} tranches</p>
        <div className="flex flex-wrap items-center gap-2">
          <input className="w-40 rounded-lg border border-white/15 bg-black/60 p-2"
            value={quantity} placeholder="LP amount" onChange={(event) => setQuantity(event.target.value)}
            aria-label="Masonry LP amount" inputMode="decimal" />
          <button className="rounded-lg bg-white/10 px-4 py-2 disabled:opacity-40"
            disabled={!writable || !amount || amount > (lpBalance.data ?? ZERO)}
            onClick={submitStake}>
            {amount && amount > (lpAllowance.data ?? ZERO) ? "Approve LP" : "Stake LP"}
          </button>
          <button className="rounded-lg border border-white/15 px-4 py-2 disabled:opacity-40"
            disabled={!writable || !(pending.data && pending.data > ZERO)}
            onClick={() => tx.writeContract({ address: masonryAddress, abi: liteMasonryAbi,
              functionName: "claim", chainId })}>Claim</button>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-3">
          <input className="w-16 rounded-lg bg-black/60 p-2" value={trancheIndex}
            onChange={(event) => setTrancheIndex(event.target.value)} aria-label="LP tranche index" />
          <label className="flex items-center gap-2 text-sm text-ash">
            <input type="checkbox" checked={exitNow} onChange={(event) => setExitNow(event.target.checked)} />
            Exit Now (forfeit 50% LP and all accrued rewards)
          </label>
          <button className="rounded-lg border border-white/15 px-4 py-2 disabled:opacity-40"
            disabled={!writable || !indexValid || !amount || amount > (staked.data ?? ZERO)}
            onClick={submitExit}>{exitNow ? "Exit Now" : "Withdraw tranche"}</button>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-3">
          <button className="rounded-lg bg-white/10 px-4 py-2 disabled:opacity-40"
            disabled={!canAdvance || feeAmount === null}
            onClick={advance}>
            {feeAmount && feeAmount > (stableAllowance.data ?? ZERO) ? "Approve $25 fee" : "Advance eligible epoch"}
          </button>
          <span className="text-sm text-ash">Permissionless; only if fresh TWAP is strictly above $1.01.</span>
        </div>
        <TransactionStatus hash={tx.data} error={tx.error} success={receipt.isSuccess} />
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <FarmPanel title="xTOMB / stable LP Farm" farm={d.addresses.pegFarm}
          lp={d.addresses.pegFarmLp} active={writable} />
        <FarmPanel title="xSHARE / stable LP Farm" farm={d.addresses.shareFarm}
          lp={d.addresses.shareFarmLp} active={writable} />
      </div>
      <p className="text-sm text-ash">Funds can be lost in unaudited deployments. A published manifest is not a security audit.</p>
    </div>
  );
}
