/**
 * Extend the xTOMB ProgramData account by N bytes (default 10240,
 * the loader minimum) so a larger .so fits.
 *
 * Usage: npx ts-node scripts/extend-programdata.ts [additionalBytes]
 *
 * The loader's ExtendProgram instruction is permissionless but
 * requires the ProgramData account to already hold enough lamports
 * to be rent-exempt at the new size, so this script first tops the
 * account up with a plain transfer, then sends ExtendProgram
 * (BPFLoaderUpgradeableInstruction discriminant 6). Transactions
 * are confirmed by HTTP polling (devnet websocket is broken from
 * this sandbox — see DEPLOY-REPORT.md infrastructure notes).
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY");
const LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;

async function confirmHttp(
  connection: Connection,
  signature: string,
  timeoutMs = 180_000
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const st = await connection.getSignatureStatuses([signature]);
    const s = st.value[0];
    if (s?.err) throw new Error(`tx ${signature} failed: ${JSON.stringify(s.err)}`);
    if (
      s &&
      (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")
    ) {
      console.log(`  confirmed (${s.confirmationStatus}, slot ${s.slot})`);
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`tx ${signature} not confirmed within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function sendAndConfirm(
  connection: Connection,
  payer: Keypair,
  tx: Transaction
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  console.log(`  sent ${signature}`);
  await confirmHttp(connection, signature);
  return signature;
}

async function main() {
  const additional = Number(process.argv[2] ?? 10240);
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")) as number[])
  );
  const programData = PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBuffer()],
    LOADER_UPGRADEABLE
  )[0];
  console.log(`payer ${payer.publicKey.toBase58()}, programdata ${programData.toBase58()}`);

  const before = await connection.getAccountInfo(programData);
  if (!before) throw new Error("programdata account not found");
  const targetLen = before.data.length + additional;
  const minRent = await connection.getMinimumBalanceForRentExemption(targetLen);
  console.log(
    `programdata: ${before.data.length} bytes, ${before.lamports} lamports; target ${targetLen} bytes, rent-exempt min ${minRent}`
  );
  const topUp = minRent - before.lamports;
  if (topUp > 0) {
    console.log(`pre-funding ${topUp} lamports…`);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: programData,
        lamports: topUp,
      })
    );
    await sendAndConfirm(connection, payer, tx);
  } else {
    console.log("already funded for the target size; no pre-fund needed");
  }

  const data = Buffer.alloc(8);
  data.writeUInt32LE(6, 0); // ExtendProgram
  data.writeUInt32LE(additional, 4);
  const ix = new TransactionInstruction({
    programId: LOADER_UPGRADEABLE,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  console.log(`extending by ${additional} bytes…`);
  await sendAndConfirm(connection, payer, new Transaction().add(ix));

  const after = await connection.getAccountInfo(programData);
  console.log(
    `programdata now ${after!.data.length} bytes, ${after!.lamports} lamports`
  );
  if (after!.data.length !== targetLen) {
    throw new Error(`length mismatch: expected ${targetLen}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
