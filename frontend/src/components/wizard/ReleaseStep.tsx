import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";

import { ChainBadge } from "@/components/ChainBadge";
import { PlannedBadge, Reason } from "@/components/Status";
import {
  BRIDGE,
  BRIDGE_DOMAINS,
  bridgeNetwork,
  bridgeNetworkStatus,
  HOOK_FLAGS,
  HOOK_MASK,
  MASONRY_ROLES,
  PATTERN_ROLES,
  patternProblem,
  planInWorker,
  randomReleaseId,
  releaseProblems,
  ROLE_LABEL,
  saveRelease,
  type AddressPatterns,
  type FullPlan,
  type PlannedRole,
} from "@/lib/create3";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";

/**
 * Wizard step 4 — the CREATE3 release plan. The deployment signer, a release
 * ID and optional per-role address patterns fix every project address before
 * anything is deployed: the Masonry components (hooks mined for their v4
 * permission bits), the xSHARE bridge and Bridged xSHARE. The shared planner
 * (config/create3-plan.mjs) does the work in a Web Worker. All of it is a
 * prediction; bridge routes stay disabled until a reviewed deployment is
 * published.
 */

export interface ReleaseState {
  deployer: string;
  releaseId: string;
  /** Satellite caps in whole xSHARE, by chain ID. */
  caps: Record<number, string>;
  operators: Record<number, { owner: string; ism: string }>;
  /** Optional address patterns by role; blank edges are dropped on export. */
  patterns: Record<string, { prefix: string; suffix: string }>;
}

export const emptyRelease = (): ReleaseState => ({ deployer: "", releaseId: "", caps: {}, operators: {}, patterns: {} });

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const toBaseUnits = (whole: string) => (/^[1-9]\d{0,59}$/.test(whole) ? `${whole}${"0".repeat(18)}` : null);

/** Only the patterns with something in them, normalised (no 0x, lower case). */
export function activePatterns(p: ReleaseState["patterns"]): AddressPatterns {
  return Object.fromEntries(
    Object.entries(p)
      .map(([role, { prefix, suffix }]) => [role, { prefix: prefix.trim().replace(/^0x/i, "").toLowerCase(), suffix: suffix.trim().replace(/^0x/i, "").toLowerCase() }] as const)
      .filter(([, v]) => v.prefix || v.suffix),
  );
}

/** The release JSON in config/create3-release.template.json's shape. */
export function releaseJson(r: ReleaseState, chainId: number) {
  const satellites = BRIDGE_DOMAINS.filter((id) => id !== chainId);
  return {
    releaseId: r.releaseId || null,
    deployer: r.deployer && isAddress(r.deployer, { strict: false }) ? getAddress(r.deployer) : r.deployer || null,
    canonicalDomain: chainId,
    canonicalTokenRole: "masonryShare",
    routeCaps: Object.fromEntries(satellites.flatMap((id) => (toBaseUnits(r.caps[id] ?? "") ? [[id, toBaseUnits(r.caps[id]!)]] : []))),
    bridgeOperators: Object.fromEntries(
      BRIDGE_DOMAINS.flatMap((id) => {
        const o = r.operators[id];
        return o && isAddress(o.owner, { strict: false }) && isAddress(o.ism, { strict: false }) ? [[id, { owner: getAddress(o.owner), ism: getAddress(o.ism) }]] : [];
      }),
    ),
    masonryInitCodeHashes: {},
    addressPatterns: activePatterns(r.patterns),
  };
}

