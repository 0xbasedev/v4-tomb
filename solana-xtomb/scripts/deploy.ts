/**
 * xTOMB devnet deploy driver — runs the post-deploy init steps in order:
 *
 *   npx ts-node scripts/deploy.ts mock-usdc  — create mock USDC + fund payer 100,000
 *   npx ts-node scripts/deploy.ts init      — initialize_config
 *   npx ts-node scripts/deploy.ts mints     — create_mints (+ fund vaults)
 *   npx ts-node scripts/deploy.ts wallets   — set_wallets + set_oracle (TWAP $1.00)
 *   npx ts-node scripts/deploy.ts verify    — read back config + vault balances
 *
 * Add --dry-run to any step to print the planned call without sending.
 *
 * Rehearsal choices (recorded in DEPLOY-REPORT.md, changeable by admin
 * instructions afterwards): all four wallets + oracle authority are the
 * payer wallet (the only funded devnet wallet); USDC is the mock USDC
 * mint created by `mock-usdc` (Circle devnet USDC exists on-chain but the
 * deployer holds none of it, so Genesis deposits could not be tested
 * otherwise); Genesis starts at the on-chain clock time when init runs
 * (7-day window); Genesis budget 30,000 xTOMB; bond max 1,000,000 xBOND.
 *
 * Confirmation uses HTTP polling, NOT the websocket: devnet wss is broken
 * from this sandbox (EPROTO on the socket), so the stock Anchor `.rpc()`
 * confirmation times out even when the transaction lands. All sends go
 * through sendAndConfirmHttp below.
 *
 * DEVNET ONLY. Never run against mainnet.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
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
const PROGRAM_ID = new PublicKey(CONFIG.meta.program_id_devnet);
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ??
  path.join(process.env.HOME ?? "~", ".config", "solana", "id.json");

// Circle devnet USDC (exists on-chain but the deployer holds none of it).
const CIRCLE_DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const GENESIS_BUDGET = 30_000_000_000; // 30,000 xTOMB, 6 decimals
const BOND_MAX = 1_000_000_000_000; // 1,000,000 xBOND, 6 decimals
const INITIAL_TWAP_E6 = 1_000_000; // $1.00
const MOCK_USDC_AMOUNT = 100_000_000_000; // 100,000 mock USDC, 6 decimals

function pda(seeds: (Buffer | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

async function chainNow(connection: Connection): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const t = await connection.getBlockTime(slot);
  return t ?? Math.floor(Date.now() / 1000);
}

function saveMintKeypair(name: string, kp: Keypair): string {
  const file = path.join(ROOT, "target", "deploy", `${name}-mint.json`);
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  fs.chmodSync(file, 0o600);
  return file;
}

function saveMintAddress(name: string, mint: PublicKey): void {
  fs.writeFileSync(
    path.join(ROOT, "target", "deploy", `${name}-mint.txt`),
    mint.toBase58() + "\n"
  );
}

function loadMintKeypair(name: string): Keypair | null {
  const file = path.join(ROOT, "target", "deploy", `${name}-mint.json`);
  if (!fs.existsSync(file)) return null;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[])
  );
}

function loadMintAddress(name: string): PublicKey | null {
  const file = path.join(ROOT, "target", "deploy", `${name}-mint.txt`);
  if (!fs.existsSync(file)) return null;
  return new PublicKey(fs.readFileSync(file, "utf8").trim());
}

// USDC for initialize_config, in priority order:
//   1. USDC_MINT env var
//   2. mock USDC mint created by `deploy.ts mock-usdc`
//   3. Circle devnet USDC
function resolveUsdcMint(): PublicKey {
  if (process.env.USDC_MINT) return new PublicKey(process.env.USDC_MINT);
  const kp = loadMintKeypair("mock-usdc");
  if (kp) return kp.publicKey;
  const addr = loadMintAddress("mock-usdc");
  if (addr) return addr;
  return CIRCLE_DEVNET_USDC;
}

function payerKeypair(provider: anchor.AnchorProvider): Keypair {
  return (provider.wallet as anchor.Wallet).payer;
}

/**
 * Send a transaction and confirm over HTTP polling. Devnet wss is broken
 * from this sandbox, so the websocket-based confirmation in web3.js /
 * Anchor `.rpc()` times out even when the transaction lands. Polls
 * getSignatureStatuses until confirmed/finalized, and re-checks once
 * after the blockhash expires before declaring failure.
 */
