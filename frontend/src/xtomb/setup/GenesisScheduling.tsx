import { useRef, useState } from "react";
import { useAccount } from "wagmi";
import {
  createPublicClient, createWalletClient, custom, defineChain, http, isAddressEqual, parseAbi,
  type EIP1193Provider, type Hash,
} from "viem";
import { useTransactionSession } from "../../lib/hooks/useTransactionSession";
import { durationDays, lpDay } from "../policy";
import type { LaunchPlan } from "./configuration";

const scheduleAbi = parseAbi([
  "function scheduler() view returns (address)",
  "function start() view returns (uint256)",
  "function schedule(uint256 start)",
]);
const stakingAbi = parseAbi([
  "function schedule() view returns (address)",
  "function settlement() view returns (address)",
  "function funded() view returns (bool)",
]);
const settlementAbi = parseAbi(["function staking() view returns (address)"]);

function scheduleClient(plan: LaunchPlan) {
  return createPublicClient({ transport: http(plan.network.rpcUrl, { retryCount: 0, timeout: 10_000 }) });
}

async function readSchedule(plan: LaunchPlan, client: ReturnType<typeof scheduleClient>) {
  const { masonryGenesisSchedule: address, masonryGenesisStaking: staking, masonryGenesisSettlement: settlement } = plan.masonry.addresses;
  if (await client.getChainId() !== plan.network.id) throw new Error("The RPC is connected to a different chain. Check your Wizard network settings.");
  if (!await client.getCode({ address })) throw new Error("Deploy the Genesis schedule contract at its planned address first.");
  const [start, scheduler] = await Promise.all([
    client.readContract({ address, abi: scheduleAbi, functionName: "start" }),
    client.readContract({ address, abi: scheduleAbi, functionName: "scheduler" }),
  ]);
  if (!isAddressEqual(scheduler, plan.launch.governance)) throw new Error("The schedule contract uses a different governance address than this launch plan.");
  if (start !== 0n) return { start, ready: false };
  const [clock, payout, funded, bound] = await Promise.allSettled([
    client.readContract({ address: staking, abi: stakingAbi, functionName: "schedule" }),
    client.readContract({ address: staking, abi: stakingAbi, functionName: "settlement" }),
    client.readContract({ address: staking, abi: stakingAbi, functionName: "funded" }),
    client.readContract({ address: settlement, abi: settlementAbi, functionName: "staking" }),
  ]);
  const ready = clock.status === "fulfilled" && isAddressEqual(clock.value, address)
    && payout.status === "fulfilled" && isAddressEqual(payout.value, settlement)
    && funded.status === "fulfilled" && funded.value
    && bound.status === "fulfilled" && isAddressEqual(bound.value, staking);
  return { start, ready };
}

