import { useReadContracts } from "wagmi";
import { isAddressEqual, type Abi, type Address } from "viem";
import { masonryGenesisPassAbi, masonryGenesisScheduleAbi } from "@/lib/abis/masonry";
import { useActions, useProtocol } from "@/lib/hooks";
import { usePreview } from "@/lib/preview";

export function GenesisSalePanel() {
  const p = useProtocol();
  const actions = useActions();
  const preview = usePreview();
  const c = p.net.deployment?.contracts;
  const reads = useReadContracts({
    contracts: c ? [
      { address: c.schedule, abi: masonryGenesisScheduleAbi, functionName: "scheduler" },
      { address: c.pass, abi: masonryGenesisPassAbi, functionName: "saleOpen" },
    ] : [], query: { enabled: !!c, refetchInterval: 15000 },
  });
  const owner = reads.data?.[0]?.result as Address | undefined;
  const allowed = p.sim ? preview.owner && preview.sampleWallet : !!owner && !!p.net.walletAddress && isAddressEqual(owner, p.net.walletAddress);
  const open = p.sim ? preview.saleOpen : reads.data?.[1]?.result as boolean | undefined;
  if (!allowed) return null;
  return <section className="panel p-6" data-testid="genesis-sale">
    <div className="label">Genesis NFT sale · scheduler only</div>
    <h2 className="mt-2 text-xl text-bone">NFT sale: {open === undefined ? "Reading…" : open ? "Open" : "Sale not open yet"}{p.sim ? " · Simulated" : ""}</h2>
    <p className="mt-3 text-sm text-ash">Open independently of the Genesis start. Purchases and upgrades always close at Genesis end. Ultra staking still starts 24 hours before Genesis.</p>
    <button type="button" className="btn btn-primary mt-4" disabled={open === undefined || actions.busy || (!p.sim && !p.net.canTransact)} onClick={() => actions.admin(`${open ? "Close" : "Open"} NFT sale`, c?.pass ?? "0x0000000000000000000000000000000000000000", masonryGenesisPassAbi as Abi, "setSaleOpen", [!open], () => { if (p.sim) preview.setSaleOpen(!open); else void reads.refetch(); })}>
      {open ? "Close NFT sale" : "Open NFT sale"}{p.sim ? " (simulated)" : " · confirm in wallet"}
    </button>
  </section>;
}