async function sendAndConfirmHttp(
  connection: Connection,
  payer: Keypair,
  tx: Transaction,
  extraSigners: Keypair[] = []
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.partialSign(payer, ...extraSigners);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  for (;;) {
    const st = await connection.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (
      s &&
      (s.confirmationStatus === "confirmed" ||
        s.confirmationStatus === "finalized")
    ) {
      if (s.err) {
        throw new Error(`tx ${sig} failed on-chain: ${JSON.stringify(s.err)}`);
      }
      return sig;
    }
    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      const st2 = await connection.getSignatureStatuses([sig]);
      const s2 = st2.value[0];
      if (s2 && s2.confirmationStatus) {
        if (s2.err) {
          throw new Error(
            `tx ${sig} failed on-chain: ${JSON.stringify(s2.err)}`
          );
        }
        return sig;
      }
      throw new Error(
        `tx ${sig} expired (block height exceeded) and is not confirmed`
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Create a mock USDC SPL mint (6 decimals, mint authority = payer, no
 * freeze authority) and mint 100,000 to the payer's ATA, so Genesis USDC
 * deposits can actually be tested on devnet. Idempotent: reuses an
 * existing mint (keypair file or address file), skips creation if the
 * mint already exists, skips the mint if the ATA already holds >= the
 * test amount. The mint keypair is saved BEFORE sending, so a
 * confirmation failure can never orphan the mint address.
 * This is a MOCK for testing, not real USDC.
 */
async function doMockUsdc(
  provider: anchor.AnchorProvider,
  dryRun: boolean
): Promise<void> {
  const payer = payerKeypair(provider);
  const connection = provider.connection;
  const existingKp = loadMintKeypair("mock-usdc");
  const existingAddr = loadMintAddress("mock-usdc");
  let mintKp: Keypair | null = existingKp;
  let mint: PublicKey;
  if (mintKp) {
    mint = mintKp.publicKey;
  } else if (existingAddr) {
    mint = existingAddr;
  } else {
    mintKp = Keypair.generate();
    mint = mintKp.publicKey;
  }
  console.log(`mock USDC mint: ${mint.toBase58()}`);
  const mintInfo = await connection.getAccountInfo(mint);
  const mintExists = mintInfo !== null;
  console.log(`  mint exists on-chain: ${mintExists}`);
  if (dryRun) {
    console.log("dry-run: not sending.");
    return;
  }
  if (!mintExists) {
    if (!mintKp) {
      throw new Error(
        `mock USDC mint ${mint.toBase58()} does not exist on-chain and no keypair is saved — cannot create it`
      );
    }
    // Save BEFORE sending so a confirmation failure never orphans the mint.
    saveMintKeypair("mock-usdc", mintKp);
    saveMintAddress("mock-usdc", mint);
    const mintRent =
      await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint,
        lamports: mintRent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mint, 6, payer.publicKey, null)
    );
    const sig = await sendAndConfirmHttp(connection, payer, tx, [mintKp]);
    console.log(`  mock USDC mint created, signature: ${sig}`);
    console.log(
      "  keypair saved to target/deploy/mock-usdc-mint.json (0600), address to mock-usdc-mint.txt"
    );
  }
  const ata = await getAssociatedTokenAddress(mint, payer.publicKey);
  const ataInfo = await connection.getAccountInfo(ata);
  if (!ataInfo) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        payer.publicKey,
        mint
      )
    );
    const sig = await sendAndConfirmHttp(connection, payer, tx);
    console.log(`  payer ATA created (${ata.toBase58()}), signature: ${sig}`);
  }
  const balBefore = await connection.getTokenAccountBalance(ata);
  console.log(`  payer ATA: ${ata.toBase58()}, balance before: ${balBefore.value.amount}`);
  if (BigInt(balBefore.value.amount) < BigInt(MOCK_USDC_AMOUNT)) {
    const tx = new Transaction().add(
      createMintToInstruction(
        mint,
        ata,
        payer.publicKey,
        MOCK_USDC_AMOUNT
      )
    );
    const sig = await sendAndConfirmHttp(connection, payer, tx);
    console.log(
      `  minted ${MOCK_USDC_AMOUNT} (100,000 mock USDC), signature: ${sig}`
    );
  } else {
    console.log("  ATA already funded — skip mint.");
  }
  const balAfter = await connection.getTokenAccountBalance(ata);
  console.log(`  payer mock USDC balance: ${balAfter.value.amount}`);
  console.log("  NOTE: this is a MOCK USDC for devnet testing, not real USDC.");
}

