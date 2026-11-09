/**
 * Read-only full-state snapshot of the deployed xTOMB program.
 *
 * Usage: npx ts-node scripts/snapshot.ts <output.json>
 *
 * Dumps: the decoded Config account (via the IDL in target/idl/), the
 * Config account's raw bytes + lamports + data length, all mint
 * supplies, all six vault balances, the ProgramData account (length,
 * lamports, last deploy slot, sha256 of the code section after the
 * 45-byte header) and the deployer wallet balance. Used to prove
 * state-identical upgrades: snapshot before, snapshot after, diff.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY");
const PROGRAM_DATA = new PublicKey("Df5GHtybNCQZasiU2Bq75SrVtRrsjSocTrjBZC7grXE3");
const WALLET = new PublicKey("G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs");

function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

function deepConvert(value: any): any {
  if (value && anchor.BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(deepConvert);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepConvert(v);
    return out;
  }
  return value;
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) throw new Error("usage: snapshot.ts <output.json>");
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(Keypair.generate());
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = JSON.parse(fs.readFileSync("target/idl/xtomb.json", "utf8"));
  const program = new anchor.Program(idl, provider);

  const configPda = pda([Buffer.from("config")]);
  const cfg: any = await (program.account as any).config.fetch(configPda);
  const configInfo = await connection.getAccountInfo(configPda);
  if (!configInfo) throw new Error("config account not found");

  const vaults: Record<string, { address: string; amount: string }> = {};
  for (const name of [
    "rewards",
    "farm",
    "treasury-xtomb",
    "treasury-xshare",
    "vesting",
    "masonry",
  ]) {
    const vault = pda([Buffer.from("vault"), Buffer.from(name)]);
    const bal = await connection.getTokenAccountBalance(vault);
    vaults[name] = { address: vault.toBase58(), amount: bal.value.amount };
  }

  const mints: Record<string, string> = {};
  for (const [name, mint] of Object.entries({
    xtomb: cfg.xtombMint,
    xshare: cfg.xshareMint,
    xbond: cfg.xbondMint,
    usdc: cfg.usdcMint,
  })) {
    const supply = await connection.getTokenSupply(mint as PublicKey);
    mints[name] = supply.value.amount;
  }

  const pdInfo = await connection.getAccountInfo(PROGRAM_DATA);
  if (!pdInfo) throw new Error("programdata account not found");
  const codeSection = pdInfo.data.subarray(45);
  let codeNonZeroLen = codeSection.length;
  while (codeNonZeroLen > 0 && codeSection[codeNonZeroLen - 1] === 0) codeNonZeroLen--;
  const snapshot = {
    takenAt: new Date().toISOString(),
    slot: await connection.getSlot("confirmed"),
    program: PROGRAM_ID.toBase58(),
    configPda: configPda.toBase58(),
    configAccount: {
      lamports: configInfo.lamports,
      dataLen: configInfo.data.length,
      dataHex: Buffer.from(configInfo.data).toString("hex"),
    },
    config: deepConvert(cfg),
    vaults,
    mintSupplies: mints,
    programData: {
      address: PROGRAM_DATA.toBase58(),
      lamports: pdInfo.lamports,
      dataLen: pdInfo.data.length,
      lastDeploySlot: Number(pdInfo.data.readBigUInt64LE(4)),
      codeSha256: crypto
        .createHash("sha256")
        .update(codeSection.subarray(0, codeNonZeroLen))
        .digest("hex"),
      codeNonZeroLen,
    },
    wallet: {
      address: WALLET.toBase58(),
      lamports: await connection.getBalance(WALLET),
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`snapshot written to ${outPath}`);
  console.log(
    `config dataLen ${snapshot.configAccount.dataLen}, genesis ${cfg.genesisStartTs} -> ${cfg.genesisEndTs}, budget ${cfg.genesisRewardBudget}, distributed ${cfg.genesisRewardsDistributed}`
  );
  console.log(
    `programdata len ${pdInfo.data.length}, last deploy slot ${snapshot.programData.lastDeploySlot}, code sha ${snapshot.programData.codeSha256.slice(0, 12)}…`
  );
  console.log(`wallet lamports ${snapshot.wallet.lamports}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
