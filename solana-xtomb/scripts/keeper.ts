/**
 * xTOMB keeper — auto-compound crank (Pro 6h / Ultra 3h).
 *
 * Reads the on-chain Config, and for every owner listed in
 * scripts/owners.json (or --owners <file>) checks their Pass tier and
 * each pool's Position. A position is due when BOTH hold:
 *   - the tier cadence has elapsed since the shared 3h clock
 *     (last_cooldown_ts): Pro 6h, Ultra 3h (Genesis tier has no keeper);
 *   - the on-chain 3h hard cap allows it (the program reverts anyway
 *     if called too soon — this check just avoids wasted transactions).
 * Due positions get compound(pool_id, is_keeper=true). The 2% keeper
 * fee goes to Treasury, not to the keeper, so there is no rent-seeking
 * incentive in running this crank.
 *
 * Env: RPC_URL (default devnet), KEYPAIR_PATH (default
 * ~/.config/solana/id.json), PROGRAM_ID (default from
 * config/xtomb.config.json). Flags: --dry-run (print, send nothing),
 * --once (single pass; default loops), --interval-secs (default 600),
 * --owners <file>, --pools <csv of pool ids, default 1,2,3,4>.
 *
 * NEVER run against mainnet. The keeper keypair needs only enough SOL
 * for transaction fees; it never custodies user funds.
 *
 * Status: WRITTEN 2026-11-05, typechecked with tsc --noEmit. NOT run
 * against a live program — no program is deployed yet. Verify with
 * --dry-run first once a program exists.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import type { Xtomb } from "../target/types/xtomb";

const ROOT = path.resolve(__dirname, "..");
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(ROOT, "config", "xtomb.config.json"), "utf8")
);
const IDL = JSON.parse(
  fs.readFileSync(path.join(ROOT, "target", "idl", "xtomb.json"), "utf8")
);
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? CONFIG.meta.program_id_devnet
);
const RPC_URL =
  process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ??
  path.join(process.env.HOME ?? "~", ".config", "solana", "id.json");

// Tier cadences (hours). Tier 1 Genesis has no keeper.
const TIER_CADENCE_HOURS: Record<number, number | null> = {
  1: null,
  2: CONFIG.passes.Pro.auto_compound_hours,
  3: CONFIG.passes.Ultra.auto_compound_hours,
};
const HARD_CAP_SECONDS =
  CONFIG.compound.hard_cap_hours_per_user_per_pool * 3600;

function parseArgs(): {
  dryRun: boolean;
  once: boolean;
  intervalSecs: number;
  ownersFile: string;
  pools: number[];
} {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    dryRun: a.includes("--dry-run"),
    once: a.includes("--once"),
    intervalSecs: Number(get("--interval-secs") ?? "600"),
    ownersFile:
      get("--owners") ?? path.join(__dirname, "owners.json"),
    pools: (get("--pools") ?? "1,2,3,4")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n)),
  };
}

function loadOwners(file: string): PublicKey[] {
  if (!fs.existsSync(file)) {
    console.log(`No owners file at ${file} — nothing to compound.`);
    console.log(
      "Create it (or copy owners.example.json) with {\"owners\": [\"<pubkey>\", ...]}."
    );
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list: string[] = raw.owners ?? [];
  return list.map((s) => new PublicKey(s));
}

function pda(seeds: (Buffer | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

async function runOnce(
  program: anchor.Program<Xtomb>,
  provider: anchor.AnchorProvider,
  owners: PublicKey[],
  pools: number[],
  dryRun: boolean
): Promise<void> {
  const [configPda] = pda([Buffer.from("config")]);
  let config: any;
  try {
    config = await program.account.config.fetch(configPda);
  } catch {
    throw new Error(
      `Config account ${configPda.toBase58()} not found — the program is not deployed/initialized yet. Run initialize_config first (see MORNING-REPORT.md).`
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const xtombMint: PublicKey = config.xtombMint;
  const treasuryWallet: PublicKey = config.treasuryWallet;
  const rewardsVault = pda([Buffer.from("vault"), Buffer.from("rewards")])[0];
  const treasuryXtomb = await getAssociatedTokenAddress(
    xtombMint,
    treasuryWallet
  );

  for (const owner of owners) {
    const [passPda] = pda([
      Buffer.from("pass"),
      owner.toBuffer(),
    ]);
    let pass: any;
    try {
      pass = await program.account.pass.fetch(passPda);
    } catch {
      console.log(`  ${owner.toBase58()}: no pass — skip`);
      continue;
    }
    const cadenceHours = TIER_CADENCE_HOURS[pass.tier as number];
    if (cadenceHours == null) {
      console.log(
        `  ${owner.toBase58()}: tier ${pass.tier} (Genesis) has no keeper — skip`
      );
      continue;
    }
    const cadenceSecs = cadenceHours * 3600;
    for (const poolId of pools) {
      const [poolPda] = pda([
        Buffer.from("pool"),
        new anchor.BN(poolId).toArrayLike(Buffer, "le", 8),
      ]);
      const [positionPda] = pda([
        Buffer.from("position"),
        owner.toBuffer(),
        new anchor.BN(poolId).toArrayLike(Buffer, "le", 8),
      ]);
      let position: any;
      try {
        position = await program.account.position.fetch(positionPda);
      } catch {
        continue; // no position in this pool
      }
      const sinceCooldown = now - Number(position.lastCooldownTs);
      const due =
        sinceCooldown >= cadenceSecs && sinceCooldown >= HARD_CAP_SECONDS;
      if (!due) {
        console.log(
          `  ${owner.toBase58()} pool ${poolId}: not due (${sinceCooldown}s since last claim/compound, cadence ${cadenceSecs}s)`
        );
        continue;
      }
      console.log(
        `  ${owner.toBase58()} pool ${poolId}: DUE — compounding (keeper)`
      );
      if (dryRun) {
        console.log("    [dry-run] would send compound, not sending");
        continue;
      }
      const sig = await program.methods
        .compound(new anchor.BN(poolId), true)
        .accounts({
          caller: provider.wallet.publicKey,
          owner,
          // NB (Anchor 0.30): PDA accounts (config, pool, position,
          // pass) and well-known programs (token/system) are
          // auto-derived by the client from the IDL and must NOT be
          // passed — only non-PDA accounts go here.
          rewardsVault,
          treasuryXtomb,
          xtombMint,
        })
        .rpc();
      console.log(`    compounded: ${sig}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const connection = new Connection(RPC_URL, "confirmed");
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")) as number[]
    )
  );
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // Anchor 0.30: Program takes (idl, provider); the program id comes
  // from idl.address (top-level in target/idl/xtomb.json).
  const program = new anchor.Program<Xtomb>(IDL, provider);
  const owners = loadOwners(args.ownersFile);
  console.log(
    `xTOMB keeper: program ${PROGRAM_ID.toBase58()}, rpc ${RPC_URL}, ` +
      `wallet ${keypair.publicKey.toBase58()}, dryRun=${args.dryRun}`
  );
  if (owners.length === 0) return;
  for (;;) {
    await runOnce(program, provider, owners, args.pools, args.dryRun);
    if (args.once) break;
    console.log(`sleeping ${args.intervalSecs}s…`);
    await new Promise((r) => setTimeout(r, args.intervalSecs * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