async function doInit(
  program: anchor.Program<Xtomb>,
  provider: anchor.AnchorProvider,
  dryRun: boolean
): Promise<void> {
  const payer = payerKeypair(provider);
  const [configPda] = pda([Buffer.from("config")]);
  const existing = await program.account.config
    .fetchNullable(configPda)
    .catch(() => null);
  if (existing) {
    console.log(`Config already initialized at ${configPda.toBase58()} — skip.`);
    return;
  }
  const genesisStart = await chainNow(provider.connection);
  const usdcMint = resolveUsdcMint();
  console.log("initialize_config plan:");
  console.log(`  config PDA: ${configPda.toBase58()}`);
  console.log(`  admin/payer: ${payer.publicKey.toBase58()}`);
  console.log(`  treasury/team/dev/bot/oracle: ${payer.publicKey.toBase58()} (rehearsal)`);
  console.log(`  usdc mint: ${usdcMint.toBase58()}`);
  console.log(`  genesis start (unix): ${genesisStart} (${new Date(genesisStart * 1000).toISOString()})`);
  console.log(`  genesis budget: ${GENESIS_BUDGET} (30,000 xTOMB)`);
  console.log(`  bond max outstanding: ${BOND_MAX} (1,000,000 xBOND)`);
  if (dryRun) {
    console.log("dry-run: not sending.");
    return;
  }
  const tx = await program.methods
    .initializeConfig(
      payer.publicKey,
      payer.publicKey,
      payer.publicKey,
      payer.publicKey,
      payer.publicKey,
      usdcMint,
      new anchor.BN(genesisStart),
      new anchor.BN(GENESIS_BUDGET),
      new anchor.BN(BOND_MAX)
    )
    // NB (Anchor 0.30): config PDA + system program are auto-derived
    // from the IDL and must NOT be passed — only non-PDA accounts go here.
    .accounts({
      admin: payer.publicKey,
    })
    .transaction();
  const sig = await sendAndConfirmHttp(provider.connection, payer, tx);
  console.log(`initialize_config signature: ${sig}`);
  const cfg: any = await program.account.config.fetch(configPda);
  console.log(`  genesis window: ${cfg.genesisStartTs} -> ${cfg.genesisEndTs}`);
  console.log(`  budget: ${cfg.genesisRewardBudget}, emission/sec: ${cfg.genesisEmissionPerSec}`);
  console.log(`  fee split bps: treasury ${cfg.treasuryBps} team ${cfg.teamBps} dev ${cfg.devBps} bot ${cfg.botBps}`);
}