/** Read a release.json back into the form. Returns the release and its home chain, or throws with a readable reason. */
export function importRelease(text: string): { release: ReleaseState; chainId: number | null } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const caps: Record<number, string> = {};
  for (const [id, v] of Object.entries((j.routeCaps as Record<string, string>) ?? {})) {
    if (typeof v === "string" && /^\d+$/.test(v)) {
      const whole = formatUnits(BigInt(v), 18);
      caps[Number(id)] = whole.includes(".") ? "" : whole;
    }
  }
  const patterns: ReleaseState["patterns"] = {};
  for (const [role, v] of Object.entries((j.addressPatterns as AddressPatterns) ?? {})) patterns[role] = { prefix: v.prefix ?? "", suffix: v.suffix ?? "" };
  const problem = patternProblem(activePatterns(patterns));
  if (problem) throw new Error(problem);
  return {
    release: {
      deployer: typeof j.deployer === "string" ? j.deployer : "",
      releaseId: typeof j.releaseId === "string" ? j.releaseId : "",
      caps,
      operators: (j.bridgeOperators as ReleaseState["operators"]) ?? {},
      patterns,
    },
    chainId: typeof j.canonicalDomain === "number" ? j.canonicalDomain : null,
  };
}

/** What's still missing for the repository's bridge planner to accept this release. */
export function bridgeInputGaps(r: ReleaseState, chainId: number): string[] {
  if (!BRIDGE_DOMAINS.includes(chainId)) return [];
  const j = releaseJson(r, chainId);
  const out: string[] = [];
  const caps = BRIDGE_DOMAINS.filter((id) => id !== chainId && !(j.routeCaps as Record<number, string>)[id]);
  const ops = BRIDGE_DOMAINS.filter((id) => !(j.bridgeOperators as Record<number, unknown>)[id]);
  if (caps.length) out.push(`route caps for ${caps.map((id) => bridgeNetwork(id)!.name).join(", ")}`);
  if (ops.length) out.push(`approved owner and ISM for ${ops.map((id) => bridgeNetwork(id)!.name).join(", ")}`);
  return out;
}

const samePlan = (plan: FullPlan | null, r: ReleaseState, chainId: number) =>
  !!plan &&
  plan.masonry.releaseId === r.releaseId &&
  plan.masonry.deployer.toLowerCase() === r.deployer.toLowerCase() &&
  plan.masonry.chainId === chainId &&
  JSON.stringify(plan.masonry.patterns) === JSON.stringify(activePatterns(r.patterns));

