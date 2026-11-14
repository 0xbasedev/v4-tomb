import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Sigil } from "@/components/brand/Sigil";
import { ChainBadge } from "@/components/ChainBadge";
import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { PlannedBadge, Reason } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { BRIDGE, bridgeNetwork, bridgeNetworkStatus, loadRelease, type BridgeNetwork } from "@/lib/create3";
import { REGISTRY } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { useReveal } from "@/lib/motion/useReveal";

/**
 * Bridge — the four-chain xSHARE bridge (merge @ 484c279, Hyperlane), shown
 * from config/xshare-bridge.json. Original xSHARE stays on the Wizard-selected
 * home chain; the other four networks receive Bridged xSHARE (same symbol,
 * its own address). Satellite → satellite is two transfers through home.
 *
 * Every route is disabled in the manifest, so every action here is disabled
 * and says why. Predicted bridge and token addresses come from the release
 * plan saved by the Wizard in this browser; they are predictions, never a
 * deployment. The monthly expansion-Genesis animation below is a separate,
 * planned Masonry roadmap item.
 */
const NETS = BRIDGE.networks;
const MASONRY_CHAINS = REGISTRY.chains.filter((c) => !c.testnet && c.id !== 1);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Bridge() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root, []);
  const release = useMemo(loadRelease, []);
  // Predictions saved by the Wizard (mined with any address patterns); never a deployment.
  const plan = release?.bridge ?? null;
  const home = plan ? bridgeNetwork(plan.canonicalDomain) : null;

  return (
    <div ref={root}>
      <PageHeader
        eyebrow="Bridge · xSHARE · Hyperlane"
        title="xSHARE across four chains"
        lede={`Original xSHARE stays on the home chain. ${NETS.map((n) => n.name).join(", ").replace(/, ([^,]*)$/, " and $1")} are connected; the networks that aren't home receive Bridged xSHARE. Every route stays off until a reviewed deployment is verified and published.`}
        aside={
          <div className="panel p-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="label">Status</span>
              <PlannedBadge label="In the contracts · not deployed" />
            </div>
            <ul className="space-y-1.5 text-[13px] leading-relaxed text-bone-dim">
              <li>xSHARE only. Genesis passes are soulbound and aren't part of this bridge.</li>
              <li>All four networks are disabled in the manifest.</li>
              <li>{home ? `Home chain in your release plan: ${home.name}.` : "The home chain is chosen in the Wizard's release plan."}</li>
            </ul>
          </div>
        }
      />
      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-12 md:px-8">
        <HubAndSpoke homeId={plan?.canonicalDomain ?? null} />
        <BridgeForm homeId={plan?.canonicalDomain ?? null} />

        <section>
          <SectionTitle kicker="Networks" title="Four Hyperlane routes" right={<span className="hidden font-mono text-[11px] text-ash sm:inline">config/xshare-bridge.json</span>} />
          <div data-reveal className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="bridge-networks">
            {NETS.map((n) => (
              <NetworkCard key={n.id} n={n} home={plan?.canonicalDomain === n.id} token={plan?.tokens[n.id] ?? null} bridge={plan?.bridge ?? null} />
            ))}
          </div>
          <p className="mt-2 text-[12px] text-ash">
            Mailboxes are Hyperlane infrastructure (registry {BRIDGE.registryCommit.slice(0, 7)}). Project addresses are blank until a release plan predicts them;{" "}
            {plan ? "the ones shown are predictions from the release plan saved in this browser." : <Link to="/wizard" className="text-ember-hot hover:underline">set one in the Wizard</Link>}
            {plan ? "" : "."}
          </p>
        </section>

        <TransferSteps />

        <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Plan icon="xSHARE" title="Original vs Bridged xSHARE" body="Both use the symbol xSHARE. The app tells them apart by address from the deployment manifest, never by symbol. Bridged xSHARE is an 18-decimal token minted and burned only by its bridge." />
          <Plan icon="xTOMB" title="Passes stay put" body="The bridge carries xSHARE only. Genesis passes are soulbound by design; a bridgeable Ultra pass would be a new, separately audited contract." badge="Planned · not in this bridge" />
          <Plan icon="xTOMB-USDC" title="No admin mint, no refunds" body="There's no administrator mint, escrow withdrawal or independent source refund. Governance can disable sends or pause settlement; transfers in flight wait until settlement resumes." />
        </section>

        <GenesisCadence />
      </div>
    </div>
  );
}