export function GenesisScheduling({ plan }: { plan: LaunchPlan }) {
  const account = useAccount();
  const session = useTransactionSession();
  const [date, setDate] = useState("");
  const [state, setState] = useState<Awaited<ReturnType<typeof readSchedule>>>();
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState("");
  const pending = useRef(false);
  const start = Math.floor(Date.parse(date) / 1000);
  const connected = !!account.address && account.chainId === plan.network.id && isAddressEqual(account.address, plan.launch.governance);
  const address = plan.masonry.addresses.masonryGenesisSchedule;

  async function checkSchedule() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setState(undefined);
    try { setState(await readSchedule(plan, scheduleClient(plan))); }
    catch (error) { setError(scheduleError(error)); }
    finally { pending.current = false; setBusy(false); }
  }

  async function save() {
    if (pending.current || hash || !state?.ready || !connected || !account.address || !account.connector) return;
    pending.current = true;
    setBusy(true);
    setError("");
    session.begin();
    const signer = account.address;
    const client = scheduleClient(plan);
    try {
      const status = await readSchedule(plan, client);
      setState(status);
      if (status.start !== 0n) return;
      if (!status.ready) throw new Error("Fund Genesis and finish connecting staking to its rewards contract, then check readiness again.");
      const block = await client.getBlock();
      if (!Number.isSafeInteger(start) || BigInt(start) <= block.timestamp) throw new Error("Choose a future date and time.");
      const args = [BigInt(start)] as const;
      await client.simulateContract({ address, abi: scheduleAbi, functionName: "schedule", args, account: signer });
      const chain = defineChain({
        id: plan.network.id, name: plan.network.name,
        nativeCurrency: { name: plan.network.nativeSymbol, symbol: plan.network.nativeSymbol, decimals: 18 },
        rpcUrls: { default: { http: [plan.network.rpcUrl] } },
      });
      const provider = await account.connector.getProvider() as EIP1193Provider;
      const wallet = createWalletClient({ chain, account: signer, transport: custom(provider, { retryCount: 0 }) });
      const [walletChain, walletAccounts] = await Promise.all([wallet.getChainId(), wallet.getAddresses()]);
      if (!session.valid() || walletChain !== chain.id || !walletAccounts[0] || !isAddressEqual(walletAccounts[0], signer)) {
        throw new Error("The wallet or network changed. Connect the governance wallet on the home network and try again.");
      }
      const sent = await wallet.writeContract({ address, abi: scheduleAbi, functionName: "schedule", args });
      setHash(sent);
      const receipt = await client.waitForTransactionReceipt({ hash: sent, timeout: 90_000 });
      if (receipt.status !== "success") {
        setHash(undefined);
        throw new Error("The transaction reverted. Check the on-chain schedule before trying again.");
      }
      setState(await readSchedule(plan, client));
    } catch (error) { setError(scheduleError(error)); }
    finally { pending.current = false; setBusy(false); }
  }

  return <section className="ops-detail" aria-labelledby="genesis-schedule-title">
    <h3 id="genesis-schedule-title">Set the Genesis start date</h3>
    <p>Use this after deployment if you left the date undecided. Check readiness first. The date becomes permanent when the network confirms your transaction.</p>
    <button className="button ops-actions" type="button" disabled={busy} onClick={() => void checkSchedule()}>Check Genesis readiness</button>
    {state && (state.start > 0n ? <p role="status">Genesis is scheduled for <strong>{new Date(Number(state.start) * 1000).toLocaleString()}</strong> (local time).</p>
      : state.ready ? <p role="status">Genesis is unscheduled. Staking is funded and connected to the rewards contract.</p>
      : <p role="status">Genesis is unscheduled. Finish connecting and funding the staking contracts, then check again.</p>)}
    {state?.ready && <>
      <p className="ops-help">Use governance wallet <code>{plan.launch.governance}</code> on {plan.network.name}. Genesis lasts {durationDays} days and the official liquidity pool opens on Day {lpDay}.</p>
      <label className="ops-field">Genesis start to confirm (local time)
        <input type="datetime-local" value={date} disabled={busy || !!hash} onChange={(event) => setDate(event.target.value)} />
      </label>
      {Number.isSafeInteger(start) && <p className="ops-help">The time sent to the contract is {new Date(start * 1000).toUTCString()}.</p>}
      {!connected && <p className="ops-help">Connect the governance wallet and select {plan.network.name} in your wallet to continue.</p>}
      <button className="button primary ops-actions" type="button"
        disabled={!connected || !Number.isSafeInteger(start) || start * 1000 <= Date.now() || busy || !!hash}
        onClick={() => void save()}>Confirm Genesis date in wallet</button>
    </>}
    {busy && <p role="status">{hash ? "Waiting for network confirmation…" : "Checking Genesis on-chain…"}</p>}
    {hash && <p className="ops-help">Submitted transaction <code>{hash}</code>. If confirmation takes longer, check readiness again.</p>}
    {error && <p className="callout" role="alert">{error}</p>}
  </section>;
}

function scheduleError(error: unknown) {
  if (error instanceof Error && "shortMessage" in error && typeof error.shortMessage === "string") return error.shortMessage;
  return error instanceof Error ? error.message : "Unable to check or schedule Genesis.";
}