export function ReleaseStep({
  chainId,
  chainName,
  release,
  setRelease,
  plan,
  setPlan,
  onImportChain,
}: {
  chainId: number;
  chainName: string;
  release: ReleaseState;
  setRelease: (r: ReleaseState) => void;
  plan: FullPlan | null;
  setPlan: (p: FullPlan | null) => void;
  onImportChain: (id: number) => string | null;
}) {
  const { address } = useAccount();
  const root = useRef<HTMLDivElement>(null);
  const shimmer = useRef<HTMLDivElement>(null);
  const [searching, setSearching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const problems = releaseProblems(release);
  const patterns = activePatterns(release.patterns);
  const patternError = patternProblem(patterns);
  const ready = problems.length === 0 && !patternError;
  const bridgeHome = BRIDGE_DOMAINS.includes(chainId);
  const gaps = bridgeInputGaps(release, chainId);
  const patternKey = JSON.stringify(patterns);

  // Plan whenever the inputs settle. The worker is terminated if the signer,
  // release ID, chain or any pattern changes mid-search.
  useEffect(() => {
    setError(null);
    if (!ready) return setPlan(null);
    if (samePlan(plan, release, chainId)) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      setPlan(null);
      setSearching("starting");
      planInWorker({ releaseId: release.releaseId as Hex, deployer: release.deployer as Address, chainId, addressPatterns: patterns }, setSearching, ctl.signal)
        .then((p) => {
          if (ctl.signal.aborted) return;
          setPlan(p);
          saveRelease({ releaseId: p.masonry.releaseId, deployer: p.masonry.deployer as Address, canonicalDomain: chainId, canonicalTokenRole: "masonryShare", addressPatterns: patterns, bridge: p.bridge, savedAt: Date.now() });
        })
        .catch((e: Error) => {
          if (e.name !== "AbortError") setError(e.message);
        })
        .finally(() => {
          if (!ctl.signal.aborted) setSearching(null);
        });
    }, 400);
    return () => (ctl.abort(), window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [release.releaseId, release.deployer, chainId, patternKey, ready]);

  // Searches have no knowable end, so the bar shimmers instead of faking progress.
  useGSAP(
    () => {
      if (!searching || !shimmer.current || prefersReducedMotion()) return;
      const t = gsap.fromTo(shimmer.current, { xPercent: -100 }, { xPercent: 260, duration: 1.1, ease: "power1.inOut", repeat: -1 });
      return () => t.kill();
    },
    { dependencies: [!!searching] },
  );

  useGSAP(
    () => {
      if (!plan || prefersReducedMotion()) return;
      gsap.from(".rel-row", { y: 8, autoAlpha: 0, duration: 0.35, stagger: 0.016, ease: EASE.rise });
    },
    { scope: root, dependencies: [plan] },
  );

  const set = (patch: Partial<ReleaseState>) => setRelease({ ...release, ...patch });

  async function onFile(f: File | undefined) {
    if (!f) return;
    try {
      const { release: r, chainId: id } = importRelease(await f.text());
      setRelease(r);
      const chainNote = id === null ? "The file has no home chain; keeping the current one." : onImportChain(id);
      setImportNote(`Imported ${f.name}.${chainNote ? ` ${chainNote}` : ""}`);
    } catch (e) {
      setImportNote(`Couldn't import ${f.name}: ${(e as Error).message}`);
    }
  }

  return (
    <section ref={root} data-reveal className="space-y-5">
      <div className="panel p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-bone">4 · Release plan</h2>
            <p className="mt-1 max-w-2xl text-[13px] text-bone-dim">
              CreateX CREATE3: the deployment signer and release ID fix every project address before deployment — the same on each chain where the canonical factory exists. Home chain:{" "}
              <span className="text-bone">{chainName}</span>.
            </p>
          </div>
          <label className="btn h-9 cursor-pointer px-3 text-[12.5px]">
            Import release.json
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => (void onFile(e.target.files?.[0]), (e.target.value = ""))} aria-label="Import release JSON" />
          </label>
        </div>
        {importNote && <Reason tone={importNote.startsWith("Couldn't") ? "warn" : "ash"}>{importNote}</Reason>}

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1 text-[12.5px]">
            <span className="flex items-center justify-between text-ash">
              <label htmlFor="rel-deployer">Deployment signer</label>
              {address && (
                <button type="button" className="font-mono text-[11px] text-ember-hot hover:underline" onClick={() => set({ deployer: address })}>
                  use connected wallet
                </button>
              )}
            </span>
            <input id="rel-deployer" value={release.deployer} onChange={(e) => set({ deployer: e.target.value.trim() })} placeholder="0x… the account that broadcasts" aria-label="Deployment signer" className="well px-2 py-1.5 font-mono text-bone" spellCheck={false} />
            <span className="text-[10.5px] text-ash-dim">The wallet that signs the deploys. CreateX guards the salt with it, so changing it changes every address.</span>
          </div>
          <div className="flex flex-col gap-1 text-[12.5px]">
            <span className="flex items-center justify-between text-ash">
              <label htmlFor="rel-id">Release ID</label>
              <button type="button" className="font-mono text-[11px] text-ember-hot hover:underline" onClick={() => set({ releaseId: randomReleaseId() })}>
                generate
              </button>
            </span>
            <input id="rel-id" value={release.releaseId} onChange={(e) => set({ releaseId: e.target.value.trim() })} placeholder="0x… 32 bytes" aria-label="Release ID" className="well px-2 py-1.5 font-mono text-[11.5px] text-bone" spellCheck={false} />
            <span className="text-[10.5px] text-ash-dim">Keep it fixed through deployment and publication. A different configuration needs a new ID.</span>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px] text-ash">
          <span className="rounded-lg border border-white/[0.07] px-2 py-1">canonical token role · masonryShare (modern launch)</span>
          <span className="rounded-lg border border-white/[0.07] px-2 py-1">factory · CreateX 0xba5E…a5Ed</span>
        </div>

        <PatternEditor patterns={release.patterns} setPatterns={(p) => set({ patterns: p })} error={patternError} />

        {!ready && (release.deployer || release.releaseId) && problems.length > 0 && (
          <ul className="mt-3 space-y-1 text-[12px] text-warn" role="status">
            {problems.map((x) => (
              <li key={x}>• {x}</li>
            ))}
          </ul>
        )}
        {searching && (
          <div className="mt-4" role="status" aria-live="polite">
            <div className="mb-1 flex justify-between font-mono text-[11px] text-ash">
              <span>{searching === "starting" ? "Planning addresses…" : `Searching for ${ROLE_LABEL[searching as PlannedRole] ?? searching}${HOOK_FLAGS[searching] ? " · hook permission bits" : " · your pattern"}…`}</span>
              <span>CreateX · off the main thread</span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div ref={shimmer} className="absolute inset-y-0 w-2/5 rounded-full bg-gradient-to-r from-transparent via-ember-hot to-transparent" />
            </div>
          </div>
        )}
        {error && <Reason tone="warn">{error}</Reason>}
      </div>

      {plan && (
        <div className="panel p-5 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="label">Predicted · Masonry components</span>
            <PlannedBadge label="Prediction · not deployed" />
          </div>
          <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2" data-testid="predicted-masonry">
            {MASONRY_ROLES.map((role) => {
              const a = plan.masonry.addresses[role];
              const hookOk = HOOK_FLAGS[role] === undefined || (BigInt(a) & HOOK_MASK) === HOOK_FLAGS[role];
              const notes = [
                role in plan.masonry.hookNonces ? `nonce ${plan.masonry.hookNonces[role]} · flags ${hookOk ? "0x35c8 ✓" : "✕"}` : null,
                plan.masonry.addressNonces?.[role] !== undefined ? `pattern · nonce ${plan.masonry.addressNonces[role]}` : null,
              ].filter(Boolean);
              return <AddressRow key={role} label={ROLE_LABEL[role]} role={role} address={a} note={notes.join(" · ") || undefined} highlight={patterns[role]} />;
            })}
          </ul>
          <Reason>
            Each component's reviewed creation bytecode hash goes into <span className="font-mono">masonryInitCodeHashes</span> before its deploy; the component script checks hash, expected address and chain. Set patterns first — constructors may refer to these addresses.
          </Reason>
        </div>
      )}

      <div className="panel p-5 md:p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="label">xSHARE bridge · Hyperlane</span>
          <PlannedBadge label="Routes disabled" />
        </div>
        {!bridgeHome ? (
          <p className="text-[13px] text-bone-dim">
            {chainName} isn't one of the five bridge networks, so this release can't be the bridge home. The bridge connects {BRIDGE.networks.map((n) => n.name).join(", ")}; pick one of them as the home chain to plan it.
          </p>
        ) : !plan?.bridge ? (
          <p className="text-[13px] text-bone-dim">{searching ? "Planning…" : "Enter the signer and release ID to predict the bridge and Bridged xSHARE addresses."}</p>
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2" data-testid="predicted-bridge">
              <AddressRow label={ROLE_LABEL.xshareBridge} role="xshareBridge" address={plan.bridge.bridge} highlight={patterns.xshareBridge} />
              <AddressRow label={ROLE_LABEL.bridgedShare} role="bridgedShare" address={plan.bridge.bridgedShare} highlight={patterns.bridgedShare} />
            </ul>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-5">
              {BRIDGE.networks.map((n) => {
                const home = n.id === chainId;
                return (
                  <div key={n.id} className={`rel-row rounded-xl border p-2.5 ${home ? "border-spectre/40 bg-spectre/[0.05]" : "border-white/[0.06] bg-black/20"}`}>
                    <div className="flex items-center gap-2">
                      <ChainBadge id={n.id} name={n.name} size={20} lit={home} />
                      <span className="truncate text-[12px] font-semibold text-bone">{n.name}</span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-ash">{home ? "home · original xSHARE" : "Bridged xSHARE"}</div>
                    <div className="font-mono text-[10.5px] text-bone-dim">{short(plan.bridge!.tokens[n.id]!)}</div>
                    <div className="mt-1 text-[10.5px] text-warn">{bridgeNetworkStatus(n)}</div>
                  </div>
                );
              })}
            </div>
            <details className="mt-4 rounded-xl border border-white/[0.06] bg-black/20 p-3">
              <summary className="cursor-pointer text-[13px] font-semibold text-bone">
                Bridge release inputs {gaps.length ? <span className="ml-1 text-[11px] font-normal text-warn">· incomplete</span> : <span className="ml-1 text-[11px] font-normal text-ok">· complete</span>}
              </summary>
              <p className="mt-2 text-[12px] text-bone-dim">
                The repository's bridge planner needs a cap for each satellite route and an approved owner and ISM on every network. The checked-in default ISMs are observed reference data, not an approval.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3">
                {BRIDGE.networks.map((n) => {
                  const home = n.id === chainId;
                  const op = release.operators[n.id] ?? { owner: "", ism: "" };
                  return (
                    <div key={n.id} className="grid grid-cols-1 gap-2 rounded-lg border border-white/[0.05] p-2.5 sm:grid-cols-[150px_1fr_1fr_140px] sm:items-end">
                      <div className="text-[12.5px] text-bone">
                        {n.name}
                        <div className="font-mono text-[10px] text-ash">{home ? "home" : `route cap from ${chainName}`}</div>
                      </div>
                      <input aria-label={`${n.name} bridge owner`} placeholder="owner 0x…" value={op.owner} onChange={(e) => set({ operators: { ...release.operators, [n.id]: { ...op, owner: e.target.value.trim() } } })} className="well px-2 py-1.5 font-mono text-[11px] text-bone" spellCheck={false} />
                      <input aria-label={`${n.name} ISM`} placeholder="ISM 0x…" value={op.ism} onChange={(e) => set({ operators: { ...release.operators, [n.id]: { ...op, ism: e.target.value.trim() } } })} className="well px-2 py-1.5 font-mono text-[11px] text-bone" spellCheck={false} />
                      {home ? (
                        <span className="font-mono text-[10.5px] text-ash-dim">no cap at home</span>
                      ) : (
                        <input aria-label={`${n.name} route cap`} placeholder="cap · whole xSHARE" inputMode="numeric" value={release.caps[n.id] ?? ""} onChange={(e) => set({ caps: { ...release.caps, [n.id]: e.target.value.replace(/[^0-9]/g, "") } })} className="well px-2 py-1.5 font-mono text-[11px] text-bone" />
                      )}
                    </div>
                  );
                })}
              </div>
              {gaps.length > 0 && <Reason tone="warn">Still needed: {gaps.join("; ")}.</Reason>}
            </details>
          </>
        )}
      </div>

      <div className="panel p-5 md:p-6">
        <div className="label mb-2">Regenerate and verify from the repository</div>
        <pre className="overflow-x-auto rounded-xl bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-bone-dim">{`node scripts/create3.mjs masonry - config/release.json config/masonry.release.json
node scripts/create3.mjs bridge config/xshare-bridge.json config/release.json config/xshare-bridge.release.json`}</pre>
        <Reason>Both commands and this page run the same planner (config/create3-plan.mjs), patterns and mined nonces included. Deploy scripts check every planned address before broadcasting.</Reason>
      </div>
    </section>
  );
}

