import { Card, PlannedBadge, SectionTitle } from "@/components/ui";

export default function BridgePage() {
  return (
    <div>
      <SectionTitle title="Bridge" sub="Planned — not in this build. No omnichain promises." />
      <div className="mb-4"><PlannedBadge /></div>
      <Card>
        <p className="text-sm leading-relaxed text-ash">
          Today&apos;s Genesis pass is soulbound and xSHARE has no bridge. Bridging needs new, audited
          contracts (an omnichain xSHARE token and a bridgeable Ultra pass) — too much for a setting
          change, and not something this build promises.
        </p>
        <ul className="mt-3 space-y-2 text-sm text-ash">
          <li>• Passes are soulbound by design: frozen at mint, no transfer path exists.</li>
          <li>• xSHARE has no bridge contract.</li>
          <li>• Planned: a bridgeable version of the Ultra pass — a new contract, not a setting.</li>
          <li>• No LayerZero, no OFT, no cross-chain in this build.</li>
        </ul>
      </Card>
    </div>
  );
}
