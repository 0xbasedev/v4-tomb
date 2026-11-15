/**
 * xTOMB peg-bot — oracle poster + buyback-and-burn executor.
 *
 * Two jobs, both guarded on-chain by the program:
 *   1. Post the TWAP: calls set_oracle(twap_e6, ts, currentAuthority).
 *      The TWAP value comes from --twap (USDC e6, e.g. 1000000 = $1.00)
 *      or --twap-file (a JSON file {"twap_e6": 987000}). A live
 *      price-feed integration (Jupiter / Raydium pool parse) is a TODO —
 *      until it exists, the operator supplies the TWAP. This bot key IS
 *      the oracle authority in config (rotatable by admin via
 *      set_oracle with a new authority).
 *   2. Peg defence: when the posted TWAP is at or below $1.01, the
 *      program's buyback_and_burn guard allows burning the bot's xTOMB
 *      (caller must be the bot wallet or admin). The bot burns up to
 *      --max-burn per run, bounded by its own xTOMB balance. It never
 *      custodies user funds — it only burns its own xTOMB (funded by
 *      its 1,000 xTOMB launch allocation + 15% operational fee share).
 *   3. Epoch settlement: with --advance-epochs, calls
 *      advance_epoch(false) each loop (permissionless settle of due
 *      epochs). Epoch 0 is NEVER triggered by this bot — that is a
 *      manual Admin action only.
 *
 * Env: RPC_URL (default devnet), KEYPAIR_PATH (default
 * ~/.config/solana/id.json), PROGRAM_ID (default from
 * config/xtomb.config.json). Flags: --dry-run (print, send nothing),
 * --once (single pass; default loops), --interval-secs (default 300),
 * --twap <e6>, --twap-file <path>, --max-burn <base units, default
 * 1000000 = 1 xTOMB>, --advance-epochs.
 *
 * NEVER run against mainnet.
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

// buyback_and_burn guard: fresh TWAP at or below $1.01.
const BUYBACK_MAX_TWAP_E6 = 1_010_000;
// Canonical Masonry pool id (see programs/xtomb/BUILD-NOTES.md §2.11).
const MASONRY_POOL_ID = 4;

function parseArgs(): {
  dryRun: boolean;
  once: boolean;
  intervalSecs: number;
  twapE6: number | null;
  twapFile: string | null;
  maxBurn: number;
  advanceEpochs: boolean;
} {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const twapFlag = get("--twap");
  return {
    dryRun: a.includes("--dry-run"),
    once: a.includes("--once"),
    intervalSecs: Number(get("--interval-secs") ?? "300"),
    twapE6: twapFlag != null ? Number(twapFlag) : null,
    twapFile: get("--twap-file") ?? null,
    maxBurn: Number(get("--max-burn") ?? "1000000"),
    advanceEpochs: a.includes("--advance-epochs"),
  };
}

function readTwap(args: ReturnType<typeof parseArgs>): number {
  if (args.twapE6 != null) return args.twapE6;
  if (args.twapFile != null) {
    const raw = JSON.parse(fs.readFileSync(args.twapFile, "utf8"));
    return Number(raw.twap_e6);
  }
  throw new Error(
    "No TWAP source: pass --twap <e6> or --twap-file <path>. " +
      "Live price-feed integration (Jupiter/Raydium) is still a TODO."
  );
}

function pda(seeds: (Buffer | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

async function runOnce(
  program: anchor.Program<Xtomb>,
  provider: anchor.AnchorProvider,
  args: ReturnType<typeof parseArgs>
): Promise<void> {
  const twapE6 = readTwap(args);
  const now = Math.floor(Date.now() / 1000);
  const [configPda] = pda([Buffer.from("config")]);
  let config: any;
  try {
    config = await program.account.config.fetch(configPda);
  } catch {
    throw new Error(
      `Config account ${configPda.toBase58()} not found — the program is not deployed/initialized yet. Run initialize_config first (see MORNING-REPORT.md).`
    );
  }
  const xtombMint: PublicKey = config.xtombMint;
  const caller = provider.wallet.publicKey;

  // 1. Post the TWAP (no rotation: pass the current authority back).
  console.log(`posting TWAP ${twapE6} e6 ($${twapE6 / 1e6})`);
  if (!args.dryRun) {
    const sig = await program.methods
      .setOracle(
        new anchor.BN(twapE6),
        new anchor.BN(now),
        config.oracleAuthority as PublicKey
      )
      // NB: `config` is NOT passed — Anchor 0.30 auto-derives it from
      // the constant ["config"] seeds in the IDL.
      .accounts({ caller })
      .rpc();
    console.log(`  oracle posted: ${sig}`);
  } else {
    console.log("  [dry-run] would send set_oracle, not sending");
  }

  // 2. Peg defence: buyback-and-burn while TWAP <= $1.01.
  if (twapE6 <= BUYBACK_MAX_TWAP_E6) {
    const callerXtomb = await getAssociatedTokenAddress(xtombMint, caller);
    let balance = 0;
    try {
      const acct = await provider.connection.getTokenAccountBalance(
        callerXtomb
      );
      balance = Number(acct.value.amount);
    } catch {
      balance = 0;
    }
    const amount = Math.min(args.maxBurn, balance);
    console.log(
      `  TWAP <= $1.01 — buyback guard open. Bot xTOMB balance ${balance}, burn amount ${amount}`
    );
    if (amount > 0) {
      if (!args.dryRun) {
        const sig = await program.methods
          .buybackAndBurn(new anchor.BN(amount))
          .accounts({
            caller,
            callerXtomb,
            xtombMint,
          })
          .rpc();
        console.log(`  burned ${amount} base units xTOMB: ${sig}`);
      } else {
        console.log("  [dry-run] would send buyback_and_burn, not sending");
      }
    } else {
      console.log("  nothing to burn (zero balance or zero max-burn)");
    }
  } else {
    console.log(`  TWAP above $1.01 — buyback guard closed, no burn`);
  }

  // 3. Epoch settlement (permissionless; Epoch 0 never triggered here).
  if (args.advanceEpochs) {
    const [masonryPool] = pda([
      Buffer.from("pool"),
      new anchor.BN(MASONRY_POOL_ID).toArrayLike(Buffer, "le", 8),
    ]);
    const masonryVault = pda([
      Buffer.from("vault"),
      Buffer.from("masonry"),
    ])[0];
    console.log("  settling due epochs via advance_epoch(false)");
    if (!args.dryRun) {
      const sig = await program.methods
        .advanceEpoch(false)
        .accounts({
          caller,
          xtombMint,
          masonryVault,
        })
        .rpc();
      console.log(`  advance_epoch: ${sig}`);
    } else {
      console.log("  [dry-run] would send advance_epoch, not sending");
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
  console.log(
    `xTOMB peg-bot: program ${PROGRAM_ID.toBase58()}, rpc ${RPC_URL}, ` +
      `wallet ${keypair.publicKey.toBase58()}, dryRun=${args.dryRun}`
  );
  for (;;) {
    await runOnce(program, provider, args);
    if (args.once) break;
    console.log(`sleeping ${args.intervalSecs}s…`);
    await new Promise((r) => setTimeout(r, args.intervalSecs * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