/** Optional prefix/suffix per role, validated live by the shared planner's rules. */
function PatternEditor({ patterns, setPatterns, error }: { patterns: ReleaseState["patterns"]; setPatterns: (p: ReleaseState["patterns"]) => void; error: string | null }) {
  const [role, setRole] = useState<PlannedRole>("masonryPeg");
  const cur = patterns[role] ?? { prefix: "", suffix: "" };
  const hook = HOOK_FLAGS[role] !== undefined;
  const custom = Object.entries(activePatterns(patterns));
  const put = (patch: Partial<{ prefix: string; suffix: string }>) => setPatterns({ ...patterns, [role]: { ...cur, ...patch } });
  const hex = (v: string) => v.replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "").slice(0, 8);
  // Open by default when a plan already has patterns; afterwards the user decides.
  const [open, setOpen] = useState(() => custom.length > 0);
  return (
    <details className="mt-4 rounded-xl border border-white/[0.06] bg-black/20 p-3" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-[13px] font-semibold text-bone">
        Custom contract addresses <span className="font-normal text-ash">(optional){custom.length ? ` · ${custom.length} set` : ""}</span>
      </summary>
      <p className="mt-2 text-[12px] text-bone-dim">
        Give a contract a recognisable start, end or both — <span className="font-mono">dead</span> as a suffix looks for <span className="font-mono">0x…dead</span>. Hex only, up to four characters total for most contracts. Longer patterns take longer to find.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1.4fr_1fr_1fr]">
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-ash">Contract</span>
          <select value={role} onChange={(e) => setRole(e.target.value as PlannedRole)} className="well px-2 py-1.5 text-bone" aria-label="Contract to customize">
            {PATTERN_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
                {activePatterns(patterns)[r] ? " · custom" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-ash">Prefix (after 0x)</span>
          <input value={cur.prefix} onChange={(e) => put({ prefix: hex(e.target.value) })} placeholder="e.g. ab" className="well px-2 py-1.5 font-mono text-bone" aria-label="Address prefix" spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-ash">Suffix (at the end)</span>
          <input value={cur.suffix} onChange={(e) => put({ suffix: hex(e.target.value) })} placeholder={hook ? "e.g. 35c8" : "e.g. dead"} className="well px-2 py-1.5 font-mono text-bone" aria-label="Address suffix" spellCheck={false} />
        </label>
      </div>
      {hook && (
        <p className="mt-2 text-[11.5px] text-ash">
          Uniswap hook permissions already fix the low 14 bits of this address (<span className="font-mono">0x35c8</span>). A suffix must agree with them; a one-character prefix or a suffix like <span className="font-mono">35c8</span> works.
        </p>
      )}
      {error && (
        <p className="mt-2 text-[12px] text-warn" role="alert">
          {error}
        </p>
      )}
      {custom.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {custom.map(([r, v]) => (
            <li key={r} className="flex items-center gap-1.5 rounded-lg border border-ember/30 bg-ember/[0.06] px-2 py-1 font-mono text-[11px] text-bone">
              {ROLE_LABEL[r as PlannedRole] ?? r}: 0x{v.prefix || ""}…{v.suffix || ""}
              <button type="button" aria-label={`Clear pattern for ${r}`} onClick={() => setPatterns({ ...patterns, [r]: { prefix: "", suffix: "" } })} className="text-ash hover:text-bad">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function AddressRow({ label, role, address, note, highlight }: { label: string; role: string; address: Address; note?: string; highlight?: { prefix?: string; suffix?: string } }) {
  const [copied, setCopied] = useState(false);
  // Show the matched pattern in the shortened address so the result is visible at a glance.
  const p = highlight?.prefix ?? "";
  const s = highlight?.suffix ?? "";
  const head = address.slice(0, 2 + Math.max(4, p.length));
  const tail = address.slice(-Math.max(4, s.length));
  return (
    <li className="rel-row flex items-center justify-between gap-3 border-b border-white/[0.04] py-1.5">
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-bone-dim">{label}</span>
        <span className="block font-mono text-[10px] text-ash-dim">
          {role}
          {note ? ` · ${note}` : ""}
        </span>
      </span>
      <button
        type="button"
        title={address}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          } catch {
            /* clipboard blocked; the full address is in the title */
          }
        }}
        className="shrink-0 rounded-lg border border-white/[0.07] px-2 py-1 font-mono text-[11px] text-bone hover:border-white/20"
      >
        {copied ? (
          "copied"
        ) : (
          <>
            {p ? (
              <>
                0x<span className="text-ember-hot">{head.slice(2, 2 + p.length)}</span>
                {head.slice(2 + p.length)}
              </>
            ) : (
              head
            )}
            …
            {s ? (
              <>
                {tail.slice(0, tail.length - s.length)}
                <span className="text-ember-hot">{tail.slice(-s.length)}</span>
              </>
            ) : (
              tail
            )}
          </>
        )}
      </button>
    </li>
  );
}