async function doMints(
  program: anchor.Program<Xtomb>,
  provider: anchor.AnchorProvider,
  dryRun: boolean
): Promise<void> {
  const payer = payerKeypair(provider);
  const [configPda] = pda([Buffer.from("config")]);
  const cfg: any = await program.account.config.fetch(configPda);
  if (cfg.xtombMint.toBase58() !== PublicKey.default.toBase58()) {
    console.log(`Mints already created: xtomb ${cfg.xtombMint.toBase58()} — skip.`);
    return;
  }
  const xtombKp = loadMintKeypair("xtomb") ?? Keypair.generate();
  const xshareKp = loadMintKeypair("xshare") ?? Keypair.generate();
  const xbondKp = loadMintKeypair("xbond") ?? Keypair.generate();
  console.log("create_mints plan:");
  console.log(`  xtomb mint: ${xtombKp.publicKey.toBase58()}`);
  console.log(`  xshare mint: ${xshareKp.publicKey.toBase58()}`);
  console.log(`  xbond mint: ${xbondKp.publicKey.toBase58()}`);
  console.log("  vaults: rewards 30,000 xTOMB / farm 25,641 xSHARE / vesting 6,941 xSHARE / treasury 11,000 xTOMB + 751 xSHARE");
  if (dryRun) {
    console.log("dry-run: not sending, keypairs not saved.");
    return;
  }
  // Save keypairs BEFORE sending so a failure after send still leaves us
  // able to identify the mints.
  saveMintKeypair("xtomb", xtombKp);
  saveMintKeypair("xshare", xshareKp);
  saveMintKeypair("xbond", xbondKp);
  saveMintAddress("xtomb", xtombKp.publicKey);
  saveMintAddress("xshare", xshareKp.publicKey);
  saveMintAddress("xbond", xbondKp.publicKey);
  console.log("  mint keypairs saved to target/deploy/*-mint.json (0600)");
  const vault = (name: string) =>
    pda([Buffer.from("vault"), Buffer.from(name)])[0];
  const tx = await program.methods
    .createMints()
    // NB (Anchor 0.30): config PDA + token/system programs + rent sysvar
    // are auto-derived from the IDL and must NOT be passed. `admin` is
    // also auto-resolved — the IDL lists it with relations: ["config"],
    // so the client reads it from the config account's admin field.
    .accounts({
      xtombMint: xtombKp.publicKey,
      xshareMint: xshareKp.publicKey,
      xbondMint: xbondKp.publicKey,
      rewardsVault: vault("rewards"),
      farmVault: vault("farm"),
      treasuryVaultXtomb: vault("treasury-xtomb"),
      treasuryVaultXshare: vault("treasury-xshare"),
      vestingVault: vault("vesting"),
      masonryVault: vault("masonry"),
    })
    .transaction();
  const sig = await sendAndConfirmHttp(provider.connection, payer, tx, [
    xtombKp,
    xshareKp,
    xbondKp,
  ]);
  console.log(`create_mints signature: ${sig}`);
  await printVaults(program, provider.connection);
}

async function printVaults(
  program: anchor.Program<Xtomb>,
  connection: Connection
): Promise<void> {
  const [configPda] = pda([Buffer.from("config")]);
  const cfg: any = await program.account.config.fetch(configPda);
  console.log(`  config mints: xtomb ${cfg.xtombMint.toBase58()}`);
  console.log(`                xshare ${cfg.xshareMint.toBase58()}`);
  console.log(`                xbond ${cfg.xbondMint.toBase58()}`);
  console.log(`  circulating xTOMB: ${cfg.circulatingXtomb}`);
  for (const name of ["rewards", "farm", "treasury-xtomb", "treasury-xshare", "vesting", "masonry"]) {
    const vault = pda([Buffer.from("vault"), Buffer.from(name)])[0];
    const bal = await connection.getTokenAccountBalance(vault);
    console.log(`  vault ${name} (${vault.toBase58()}): ${bal.value.amount}`);
  }
}