function Plan({ icon, title, body, badge }: { icon: string; title: string; body: string; badge?: string }) {
  return (
    <div data-reveal className="panel p-5">
      <div className="mb-3 flex items-center gap-2">
        <TokenIcon symbol={icon} size={28} />
        {badge && <PlannedBadge label={badge} />}
      </div>
      <h3 className="font-display text-[16px] font-semibold text-bone">{title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-bone-dim">{body}</p>
    </div>
  );
}

function NetworkCard({ n, home, token, bridge }: { n: BridgeNetwork; home: boolean; token: string | null; bridge: string | null }) {
  const status = bridgeNetworkStatus(n);
  const sonicLike = n.registryAvailability?.status === "disabled";
  return (
    <div className={`panel flex flex-col gap-2 p-3.5 ${home ? "border-spectre/40" : ""}`} data-network={n.slug}>
      <div className="flex items-center gap-2.5">
        <ChainBadge id={n.id} name={n.name} size={32} lit={!sonicLike} />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-bone">{n.name}</div>
          <div className="font-mono text-[10.5px] text-ash">
            domain {n.domain} · fee in {n.nativeCurrency.symbol}
          </div>
        </div>
      </div>
      <div className="font-mono text-[10.5px] text-ash">
        {home ? <span className="text-spectre">home · original xSHARE</span> : "Bridged xSHARE"}
        {token && <span className="block text-bone-dim">token {short(token)} · predicted</span>}
        {bridge && <span className="block text-bone-dim">bridge {short(bridge)} · predicted</span>}
        <span className="block">mailbox {short(n.mailbox)}</span>
      </div>
      <div className={`mt-auto rounded-lg border px-2 py-1.5 text-[11.5px] ${sonicLike ? "border-warn/30 bg-warn/[0.05] text-warn" : "border-white/[0.08] text-ash"}`}>
        {status}
        {sonicLike && n.abacusWorksLastSupportedDate && <span className="mt-0.5 block text-[10.5px] text-ash">Public Abacus Works validators and relayer ended {n.abacusWorksLastSupportedDate}.</span>}
      </div>
    </div>
  );
}

/**
 * Hub and spoke, animated: a packet leaves the home chain (locked in escrow),
 * crosses to a satellite (Bridged xSHARE minted) and comes back (burned,
 * released). Every few beats a satellite-to-satellite transfer plays as two
 * hops through home — the only way it works. Sonic stays dim.
 */
function HubAndSpoke({ homeId }: { homeId: number | null }) {
  const root = useRef<HTMLDivElement>(null);
  const [caption, setCaption] = useState("Home → satellite: xSHARE locks at home, Bridged xSHARE mints on arrival.");
  const center = homeId ? bridgeNetwork(homeId) : null;
  const ring = NETS.filter((n) => n.id !== homeId);
  const W = 520;
  const C = W / 2;
  const R = 180;
  const pos = (i: number) => {
    const a = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
    return { x: C + R * Math.cos(a), y: C + R * Math.sin(a) };
  };
  const live = ring.map((n, i) => ({ n, i, ...pos(i) })).filter((r) => r.n.registryAvailability?.status !== "disabled");

  useGSAP(
    () => {
      if (prefersReducedMotion() || live.length < 2) return;
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
      const hop = (from: { x: number; y: number }, to: { x: number; y: number }, color: string) =>
        tl
          .set(".hs-packet", { attr: { cx: from.x, cy: from.y, fill: color }, autoAlpha: 1 })
          .to(".hs-packet", { attr: { cx: to.x, cy: to.y }, duration: 0.9, ease: EASE.rise })
          .fromTo(".hs-ping", { attr: { cx: to.x, cy: to.y, r: 10 }, autoAlpha: 0.9 }, { attr: { r: 34 }, autoAlpha: 0, duration: 0.6, ease: "power2.out", immediateRender: false }, "<0.75")
          .to(".hs-packet", { autoAlpha: 0, duration: 0.15 });
      const hub = { x: C, y: C };
      live.forEach((s, k) => {
        tl.call(() => setCaption(`${center?.name ?? "Home"} → ${s.n.name}: xSHARE locks at home, Bridged xSHARE mints on ${s.n.name}.`));
        hop(hub, s, "#3ee7ff");
        tl.call(() => setCaption(`${s.n.name} → ${center?.name ?? "Home"}: Bridged xSHARE burns, the original is released from escrow.`));
        hop(s, hub, "#b48cff");
        if (k === 1) {
          const a = live[0]!;
          const b = live[live.length - 1]!;
          tl.call(() => setCaption(`${a.n.name} → ${b.n.name} is two independent transfers: first to ${center?.name ?? "home"}, then out again.`));
          hop(a, hub, "#ffb547");
          hop(hub, b, "#ffb547");
        }
      });
      return () => tl.kill();
    },
    { scope: root, dependencies: [homeId] },
  );

  return (
    <section data-reveal className="panel panel-raised overflow-hidden p-5 md:p-7">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="label">Hub and spoke</span>
            <PlannedBadge label="Illustrative · routes disabled" />
          </div>
          <h2 className="min-h-[2.6em] font-display text-lg font-semibold leading-snug text-bone sm:min-h-0 md:text-xl" aria-live="polite">
            {caption}
          </h2>
        </div>
      </div>
      <div ref={root} className="relative mx-auto w-full max-w-[460px]">
        <svg viewBox={`0 0 ${W} ${W}`} className="w-full" aria-hidden>
          <circle cx={C} cy={C} r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeDasharray="2 8" />
          {ring.map((n, i) => {
            const p = pos(i);
            const off = n.registryAvailability?.status === "disabled";
            return <line key={n.id} x1={C} y1={C} x2={p.x} y2={p.y} stroke={off ? "rgba(255,181,71,0.25)" : "rgba(62,231,255,0.28)"} strokeWidth="1.5" strokeDasharray={off ? "3 6" : undefined} />;
          })}
          <circle className="hs-ping" cx={C} cy={C} r={10} fill="none" stroke="#3ee7ff" strokeWidth="1.5" opacity={0} />
          <circle className="hs-packet" cx={C} cy={C} r={7} fill="#3ee7ff" opacity={0} />
        </svg>
        {ring.map((n, i) => {
          const p = pos(i);
          const off = n.registryAvailability?.status === "disabled";
          return (
            <span key={n.id} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center" style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / W) * 100}%` }}>
              <ChainBadge id={n.id} name={n.name} size={40} lit={!off} />
              <span className={`mt-1 whitespace-nowrap font-mono text-[10px] ${off ? "text-warn" : "text-ash"}`}>{off ? `${n.name} · awaiting relayer` : n.name}</span>
            </span>
          );
        })}
        <span className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
          {center ? <ChainBadge id={center.id} name={center.name} size={56} /> : <Sigil size={52} glow />}
          <span className="mt-1 font-display text-[12px] font-semibold text-bone">{center ? center.name : "Home chain"}</span>
          <span className="font-mono text-[9.5px] text-spectre">original xSHARE</span>
        </span>
      </div>
      <p className="mt-4 text-[12px] text-ash">
        {center ? `${center.name} is home in the release plan saved in this browser.` : "No home chain yet — the Wizard picks it with the release plan."} Satellites only talk to home.
      </p>
    </section>
  );
}

/** The send form, complete but disabled: it shows exactly what will be checked and why it can't run yet. */
function BridgeForm({ homeId }: { homeId: number | null }) {
  const [from, setFrom] = useState<number>(homeId ?? NETS[0]!.id);
  const [to, setTo] = useState<number>(NETS.find((n) => n.id !== (homeId ?? NETS[0]!.id))!.id);
  const [amount, setAmount] = useState("");
  const src = bridgeNetwork(from)!;
  const dst = bridgeNetwork(to)!;
  const same = from === to;
  const viaHome = homeId !== null && from !== homeId && to !== homeId && !same;
  const reasons = [
    same ? "Pick two different networks." : null,
    homeId === null ? "No home chain: the release plan sets it, and each route only runs home ↔ satellite." : null,
    viaHome ? `${src.name} → ${dst.name} is two transfers: ${src.name} → ${bridgeNetwork(homeId)!.name}, then ${bridgeNetwork(homeId)!.name} → ${dst.name}.` : null,
    !src.bridge || !dst.bridge ? "No verified bridge deployment is published for this route." : null,
    !src.enabled || !dst.enabled ? "The route is disabled in the manifest until a production canary passes." : null,
    bridgeNetworkStatus(src) === "Awaiting relayer and verifier setup" || bridgeNetworkStatus(dst) === "Awaiting relayer and verifier setup" ? "Sonic needs a verified validator and relayer before it can carry messages." : null,
  ].filter(Boolean) as string[];
  const sel = "well px-2 py-2 text-bone";
  return (
    <section data-reveal className="panel p-5 md:p-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-display text-lg font-semibold text-bone">Send xSHARE</h2>
        <PlannedBadge label="Disabled" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr_1fr] sm:items-end">
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-ash">From</span>
          <select value={from} onChange={(e) => setFrom(Number(e.target.value))} className={sel} aria-label="From network">
            {NETS.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
                {n.id === homeId ? " · home" : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => (setFrom(to), setTo(from))} className="btn h-10 w-10 self-end p-0 text-bone-dim" aria-label="Swap networks">
          ⇄
        </button>
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-ash">To</span>
          <select value={to} onChange={(e) => setTo(Number(e.target.value))} className={sel} aria-label="To network">
            {NETS.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
                {n.id === homeId ? " · home" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="text-ash">Amount (xSHARE, 18 decimals)</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0.0" className={`${sel} font-mono`} aria-label="Amount of xSHARE to bridge" />
        </label>
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-2 text-[12.5px] sm:grid-cols-3">
        <div className="rounded-xl bg-black/25 p-3">
          <dt className="label mb-1">Bridge fee</dt>
          <dd className="text-bone-dim">quoted in {src.nativeCurrency.symbol} by quoteSend · gas estimated separately</dd>
        </div>
        <div className="rounded-xl bg-black/25 p-3">
          <dt className="label mb-1">On {src.name}</dt>
          <dd className="text-bone-dim">{from === homeId ? "approve, then xSHARE is locked in escrow" : "Bridged xSHARE is burned by the send itself"}</dd>
        </div>
        <div className="rounded-xl bg-black/25 p-3">
          <dt className="label mb-1">On {dst.name}</dt>
          <dd className="text-bone-dim">{to === homeId ? "original xSHARE released from escrow" : "Bridged xSHARE minted to the recipient"}</dd>
        </div>
      </dl>
      <button type="button" disabled className="btn btn-primary mt-4 h-12 w-full">
        Bridge unavailable
      </button>
      <ul className="mt-2 space-y-1" data-testid="bridge-reasons">
        {reasons.map((r) => (
          <li key={r}>
            <Reason>{r}</Reason>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STEPS: [string, string][] = [
  ["Resolve the route", "Both deployments published, wallet on the source chain, a home ↔ satellite direction, reciprocal peers and limits verified."],
  ["Check it's open", "routes(domain) on both ends: source outbound enabled, destination inbound not paused for the source."],
  ["Quote", "quoteSend as your wallet, shown in the source chain's native currency. Wallet, chain, amount, recipient or route changes invalidate it."],
  ["Send", "Simulated first, then send with that exact quote as value. You confirm recipient and destination before signing."],
  ["Awaiting delivery", "The TransferSent messageId is kept across reloads until the destination Mailbox reports delivered. Resubmitting would start a second transfer."],
  ["Delivered", "The destination balance refreshes. A failed attempt is retried by the relayer with the same message."],
];

function TransferSteps() {
  const root = useRef<HTMLOListElement>(null);
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      gsap.from(".ts-step", { y: 14, autoAlpha: 0, duration: 0.5, stagger: 0.07, ease: EASE.rise });
    },
    { scope: root },
  );
  return (
    <section>
      <SectionTitle kicker="Once a route is live" title="What a transfer will check" />
      <ol ref={root} data-reveal className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {STEPS.map(([t, b], i) => (
          <li key={t} className="ts-step panel p-4">
            <div className="mb-1 flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-white/10 font-mono text-[11px] text-ash">{i + 1}</span>
              <span className="text-[13.5px] font-semibold text-bone">{t}</span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-bone-dim">{b}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Masonry expansion, animated: chains sit on a ring around the xTOMB sigil.
 * Each "month" a Genesis pulse travels out, an arc fills on the next chain and
 * the chain stays lit. A planned roadmap item, separate from the xSHARE
 * bridge: these are Masonry launch candidates (Uniswap v4 + native USDC).
 */
function GenesisCadence() {
  const root = useRef<HTMLDivElement>(null);
  const [lit, setLit] = useState(MASONRY_CHAINS.length);
  const [month, setMonth] = useState<number | null>(null);
  const n = MASONRY_CHAINS.length;
  const W = 520;
  const C = W / 2;
  const R = 196;
  const pos = (i: number) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return { x: C + R * Math.cos(a), y: C + R * Math.sin(a) };
  };

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2, onRepeat: () => setLit(0) });
      tl.call(() => (setLit(0), setMonth(null)));
      tl.set(".gc-ring", { autoAlpha: 0.15 });
      for (let i = 0; i < n; i++) {
        const { x, y } = pos(i);
        tl.call(() => setMonth(i + 1))
          .fromTo(".gc-pulse", { attr: { cx: C, cy: C, r: 6 }, autoAlpha: 1 }, { attr: { cx: x, cy: y, r: 9 }, duration: 0.7, ease: EASE.rise, immediateRender: false })
          .fromTo(`.gc-arc-${i}`, { strokeDashoffset: 120 }, { strokeDashoffset: 0, duration: 0.9, ease: "none" })
          .call(() => setLit(i + 1))
          .fromTo(`.gc-ripple-${i}`, { attr: { r: 24 }, autoAlpha: 0.8 }, { attr: { r: 48 }, autoAlpha: 0, duration: 0.6, ease: "power2.out", immediateRender: false }, "<")
          .to(".gc-pulse", { autoAlpha: 0, duration: 0.15 });
      }
      tl.to(".gc-ring", { autoAlpha: 0.8, duration: 0.6 }).call(() => setMonth(null)).to({}, { duration: 1.6 });
      return () => tl.kill();
    },
    { scope: root },
  );

  return (
    <section data-reveal className="panel overflow-hidden p-5 md:p-7">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="label">Masonry expansion · one Genesis a month</span>
            <PlannedBadge label="Illustrative" />
          </div>
          <h2 className="min-h-[2.6em] font-display text-xl font-semibold leading-tight text-bone sm:min-h-0 md:text-2xl">
            {month ? `Month ${month} · Genesis on ${MASONRY_CHAINS[month - 1]!.name}` : lit >= n ? "xTOMB everywhere" : "Next Genesis"}
          </h2>
        </div>
        <div className="font-mono text-[12px] text-ash">
          {Math.min(lit, n)}/{n} chains
        </div>
      </div>
      <div ref={root} className="grid grid-cols-1 items-center gap-6 lg:grid-cols-[1fr_280px]">
        <div className="relative mx-auto w-full max-w-[520px]">
          <svg viewBox={`0 0 ${W} ${W}`} className="w-full" aria-hidden>
            <circle className="gc-ring" cx={C} cy={C} r={R} fill="none" stroke="#ff6a2b" strokeWidth="1.5" strokeDasharray="2 7" opacity={0.8} />
            {MASONRY_CHAINS.map((_, i) => {
              const { x, y } = pos(i);
              return (
                <g key={i}>
                  <line x1={C} y1={C} x2={x} y2={y} stroke={i < lit ? "rgba(255,106,43,0.35)" : "rgba(255,255,255,0.05)"} strokeWidth="1" />
                  <circle className={`gc-arc-${i}`} cx={x} cy={y} r={28} fill="none" stroke={i < lit ? "#ff8a3d" : "rgba(255,255,255,0.08)"} strokeWidth="2.5" strokeDasharray="120" strokeDashoffset={i < lit ? 0 : 120} transform={`rotate(-90 ${x} ${y})`} />
                  <circle className={`gc-ripple-${i}`} cx={x} cy={y} r={24} fill="none" stroke="#ffb547" strokeWidth="1.5" opacity={0} />
                </g>
              );
            })}
            <circle className="gc-pulse" cx={C} cy={C} r={6} fill="#ffb547" opacity={0} />
          </svg>
          {MASONRY_CHAINS.map((c, i) => {
            const { x, y } = pos(i);
            return (
              <span key={c.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${(x / W) * 100}%`, top: `${(y / W) * 100}%` }}>
                <ChainBadge id={c.id} name={c.name} size={36} lit={i < lit} />
              </span>
            );
          })}
          <span className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
            <Sigil size={56} glow />
            <span className="mt-1 font-display text-[13px] font-semibold text-bone">xTOMB</span>
          </span>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between px-1 font-mono text-[10.5px] text-ash">
            <span>Each one: 7-day Genesis</span>
            <span>v4 + native USDC</span>
          </div>
          <ol className="space-y-2">
            {MASONRY_CHAINS.slice(0, 6).map((c, i) => {
              const now = month === i + 1;
              const done = i < lit && !now;
              return (
                <li key={c.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors duration-500 ${now ? "border-ember/60 bg-ember/[0.09]" : done ? "border-ember/25 bg-ember/[0.04]" : "border-white/[0.06]"}`}>
                  <span className="w-[52px] shrink-0 font-mono text-[11px] text-ash">Month {i + 1}</span>
                  <ChainBadge id={c.id} name={c.name} size={22} lit={i < lit || now} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-bone-dim" title={c.name}>
                    {c.name}
                  </span>
                  <span className={`shrink-0 font-mono text-[10px] ${now ? "text-ember-hot" : done ? "text-ok" : "text-ash-dim"}`}>{now ? "live" : done ? "✓" : "·"}</span>
                </li>
              );
            })}
            <li className="px-3 font-mono text-[11px] text-ash">…and on, one chain a month</li>
          </ol>
        </div>
      </div>
      <p className="mt-4 text-[12px] text-ash">
        Masonry launch candidates have an official Uniswap v4 PoolManager and Circle-issued USDC. Order and dates aren't set, and bridge support doesn't certify a chain for a Masonry launch.
      </p>
    </section>
  );
}