async function doWallets(
  program: anchor.Program<Xtomb>,
  provider: anchor.AnchorProvider,
  dryRun: boolean
): Promise<void> {
  const payer = payerKeypair(provider);
  const [configPda] = pda([Buffer.from("config")]);
  const twapTs = await chainNow(provider.connection);
  console.log("set_wallets + set_oracle plan:");
  console.log(`  wallets (treasury/team/dev/bot): ${payer.publicKey.toBase58()}`);
  console.log(`  oracle: twap ${INITIAL_TWAP_E6} ($1.00), ts ${twapTs}, authority unchanged (${payer.publicKey.toBase58()})`);
  if (dryRun) {
    console.log("dry-run: not sending.");
    return;
  }
  const tx1 = await program.methods
    .setWallets(
      payer.publicKey,
      payer.publicKey,
      payer.publicKey,
      payer.publicKey
    )
    .accounts({ admin: payer.publicKey })
    .transaction();
  const sig1 = await sendAndConfirmHttp(provider.connection, payer, tx1);
  console.log(`set_wallets signature: ${sig1}`);
  const tx2 = await program.methods
    .setOracle(
      new anchor.BN(INITIAL_TWAP_E6),
      new anchor.BN(twapTs),
      PublicKey.default
    )
    .accounts({ caller: payer.publicKey })
    .transaction();
  const sig2 = await sendAndConfirmHttp(provider.connection, payer, tx2);
  console.log(`set_oracle signature: ${sig2}`);
  const cfg: any = await program.account.config.fetch(configPda);
  console.log(`  oracle_twap_e6: ${cfg.oracleTwapE6}, oracle_ts: ${cfg.oracleTs}`);
  console.log(`  oracle_authority: ${cfg.oracleAuthority.toBase58()}`);
}

async function doVerify(
  program: anchor.Program<Xtomb>,
  provider: anchor.AnchorProvider
): Promise<void> {
  const [configPda] = pda([Buffer.from("config")]);
  const cfg: any = await program.account.config.fetch(configPda);
  console.log("config:");
  console.log(`  address: ${configPda.toBase58()}`);
  console.log(`  admin: ${cfg.admin.toBase58()}`);
  console.log(`  treasury/team/dev/bot: ${cfg.treasuryWallet.toBase58()} / ${cfg.teamWallet.toBase58()} / ${cfg.devWallet.toBase58()} / ${cfg.botWallet.toBase58()}`);
  console.log(`  oracle_authority: ${cfg.oracleAuthority.toBase58()}`);
  console.log(`  usdc_mint: ${cfg.usdcMint.toBase58()}`);
  console.log(`  genesis: ${cfg.genesisStartTs} -> ${cfg.genesisEndTs}, budget ${cfg.genesisRewardBudget}, distributed ${cfg.genesisRewardsDistributed}`);
  console.log(`  oracle: twap ${cfg.oracleTwapE6} @ ${cfg.oracleTs}`);
  console.log(`  epoch0_open: ${cfg.epoch0Open}, maintenance: ${cfg.maintenance}, critical_defense: ${cfg.criticalDefense}`);
  console.log(`  circulating_xtomb: ${cfg.circulatingXtomb}, expansion_allowance: ${cfg.expansionAllowance}, bond_outstanding: ${cfg.bondOutstanding}`);
  await printVaults(program, provider.connection);
}

async function main(): Promise<void> {
  const step = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!["mock-usdc", "init", "mints", "wallets", "verify"].includes(step ?? "")) {
    console.error("usage: npx ts-node scripts/deploy.ts <mock-usdc|init|mints|wallets|verify> [--dry-run]");
    process.exit(2);
  }
  const connection = new Connection(RPC_URL, "confirmed");
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")) as number[])
  );
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new anchor.Program<Xtomb>(IDL, provider);
  console.log(
    `xTOMB deploy: program ${PROGRAM_ID.toBase58()}, rpc ${RPC_URL}, ` +
      `wallet ${keypair.publicKey.toBase58()}, step=${step}, dryRun=${dryRun}`
  );
  const bal = await connection.getBalance(keypair.publicKey);
  console.log(`wallet balance: ${bal / 1e9} SOL`);
  if (step === "mock-usdc") await doMockUsdc(provider, dryRun);
  else if (step === "init") await doInit(program, provider, dryRun);
  else if (step === "mints") await doMints(program, provider, dryRun);
  else if (step === "wallets") await doWallets(program, provider, dryRun);
  else await doVerify(program, provider);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
