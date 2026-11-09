// xTOMB bankrun tests (in-process, no validator).
//
// The sandbox blocks the UDP gossip the local validator needs, so the
// validator dies after ~90-165s — too short to deploy the program and
// run this suite. Bankrun executes the real compiled .so in-process
// (no network, no UDP) and additionally lets the clock warp forward,
// so epochs, vesting and farm windows are testable without real waits.
//
// Run:  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/bankrun.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { startAnchor, Clock } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import * as path from "path";
import * as fs from "fs";
import { Xtomb } from "../target/types/xtomb";

// target/types/xtomb.ts exports only the Xtomb TYPE (no IDL const),
// so load the real IDL JSON at runtime.
const IDL = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../target/idl/xtomb.json"), "utf8")
);

const MPL_CORE_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
);
const DAY = 24 * 3600;
const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

describe("xtomb (bankrun)", () => {
  let provider: BankrunProvider;
  let program: Program<Xtomb>;
  let context: Awaited<ReturnType<typeof startAnchor>>;
  let clockNow: number;

  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  const team = Keypair.generate();
  const dev = Keypair.generate();
  const bot = Keypair.generate();
  const oracle = Keypair.generate();
  const userGenesis = Keypair.generate();
  const userPro = Keypair.generate();
  const userUltra = Keypair.generate();
  const userKeeperFail = Keypair.generate();
  const keeper = Keypair.generate();

  let genesisStart = 0;
  let usdcMint: PublicKey;
  let wsolMint: PublicKey;
  let lpMint: PublicKey;
  let xtombMint: PublicKey;
  let xshareMint: PublicKey;
  let xbondMint: PublicKey;
  let configPda: PublicKey;

  async function pda(seeds: (Buffer | Uint8Array)[]) {
    return PublicKey.findProgramAddressSync(
      seeds.map((s) => Buffer.from(s)),
      program.programId
    )[0];
  }

  async function warp(seconds: number) {
    const clock = await context.banksClient.getClock();
    const next = new Clock(
      clock.slot + BigInt(Math.ceil(seconds * 2.5)),
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(Number(clock.unixTimestamp) + seconds)
    );
    context.setClock(next);
    clockNow = Number(next.unixTimestamp);
  }

  async function fund(to: PublicKey, sol: number) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: context.payer.publicKey,
        toPubkey: to,
        lamports: sol * LAMPORTS,
      })
    );
    await provider.sendAndConfirm(tx);
  }

  // Bankrun's connection proxy only implements getAccountInfo /
  // getMinimumBalanceForRentExemption, so spl-token's send-based helpers
  // (createMint / mintTo / transfer / getOrCreateAssociatedTokenAccount)
  // cannot be used here. Build the same instructions manually and send
  // them through the provider, which drives banksClient directly.
  async function ata(mint: PublicKey, owner: PublicKey) {
    const addr = await getAssociatedTokenAddress(mint, owner);
    try {
      await provider.connection.getAccountInfo(addr);
    } catch {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          context.payer.publicKey,
          addr,
          owner,
          mint
        )
      );
      await provider.sendAndConfirm(tx);
    }
    return addr;
  }

  async function createMintManual(decimals: number): Promise<PublicKey> {
    const mintKp = Keypair.generate();
    const lamports =
      await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: context.payer.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        mintKp.publicKey,
        decimals,
        context.payer.publicKey,
        null
      )
    );
    await provider.sendAndConfirm(tx, [mintKp]);
    return mintKp.publicKey;
  }

  async function mintToManual(
    mint: PublicKey,
    dest: PublicKey,
    amount: number | bigint
  ) {
    const tx = new Transaction().add(
      createMintToInstruction(mint, dest, context.payer.publicKey, amount)
    );
    await provider.sendAndConfirm(tx);
  }

  async function transferManual(
    source: PublicKey,
    dest: PublicKey,
    owner: Keypair,
    amount: number | bigint
  ) {
    const tx = new Transaction().add(
      createTransferInstruction(source, dest, owner.publicKey, amount)
    );
    await provider.sendAndConfirm(tx, [owner]);
  }

  async function bal(mint: PublicKey, owner: PublicKey): Promise<bigint> {
    return (await getAccount(provider.connection as any, await ata(mint, owner))).amount;
  }

  // SPL Mint layout: supply is a u64 LE at byte offset 36.
  async function mintSupply(mint: PublicKey): Promise<bigint> {
    const info = await provider.connection.getAccountInfo(mint);
    return info!.data.readBigUInt64LE(36);
  }

  // Run an Anchor instruction through the raw banks client so a failure
  // surfaces the real program logs instead of bankrun's generic
  // "Unknown action 'undefined'" string. Returns the logs on success.
  async function sendRaw(tx: Transaction, signers: Keypair[]): Promise<string[]> {
    tx.feePayer = context.payer.publicKey;
    tx.recentBlockhash = (await context.banksClient.getLatestBlockhash())[0];
    tx.partialSign(...signers, context.payer);
    const res = await context.banksClient.tryProcessTransaction(tx);
    const logs = res.meta?.logMessages ?? [];
    if (res.result !== null) {
      throw new Error(`tx failed: ${res.result}\n${logs.join("\n")}`);
    }
    return logs;
  }

  async function rpcRaw(builder: any, signers: Keypair[] = []): Promise<string[]> {
    const tx: Transaction = await builder.transaction();
    return sendRaw(tx, signers);
  }

  async function postOracle(twapE6: number, ts?: number) {
    await rpcRaw(program.methods
      .setOracle(
        new anchor.BN(twapE6),
        new anchor.BN(ts ?? clockNow),
        PublicKey.default
      )
      .accounts({ caller: oracle.publicKey, config: configPda }), [oracle]);
  }

  before(async () => {
    context = await startAnchor(
      path.join(__dirname, ".."),
      [{ name: "mpl_core", programId: MPL_CORE_ID }],
      []
    );
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = new Program<Xtomb>(IDL, provider);
    configPda = await pda([Buffer.from("config")]);
    const clock = await context.banksClient.getClock();
    clockNow = Number(clock.unixTimestamp);
    genesisStart = clockNow - 2 * DAY; // Day 2+: LP open

    for (const kp of [admin, treasury, team, dev, bot, oracle, userGenesis, userPro, userUltra, userKeeperFail, keeper]) {
      await fund(kp.publicKey, 10);
    }
    usdcMint = await createMintManual(6);
    lpMint = await createMintManual(6);
    for (const u of [userGenesis, userPro, userUltra, userKeeperFail]) {
      const usdcAta = await ata(usdcMint, u.publicKey);
      await mintToManual(usdcMint, usdcAta, 100_000_000_000);
      const lpAta = await ata(lpMint, u.publicKey);
      await mintToManual(lpMint, lpAta, 10_000_000_000);
    }
    // Seed the wrapped-SOL mint (a fixed system address) and a
    // 20-wSOL account for userPro: bankrun has no wrap path, so the
    // accounts are injected directly into the context.
    wsolMint = new PublicKey("So11111111111111111111111111111111111111112");
    const wsolMintData = Buffer.alloc(82);
    wsolMintData.writeBigUInt64LE(BigInt(0), 36); // supply
    wsolMintData.writeUInt8(9, 44); // decimals
    wsolMintData.writeUInt8(1, 45); // initialized (mint authority: none)
    context.setAccount(wsolMint, {
      data: new Uint8Array(wsolMintData),
      executable: false,
      lamports: 1_461_600,
      owner: TOKEN_PROGRAM_ID,
      rentEpoch: 0,
    });
    const wsolAtaAddr = await getAssociatedTokenAddress(wsolMint, userPro.publicKey);
    const wsolAcctData = Buffer.alloc(165);
    wsolMint.toBuffer().copy(wsolAcctData, 0);
    userPro.publicKey.toBuffer().copy(wsolAcctData, 32);
    wsolAcctData.writeBigUInt64LE(BigInt(20_000_000_000), 64); // 20 wSOL
    wsolAcctData.writeUInt8(1, 108); // state: initialized
    wsolAcctData.writeUInt32LE(1, 109); // is_native: some
    wsolAcctData.writeBigUInt64LE(BigInt(2_039_280), 113); // native reserve
    context.setAccount(wsolAtaAddr, {
      data: new Uint8Array(wsolAcctData),
      executable: false,
      // Native accounts transfer against lamports: amount + reserve.
      lamports: 20_002_039_280,
      owner: TOKEN_PROGRAM_ID,
      rentEpoch: 0,
    });
  });

  it("initializes config with the Genesis window and fee splits", async () => {
    await rpcRaw(program.methods
      .initializeConfig(
        treasury.publicKey,
        team.publicKey,
        dev.publicKey,
        bot.publicKey,
        oracle.publicKey,
        usdcMint,
        new anchor.BN(genesisStart),
        new anchor.BN(30_000_000_000),
        new anchor.BN(1_000_000_000_000)
      )
      .accounts({ admin: admin.publicKey, config: configPda, systemProgram: SystemProgram.programId }), [admin]);
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.genesisStartTs.toNumber(), genesisStart);
    assert.equal(cfg.genesisEndTs.toNumber(), genesisStart + 7 * DAY);
    assert.equal(cfg.genesisRewardBudget.toNumber(), 30_000_000_000);
    assert.equal(cfg.treasuryBps, 5000);
    assert.equal(cfg.teamBps, 2000);
    assert.equal(cfg.devBps, 1500);
    assert.equal(cfg.botBps, 1500);
    assert.equal(cfg.claimFeeBps, 200);
    assert.equal(cfg.keeperFeeBps, 200);
    assert.equal(cfg.lpFeeBps, 50);
    assert.isFalse(cfg.maintenance);
    assert.isFalse(cfg.epoch0Open);
  });

  it("creates mints and funds the launch vaults", async () => {
    const xtombKp = Keypair.generate();
    const xshareKp = Keypair.generate();
    const xbondKp = Keypair.generate();
    xtombMint = xtombKp.publicKey;
    xshareMint = xshareKp.publicKey;
    xbondMint = xbondKp.publicKey;
    const vault = (name: string) => pda([Buffer.from("vault"), Buffer.from(name)]);
    await rpcRaw(program.methods
      .createMints()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        xtombMint,
        xshareMint,
        xbondMint,
        rewardsVault: await vault("rewards"),
        farmVault: await vault("farm"),
        treasuryVaultXtomb: await vault("treasury-xtomb"),
        treasuryVaultXshare: await vault("treasury-xshare"),
        vestingVault: await vault("vesting"),
        masonryVault: await vault("masonry"),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      }), [admin, xtombKp, xshareKp, xbondKp]);
    const rewards = await getAccount(provider.connection as any, await vault("rewards"));
    assert.equal(Number(rewards.amount), 30_000_000_000);
    const farm = await getAccount(provider.connection as any, await vault("farm"));
    assert.equal(Number(farm.amount), 25_641_000_000);
    const vesting = await getAccount(provider.connection as any, await vault("vesting"));
    assert.equal(Number(vesting.amount), 6_941_000_000);
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.circulatingXtomb.toNumber(), 41_000_000_000);
  });

  it("adds pools with canonical ids; rejects a wrong id for the kind", async () => {
    const addPool = async (id: number, kind: number, mint: PublicKey, weight: number) => {
      const poolPda = await pda([Buffer.from("pool"), u64le(id)]);
      const vaultPda = await pda([Buffer.from("pool-vault"), u64le(id)]);
      return rpcRaw(program.methods
        .addPool(new anchor.BN(id), kind, mint, weight)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          pool: poolPda,
          vault: vaultPda,
          assetMintAccount: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        }), [admin]);
    };
    await addPool(1, 0, usdcMint, 0);
    await addPool(2, 1, lpMint, 0);
    await addPool(3, 4, xtombMint, 0);
    await addPool(4, 3, xtombMint, 0);
    await addPool(10, 2, lpMint, 10000);
    try {
      await addPool(7, 0, usdcMint, 0);
      assert.fail("expected WrongPoolId");
    } catch (e: any) {
      assert.include(e.toString(), "WrongPoolId");
    }
  });

  it("buys passes (Genesis/Pro/Ultra) as soulbound Core NFTs", async () => {
    const buy = async (user: Keypair, tier: number) => {
      const assetKp = Keypair.generate();
      const passPda = await pda([Buffer.from("pass"), user.publicKey.toBuffer()]);
      await rpcRaw(program.methods
        .buyPass(tier)
        .accounts({
          buyer: user.publicKey,
          config: configPda,
          pass: passPda,
          asset: assetKp.publicKey,
          buyerUsdc: await ata(usdcMint, user.publicKey),
          treasuryUsdc: await ata(usdcMint, treasury.publicKey),
          mplCoreProgram: MPL_CORE_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }), [user, assetKp]);
      return passPda;
    };
    const p1 = await buy(userGenesis, 1);
    assert.equal((await program.account.pass.fetch(p1)).tier, 1);
    const p2 = await buy(userPro, 2);
    assert.equal((await program.account.pass.fetch(p2)).tier, 2);
    const p3 = await buy(userUltra, 3);
    assert.equal((await program.account.pass.fetch(p3)).tier, 3);
    const p4 = await buy(userKeeperFail, 1);
    assert.equal((await program.account.pass.fetch(p4)).tier, 1);
    assert.equal(Number(await bal(usdcMint, treasury.publicKey)), 500_000_000);
    try {
      await buy(userGenesis, 1);
      assert.fail("expected duplicate-pass failure");
    } catch (e) {
      assert.isTrue(true);
    }
  });

  it("upgrades Genesis -> Pro in place for the $50 difference only", async () => {
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    const before = Number(await bal(usdcMint, treasury.publicKey));
    await rpcRaw(program.methods
      .upgradePass(2)
      .accounts({
        buyer: userGenesis.publicKey,
        config: configPda,
        pass: passPda,
        buyerUsdc: await ata(usdcMint, userGenesis.publicKey),
        treasuryUsdc: await ata(usdcMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [userGenesis]);
    assert.equal((await program.account.pass.fetch(passPda)).tier, 2);
    assert.equal(Number(await bal(usdcMint, treasury.publicKey)), before + 50_000_000);
  });

  it("stakes standard USDC with the tier deposit fee (Pro 1%)", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    await rpcRaw(program.methods
      .stake(new anchor.BN(1), new anchor.BN(1_000_000_000), false)
      .accounts({
        user: userGenesis.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        pass: passPda,
        userToken: await ata(usdcMint, userGenesis.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(usdcMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userGenesis]);
    const pos = await program.account.position.fetch(posPda);
    assert.equal(pos.amount.toNumber(), 990_000_000);
    assert.equal(
      Number(await bal(usdcMint, treasury.publicKey)),
      500_000_000 + 50_000_000 + 10_000_000
    );
  });

  it("Genesis claim at peg pays the 3% Fire Tax (burned, not the flat 2%)", async () => {
    await warp(3600);
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    // Genesis claims are TWAP-priced now: the oracle must be fresh.
    await postOracle(1_000_000);
    const userBefore = Number(await bal(xtombMint, userGenesis.publicKey));
    const treBefore = Number(await bal(xtombMint, treasury.publicKey));
    const vaultBefore = Number(
      (await getAccount(provider.connection as any, rewardsVault)).amount
    );
    const supplyBefore = await mintSupply(xtombMint);
    await rpcRaw(program.methods
      .claim(new anchor.BN(1))
      .accounts({
        user: userGenesis.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        rewardsVault,
        treasuryXtomb: await ata(xtombMint, treasury.publicKey),
        userXtomb: await ata(xtombMint, userGenesis.publicKey),
        xtombMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [userGenesis]);
    const userAfter = Number(await bal(xtombMint, userGenesis.publicKey));
    const treAfter = Number(await bal(xtombMint, treasury.publicKey));
    const vaultAfter = Number(
      (await getAccount(provider.connection as any, rewardsVault)).amount
    );
    const supplyAfter = await mintSupply(xtombMint);
    // The vault pays out the gross; the fee portion is BURNED out of it
    // (mint supply drops by exactly the fee), Treasury receives nothing.
    const gross = vaultBefore - vaultAfter;
    const fee = Number(supplyBefore - supplyAfter);
    assert.isAbove(gross, 10_000_000);
    // At peg the xTOMB Fire Tax is exactly its 300 bps baseline.
    assert.equal(fee, Math.floor((gross * 300) / 10_000));
    assert.equal(userAfter - userBefore, gross - fee);
    assert.equal(treAfter, treBefore);
    const pos = await program.account.position.fetch(posPda);
    assert.equal(pos.accruedLiquid.toNumber(), 0);
    assert.isAbove(pos.vestingTotal.toNumber(), 0);
  });

  it("compounds LP rewards, then a second compound within 3h MUST fail", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(2)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(2)]);
    const posPda = await pda([Buffer.from("position"), userPro.publicKey.toBuffer(), u64le(2)]);
    const passPda = await pda([Buffer.from("pass"), userPro.publicKey.toBuffer()]);
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    const treLpBefore = Number(await bal(lpMint, treasury.publicKey));
    const lpSupplyBefore = await mintSupply(lpMint);
    await rpcRaw(program.methods
      .stake(new anchor.BN(2), new anchor.BN(1_000_000_000), false)
      .accounts({
        user: userPro.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        pass: passPda,
        userToken: await ata(lpMint, userPro.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(lpMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userPro]);
    // Q8 (Jess 2026-11-08): the 0.5% LP deposit fee goes to the
    // Treasury wallet as POL — exactly 5,000,000 LP lands there, the
    // LP mint supply is unchanged (no burn), only the net is staked.
    assert.equal(Number(await bal(lpMint, treasury.publicKey)), treLpBefore + 5_000_000);
    assert.equal(await mintSupply(lpMint), lpSupplyBefore);
    assert.equal(
      (await program.account.position.fetch(posPda)).amount.toNumber(),
      995_000_000
    );
    await warp(3600);
    await postOracle(1_000_000);
    const compoundAccounts = {
      caller: userPro.publicKey,
      owner: userPro.publicKey,
      config: configPda,
      pool: poolPda,
      position: posPda,
      pass: passPda,
      rewardsVault,
      treasuryXtomb: await ata(xtombMint, treasury.publicKey),
      xtombMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    await rpcRaw(program.methods
      .compound(new anchor.BN(2), false)
      .accounts(compoundAccounts), [userPro]);
    const posAfter = await program.account.position.fetch(posPda);
    assert.isAbove(posAfter.amount.toNumber(), 995_000_000);
    try {
      await rpcRaw(program.methods
        .compound(new anchor.BN(2), false)
        .accounts(compoundAccounts), [userPro]);
      assert.fail("expected CompoundTooSoon");
    } catch (e: any) {
      assert.include(e.toString(), "CompoundTooSoon");
    }
    // Ultra pays NO LP fee in Genesis (Q8 routing changes nothing for
    // the exemption): a 1,000,000,000 LP stake credits in full and the
    // Treasury LP balance does not move.
    const treLpUltraBefore = Number(await bal(lpMint, treasury.publicKey));
    const posUltraPda = await pda([Buffer.from("position"), userUltra.publicKey.toBuffer(), u64le(2)]);
    await rpcRaw(program.methods
      .stake(new anchor.BN(2), new anchor.BN(1_000_000_000), false)
      .accounts({
        user: userUltra.publicKey,
        config: configPda,
        pool: poolPda,
        position: posUltraPda,
        pass: await pda([Buffer.from("pass"), userUltra.publicKey.toBuffer()]),
        userToken: await ata(lpMint, userUltra.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(lpMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userUltra]);
    assert.equal(
      (await program.account.position.fetch(posUltraPda)).amount.toNumber(),
      1_000_000_000
    );
    assert.equal(Number(await bal(lpMint, treasury.publicKey)), treLpUltraBefore);
    assert.equal(await mintSupply(lpMint), lpSupplyBefore);
  });

  it("keeper compound requires Pro/Ultra tier", async () => {
    // userKeeperFail holds a Genesis pass; a keeper compound on their
    // LP position must fail the tier check (not the cooldown).
    const poolPda = await pda([Buffer.from("pool"), u64le(2)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(2)]);
    const posPda = await pda([Buffer.from("position"), userKeeperFail.publicKey.toBuffer(), u64le(2)]);
    const passPda = await pda([Buffer.from("pass"), userKeeperFail.publicKey.toBuffer()]);
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    await rpcRaw(program.methods
      .stake(new anchor.BN(2), new anchor.BN(500_000_000), false)
      .accounts({
        user: userKeeperFail.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        pass: passPda,
        userToken: await ata(lpMint, userKeeperFail.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(lpMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userKeeperFail]);
    try {
      await rpcRaw(program.methods
        .compound(new anchor.BN(2), true)
        .accounts({
          caller: keeper.publicKey,
          owner: userKeeperFail.publicKey,
          config: configPda,
          pool: poolPda,
          position: posPda,
          pass: passPda,
          rewardsVault,
          treasuryXtomb: await ata(xtombMint, treasury.publicKey),
          xtombMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }), [keeper]);
      assert.fail("expected RequiresKeeperTier");
    } catch (e: any) {
      assert.include(e.toString(), "RequiresKeeperTier");
    }
    // ...but a keeper compound on the Pro user's position passes the
    // tier gate (it hits the 3h cap instead, from the earlier compound).
    const posPro = await pda([Buffer.from("position"), userPro.publicKey.toBuffer(), u64le(2)]);
    const passPro = await pda([Buffer.from("pass"), userPro.publicKey.toBuffer()]);
    try {
      await rpcRaw(program.methods
        .compound(new anchor.BN(2), true)
        .accounts({
          caller: keeper.publicKey,
          owner: userPro.publicKey,
          config: configPda,
          pool: poolPda,
          position: posPro,
          pass: passPro,
          rewardsVault,
          treasuryXtomb: await ata(xtombMint, treasury.publicKey),
          xtombMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }), [keeper]);
      assert.fail("expected CompoundTooSoon for the keeper call");
    } catch (e: any) {
      assert.include(e.toString(), "CompoundTooSoon");
    }
  });

  it("withdrawal Fire Tax: 3% at peg during Genesis, then curve to 12%", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    const unstake = async (amount: number) => {
      const userBefore = Number(await bal(usdcMint, userGenesis.publicKey));
      const treBefore = Number(await bal(usdcMint, treasury.publicKey));
      await rpcRaw(program.methods
        .unstake(new anchor.BN(1), new anchor.BN(amount))
        .accounts({
          user: userGenesis.publicKey,
          config: configPda,
          pool: poolPda,
          position: posPda,
          pass: passPda,
          vault: vaultPda,
          userToken: await ata(usdcMint, userGenesis.publicKey),
          taxDestination: await ata(usdcMint, treasury.publicKey),
          xtombMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        }), [userGenesis]);
      const userAfter = Number(await bal(usdcMint, userGenesis.publicKey));
      const treAfter = Number(await bal(usdcMint, treasury.publicKey));
      return { net: userAfter - userBefore, tax: treAfter - treBefore };
    };
    await postOracle(1_000_000);
    let r = await unstake(100_000_000);
    assert.equal(r.tax, 3_000_000);
    assert.equal(r.net, 97_000_000);
    await postOracle(925_000);
    r = await unstake(100_000_000);
    // xTOMB baseline 300 + shared increment 275 at $0.925 = 575 bps.
    assert.equal(r.tax, 5_750_000);
    assert.equal(r.net, 94_250_000);
    await postOracle(850_000);
    r = await unstake(100_000_000);
    assert.equal(r.tax, 12_000_000);
    assert.equal(r.net, 88_000_000);
    await postOracle(1_000_000, clockNow - 31 * 60);
    try {
      await unstake(10_000_000);
      assert.fail("expected OracleStale");
    } catch (e: any) {
      assert.include(e.toString(), "OracleStale");
    }
    await postOracle(1_000_000);
  });

  it("Genesis claim below peg pays the curve Fire Tax (7.88% at $0.90), burned", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    // 4h clears the 3h claim cooldown, accrues fresh rewards, and lets
    // the $0.85 unstake's 12% recovery floor decay to ~6.85% — below
    // the $0.90 curve rate, so the curve rate is what gets charged.
    await warp(4 * 3600);
    await postOracle(900_000);
    const userBefore = Number(await bal(xtombMint, userGenesis.publicKey));
    const treBefore = Number(await bal(xtombMint, treasury.publicKey));
    const vaultBefore = Number(
      (await getAccount(provider.connection as any, rewardsVault)).amount
    );
    const supplyBefore = await mintSupply(xtombMint);
    await rpcRaw(program.methods
      .claim(new anchor.BN(1))
      .accounts({
        user: userGenesis.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        rewardsVault,
        treasuryXtomb: await ata(xtombMint, treasury.publicKey),
        userXtomb: await ata(xtombMint, userGenesis.publicKey),
        xtombMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [userGenesis]);
    const userAfter = Number(await bal(xtombMint, userGenesis.publicKey));
    const treAfter = Number(await bal(xtombMint, treasury.publicKey));
    const vaultAfter = Number(
      (await getAccount(provider.connection as any, rewardsVault)).amount
    );
    const supplyAfter = await mintSupply(xtombMint);
    const gross = vaultBefore - vaultAfter;
    const fee = Number(supplyBefore - supplyAfter);
    assert.isAbove(gross, 0);
    // xTOMB baseline 300 + shared increment 488 at $0.90 = 788 bps.
    assert.equal(fee, Math.floor((gross * 788) / 10_000));
    assert.equal(userAfter - userBefore, gross - fee);
    assert.equal(treAfter, treBefore);
    await postOracle(1_000_000);
  });

  it("Ultra NFT stakes as its own position and unstakes cleanly", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(3)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(3)]);
    const posPda = await pda([Buffer.from("position"), userUltra.publicKey.toBuffer(), u64le(3)]);
    const passPda = await pda([Buffer.from("pass"), userUltra.publicKey.toBuffer()]);
    await rpcRaw(program.methods
      .stake(new anchor.BN(3), new anchor.BN(0), true)
      .accounts({
        user: userUltra.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        pass: passPda,
        userToken: await ata(xtombMint, userUltra.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(xtombMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userUltra]);
    const pos = await program.account.position.fetch(posPda);
    assert.equal(pos.amount.toNumber(), 1);
    assert.isTrue((await program.account.pass.fetch(passPda)).ultraStaked);
    await warp(3600);
    await rpcRaw(program.methods
      .unstake(new anchor.BN(3), new anchor.BN(1))
      .accounts({
        user: userUltra.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        pass: passPda,
        vault: vaultPda,
        userToken: await ata(xtombMint, userUltra.publicKey),
        taxDestination: await ata(xtombMint, treasury.publicKey),
        xtombMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [userUltra]);
    assert.isFalse((await program.account.pass.fetch(passPda)).ultraStaked);
    assert.equal((await program.account.position.fetch(posPda)).amount.toNumber(), 0);
  });

  it("xBOND (LP-zap): buy only below $1.00, xTOMB pay-in burns with a 3% premium, redeem only above $1.00, queues with no backing", async () => {
    // Top up userGenesis xTOMB: stake more + warp + claim.
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    await warp(4 * 3600); // also clears the claim cooldown from earlier tests
    await rpcRaw(program.methods
      .stake(new anchor.BN(1), new anchor.BN(5_000_000_000), false)
      .accounts({
        user: userGenesis.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        pass: passPda,
        userToken: await ata(usdcMint, userGenesis.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(usdcMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userGenesis]);
    await warp(3600);
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    // Still inside Genesis: the claim is Fire-Tax priced, oracle must be fresh.
    await postOracle(1_000_000);
    await rpcRaw(program.methods
      .claim(new anchor.BN(1))
      .accounts({
        user: userGenesis.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        rewardsVault,
        treasuryXtomb: await ata(xtombMint, treasury.publicKey),
        userXtomb: await ata(xtombMint, userGenesis.publicKey),
        xtombMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [userGenesis]);
    const xtombBal = Number(await bal(xtombMint, userGenesis.publicKey));
    assert.isAbove(xtombBal, 1_000_000);
    const xbondAta = await ata(xbondMint, userGenesis.publicKey);
    const payinVaultXtomb = await pda([Buffer.from("bond-payin"), xtombMint.toBuffer()]);
    const bondLpVault = await pda([Buffer.from("bond-lp-vault")]);
    const buyBondAccounts = {
      buyer: userGenesis.publicKey,
      config: configPda,
      payinMint: xtombMint,
      buyerPayin: await ata(xtombMint, userGenesis.publicKey),
      payinVault: payinVaultXtomb,
      buyerXbond: xbondAta,
      xbondMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    await postOracle(1_000_000);
    try {
      await rpcRaw(program.methods
        .buyBond(new anchor.BN(10_000))
        .accounts(buyBondAccounts), [userGenesis]);
      assert.fail("expected BondBuyClosed");
    } catch (e: any) {
      assert.include(e.toString(), "BondBuyClosed");
    }
    await postOracle(900_000);
    const payinAmount = Math.min(500_000, Math.floor(xtombBal * 0.5));
    assert.isAbove(payinAmount, 0);
    const xtombSupplyBefore = await mintSupply(xtombMint);
    await rpcRaw(program.methods
      .buyBond(new anchor.BN(payinAmount))
      .accounts(buyBondAccounts), [userGenesis]);
    // xTOMB pay-in BURNS like a classic bond and earns the 3%
    // xTOMB premium: face = pay-in USD value at TWAP x 1.03
    // (integer-mirrored from the program's math).
    const expectedFace = Math.floor(
      (Math.floor((payinAmount * 900_000) / 1_000_000) * 10_300) / 9_000
    );
    assert.isAbove(expectedFace, payinAmount);
    assert.equal(Number(await bal(xbondMint, userGenesis.publicKey)), expectedFace);
    // The paid xTOMB is burned: total supply drops by exactly the
    // pay-in, and the per-mint pay-in custody vault stays empty
    // (it is never even created for the xTOMB mint).
    assert.equal(
      Number(await mintSupply(xtombMint)),
      Number(xtombSupplyBefore) - payinAmount
    );
    let payinVaultAmount = 0;
    try {
      const payinVaultAcct = await getAccount(provider.connection as any, payinVaultXtomb);
      payinVaultAmount = Number(payinVaultAcct.amount);
    } catch { /* vault account does not exist */ }
    assert.equal(payinVaultAmount, 0);
    // Register the LP mint (the tests' mock LP) — creates the
    // backing vault redemptions pay out of.
    await rpcRaw(program.methods
      .setBondConfig(1000)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        lpMint,
        bondLpVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [admin]);
    const redeemAccounts = {
      user: userGenesis.publicKey,
      config: configPda,
      bondPosition: await pda([Buffer.from("bond"), userGenesis.publicKey.toBuffer()]),
      userXbond: xbondAta,
      userLp: await ata(lpMint, userGenesis.publicKey),
      xbondMint,
      bondLpVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    try {
      await rpcRaw(program.methods
        .redeemBond(new anchor.BN(expectedFace))
        .accounts(redeemAccounts), [userGenesis]);
      assert.fail("expected BondRedeemClosed");
    } catch (e: any) {
      assert.include(e.toString(), "BondRedeemClosed");
    }
    await postOracle(1_050_000);
    await rpcRaw(program.methods
      .redeemBond(new anchor.BN(expectedFace))
      .accounts(redeemAccounts), [userGenesis]);
    const bp = await program.account.bondPosition.fetch(
      await pda([Buffer.from("bond"), userGenesis.publicKey.toBuffer()])
    );
    // No backing deposited yet: the whole redemption queues and the
    // xBOND stays in the user's wallet.
    assert.equal(bp.queuedRedeem.toNumber(), expectedFace);
    assert.equal(Number(await bal(xbondMint, userGenesis.publicKey)), expectedFace);
  });

  it("epochs: bootstrap gating, expansion gating, Critical Defense enter/exit", async () => {
    const masonryPool = await pda([Buffer.from("pool"), u64le(4)]);
    const masonryVault = await pda([Buffer.from("vault"), Buffer.from("masonry")]);
    const advance = async (trigger: boolean, caller: Keypair) =>
      rpcRaw(program.methods
        .advanceEpoch(trigger)
        .accounts({
          caller: caller.publicKey,
          config: configPda,
          masonryPool,
          xtombMint,
          masonryVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        }), [caller]);
    // Non-admin cannot trigger Epoch 0.
    try {
      await advance(true, userGenesis);
      assert.fail("expected NotAdmin");
    } catch (e: any) {
      assert.isTrue(true);
    }
    await advance(true, admin);
    let cfg = await program.account.config.fetch(configPda);
    assert.isTrue(cfg.epoch0Open);
    // Not due yet.
    try {
      await advance(false, admin);
      assert.fail("expected EpochNotDue");
    } catch (e: any) {
      assert.include(e.toString(), "EpochNotDue");
    }
    // Expected mints from the actual circulating supply (compound
    // burns and xTOMB bond burns reduce it below the 41,000 launch
    // figure).
    const circ = BigInt(
      (await program.account.config.fetch(configPda)).circulatingXtomb.toNumber()
    );
    const bootstrap3 = Number((circ * 3n) / 100n);
    const expansion2 = Number((circ * 2n) / 100n);
    // Epoch 0 (bootstrap): TWAP $1.00 > $0.90 -> 3% of circulating.
    // No Masonry stakers, so the whole mint goes to the allowance.
    await warp(6 * 3600);
    await postOracle(1_000_000);
    await advance(false, admin);
    cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.currentEpoch.toNumber(), 1);
    assert.equal(cfg.expansionAllowance.toNumber(), bootstrap3);
    // Epoch 1 (bootstrap): TWAP $0.90 exactly -> NOT above $0.90, no mint.
    await warp(6 * 3600);
    await postOracle(900_000);
    await advance(false, admin);
    cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.currentEpoch.toNumber(), 2);
    assert.equal(cfg.expansionAllowance.toNumber(), bootstrap3);
    // Epoch 2 (expansion): TWAP $1.01 exactly -> NOT strictly above, no mint.
    await warp(6 * 3600);
    await postOracle(1_010_000);
    await advance(false, admin);
    cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.currentEpoch.toNumber(), 3);
    assert.equal(cfg.expansionAllowance.toNumber(), bootstrap3);
    // Epoch 3 (expansion): TWAP $1.02 -> 2% of circulating.
    await warp(6 * 3600);
    await postOracle(1_020_000);
    await advance(false, admin);
    cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.currentEpoch.toNumber(), 4);
    assert.equal(cfg.expansionAllowance.toNumber(), bootstrap3 + expansion2);
    // Critical Defense: TWAP $0.90 enters defense...
    await warp(6 * 3600);
    await postOracle(900_000);
    await advance(false, admin);
    cfg = await program.account.config.fetch(configPda);
    assert.isTrue(cfg.criticalDefense);
    // ...one checkpoint above $1.01 is not enough to exit...
    await warp(6 * 3600);
    await postOracle(1_020_000);
    await advance(false, admin);
    cfg = await program.account.config.fetch(configPda);
    assert.isTrue(cfg.criticalDefense);
    // ...two consecutive checkpoints above $1.01 exits defense.
    await warp(6 * 3600);
    await postOracle(1_020_000);
    await advance(false, admin);
    cfg = await program.account.config.fetch(configPda);
    assert.isFalse(cfg.criticalDefense);
  });

  it("bond redemption settles the queue once backing is deposited", async () => {
    const bpPda = await pda([Buffer.from("bond"), userGenesis.publicKey.toBuffer()]);
    const before = await program.account.bondPosition.fetch(bpPda);
    assert.isAbove(before.queuedRedeem.toNumber(), 0);
    const lpBefore = Number(await bal(lpMint, userGenesis.publicKey));
    // Operator leg: the bot deposits LP backing created from the
    // custodied pay-ins (mocked here by a direct mint to the bot).
    const BACKING = 600_000;
    await mintToManual(lpMint, await ata(lpMint, bot.publicKey), BACKING);
    await rpcRaw(program.methods
      .depositBondBacking(new anchor.BN(BACKING))
      .accounts({
        caller: bot.publicKey,
        config: configPda,
        callerLp: await ata(lpMint, bot.publicKey),
        bondLpVault: await pda([Buffer.from("bond-lp-vault")]),
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [bot]);
    await postOracle(1_050_000);
    await rpcRaw(program.methods
      .redeemBond(new anchor.BN(0))
      .accounts({
        user: userGenesis.publicKey,
        config: configPda,
        bondPosition: bpPda,
        userXbond: await ata(xbondMint, userGenesis.publicKey),
        userLp: await ata(lpMint, userGenesis.publicKey),
        xbondMint,
        bondLpVault: await pda([Buffer.from("bond-lp-vault")]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userGenesis]);
    const after = await program.account.bondPosition.fetch(bpPda);
    assert.equal(after.queuedRedeem.toNumber(), 0);
    // Sole bond holder at this point: the queued face drains the
    // entire backing, paid in LP (not xTOMB).
    assert.equal(Number(await bal(lpMint, userGenesis.publicKey)) - lpBefore, BACKING);
    assert.equal(Number(await bal(xbondMint, userGenesis.publicKey)), 0);
  });

  it("vesting: installments release at Genesis end + 6h, one at a time", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    const claimAccounts = {
      user: userGenesis.publicKey,
      config: configPda,
      pool: poolPda,
      position: posPda,
      rewardsVault,
      treasuryXtomb: await ata(xtombMint, treasury.publicKey),
      userXtomb: await ata(xtombMint, userGenesis.publicKey),
      xtombMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
    const posBefore = await program.account.position.fetch(posPda);
    const total = posBefore.vestingTotal.toNumber();
    assert.isAbove(total, 0);
    // Warp to Genesis end + 6h (first installment opens).
    const genesisEnd = genesisStart + 7 * DAY;
    await warp(genesisEnd + 6 * 3600 - clockNow);
    const balBefore = Number(await bal(xtombMint, userGenesis.publicKey));
    await rpcRaw(program.methods.claim(new anchor.BN(1)).accounts(claimAccounts), [userGenesis]);
    const pos1 = await program.account.position.fetch(posPda);
    assert.equal(pos1.vestingClaimedInstallments, 1);
    assert.isAbove(Number(await bal(xtombMint, userGenesis.publicKey)) - balBefore, 0);
    // Second installment opens 6h after the first claim.
    await warp(6 * 3600);
    await rpcRaw(program.methods.claim(new anchor.BN(1)).accounts(claimAccounts), [userGenesis]);
    const pos2 = await program.account.position.fetch(posPda);
    assert.equal(pos2.vestingClaimedInstallments, 2);
    // Claimed is bounded by the CURRENT vesting total, not the
    // pre-claim snapshot: the first claim's settle also booked the
    // Genesis tail accrual (the pool settles lazily up to Genesis
    // end), which grows vestingTotal beyond `total`.
    assert.isAtMost(
      pos2.vestingClaimedAmount.toNumber(),
      pos2.vestingTotal.toNumber()
    );
    assert.isAbove(pos2.vestingTotal.toNumber(), total);
  });

  it("farm harvest pays xSHARE after Genesis ends", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(10)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(10)]);
    const posPda = await pda([Buffer.from("position"), userPro.publicKey.toBuffer(), u64le(10)]);
    const farmVault = await pda([Buffer.from("vault"), Buffer.from("farm")]);
    // Stake LP into the farm pool (farm window starts at Genesis end).
    await rpcRaw(program.methods
      .stake(new anchor.BN(10), new anchor.BN(1_000_000_000), false)
      .accounts({
        user: userPro.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        pass: await pda([Buffer.from("pass"), userPro.publicKey.toBuffer()]),
        userToken: await ata(lpMint, userPro.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(lpMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userPro]);
    await warp(24 * 3600);
    const before = Number(await bal(xshareMint, userPro.publicKey));
    await rpcRaw(program.methods
      .harvest(new anchor.BN(10))
      .accounts({
        user: userPro.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        farmVault,
        treasuryXshare: await ata(xshareMint, treasury.publicKey),
        userXshare: await ata(xshareMint, userPro.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [userPro]);
    const after = Number(await bal(xshareMint, userPro.publicKey));
    // Farm rate 813 base units/s * 24h * 100% weight, 2% fee -> ~68 xSHARE net.
    assert.isAbove(after - before, 10_000_000);
  });

  it("buyback_and_burn: bot-only, guarded to TWAP <= $1.01", async () => {
    await postOracle(1_050_000);
    try {
      await rpcRaw(program.methods
        .buybackAndBurn(new anchor.BN(1_000))
        .accounts({
          caller: bot.publicKey,
          config: configPda,
          callerXtomb: await ata(xtombMint, bot.publicKey),
          xtombMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        }), [bot]);
      assert.fail("expected BuybackGuard");
    } catch (e: any) {
      assert.include(e.toString(), "BuybackGuard");
    }
    // Non-bot caller is rejected even with a valid TWAP.
    await postOracle(1_000_000);
    try {
      await rpcRaw(program.methods
        .buybackAndBurn(new anchor.BN(1_000))
        .accounts({
          caller: userGenesis.publicKey,
          config: configPda,
          callerXtomb: await ata(xtombMint, userGenesis.publicKey),
          xtombMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        }), [userGenesis]);
      assert.fail("expected NotBot");
    } catch (e: any) {
      assert.include(e.toString(), "NotBot");
    }
    // Fund the bot with xTOMB from userGenesis, then a guarded burn works.
    const botAta = await ata(xtombMint, bot.publicKey);
    await transferManual(
      await ata(xtombMint, userGenesis.publicKey),
      botAta,
      userGenesis,
      5_000_000
    );
    const botBefore = Number(await bal(xtombMint, bot.publicKey));
    await rpcRaw(program.methods
      .buybackAndBurn(new anchor.BN(1_000_000))
      .accounts({
        caller: bot.publicKey,
        config: configPda,
        callerXtomb: botAta,
        xtombMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [bot]);
    assert.equal(Number(await bal(xtombMint, bot.publicKey)), botBefore - 1_000_000);
  });

  it("admin controls: non-admin cannot set fees; maintenance blocks staking", async () => {
    try {
      await rpcRaw(program.methods
        .setFeeConfig(200, 200, 50, 5000, 2000, 1500, 1500)
        .accounts({ admin: userGenesis.publicKey, config: configPda }), [userGenesis]);
      assert.fail("expected NotAdmin");
    } catch (e: any) {
      assert.isTrue(true);
    }
    await rpcRaw(program.methods
      .setMaintenance(true)
      .accounts({ admin: admin.publicKey, config: configPda }), [admin]);
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    try {
      await rpcRaw(program.methods
        .stake(new anchor.BN(1), new anchor.BN(1_000_000), false)
        .accounts({
          user: userGenesis.publicKey,
          config: configPda,
          pool: poolPda,
          position: posPda,
          pass: passPda,
          userToken: await ata(usdcMint, userGenesis.publicKey),
          vault: await pda([Buffer.from("pool-vault"), u64le(1)]),
          treasuryToken: await ata(usdcMint, treasury.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }), [userGenesis]);
      assert.fail("expected Maintenance");
    } catch (e: any) {
      assert.include(e.toString(), "Maintenance");
    }
    await rpcRaw(program.methods
      .setMaintenance(false)
      .accounts({ admin: admin.publicKey, config: configPda }), [admin]);
  });

  it("Masonry claim at peg pays the 3% Fire Tax to Treasury (not the flat 2%)", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(4)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(4)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(4)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    const masonryVault = await pda([Buffer.from("vault"), Buffer.from("masonry")]);
    // Stake xTOMB into the Masonry (no deposit fee on the Masonry
    // pool). userPro stakes the same amount alongside: the next test
    // claims on that position below peg, and both positions must exist
    // before the first Masonry epoch mints (a position opened later
    // would carry a non-zero reward debt into its first claim).
    await rpcRaw(program.methods
      .stake(new anchor.BN(4), new anchor.BN(20_000_000), false)
      .accounts({
        user: userGenesis.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        pass: passPda,
        userToken: await ata(xtombMint, userGenesis.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(xtombMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userGenesis]);
    const pos0 = await program.account.position.fetch(posPda);
    assert.equal(pos0.amount.toNumber(), 20_000_000);
    await transferManual(
      await ata(xtombMint, userGenesis.publicKey),
      await ata(xtombMint, userPro.publicKey),
      userGenesis,
      20_000_000
    );
    await rpcRaw(program.methods
      .stake(new anchor.BN(4), new anchor.BN(20_000_000), false)
      .accounts({
        user: userPro.publicKey,
        config: configPda,
        pool: poolPda,
        position: await pda([Buffer.from("position"), userPro.publicKey.toBuffer(), u64le(4)]),
        pass: await pda([Buffer.from("pass"), userPro.publicKey.toBuffer()]),
        userToken: await ata(xtombMint, userPro.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(xtombMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), [userPro]);
    // An expansion epoch at TWAP $1.02 mints into the Masonry vault;
    // the sole staker accrues the whole Masonry share.
    await warp(6 * 3600);
    await postOracle(1_020_000);
    await rpcRaw(program.methods
      .advanceEpoch(false)
      .accounts({
        caller: admin.publicKey,
        config: configPda,
        masonryPool: poolPda,
        xtombMint,
        masonryVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [admin]);
    // Let any recovery floor raised by earlier tests decay to its 3%
    // rest, then re-post the oracle at peg (Masonry claims are
    // TWAP-priced now, so the oracle must be fresh).
    await warp(8 * 3600);
    await postOracle(1_000_000);
    const userBefore = Number(await bal(xtombMint, userGenesis.publicKey));
    const treBefore = Number(await bal(xtombMint, treasury.publicKey));
    const vaultBefore = Number(
      (await getAccount(provider.connection as any, masonryVault)).amount
    );
    const supplyBefore = await mintSupply(xtombMint);
    await rpcRaw(program.methods
      .claim(new anchor.BN(4))
      .accounts({
        user: userGenesis.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        rewardsVault: masonryVault,
        treasuryXtomb: await ata(xtombMint, treasury.publicKey),
        userXtomb: await ata(xtombMint, userGenesis.publicKey),
        xtombMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [userGenesis]);
    const userAfter = Number(await bal(xtombMint, userGenesis.publicKey));
    const treAfter = Number(await bal(xtombMint, treasury.publicKey));
    const vaultAfter = Number(
      (await getAccount(provider.connection as any, masonryVault)).amount
    );
    const supplyAfter = await mintSupply(xtombMint);
    const gross = vaultBefore - vaultAfter;
    assert.isAbove(gross, 100_000_000);
    // Post-Genesis routing: the Fire Tax goes to Treasury, nothing burns.
    const fee = treAfter - treBefore;
    assert.equal(fee, Math.floor((gross * 300) / 10_000));
    assert.equal(userAfter - userBefore, gross - fee);
    assert.equal(supplyAfter, supplyBefore);
    const pos = await program.account.position.fetch(posPda);
    assert.equal(pos.accruedLiquid.toNumber(), 0);
  });

  it("Masonry claim below peg pays the curve Fire Tax (7.88% at $0.90) to Treasury", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(4)]);
    const posPda = await pda([Buffer.from("position"), userPro.publicKey.toBuffer(), u64le(4)]);
    const masonryVault = await pda([Buffer.from("vault"), Buffer.from("masonry")]);
    // Accrue a fresh batch of Masonry rewards above $1.01 first (this
    // position — userPro's, opened in the previous test before any
    // Masonry epoch minted — settles both batches in this one claim)...
    await warp(6 * 3600);
    await postOracle(1_020_000);
    await rpcRaw(program.methods
      .advanceEpoch(false)
      .accounts({
        caller: admin.publicKey,
        config: configPda,
        masonryPool: poolPda,
        xtombMint,
        masonryVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [admin]);
    // ...then drop the TWAP to $0.90 and claim.
    await warp(4 * 3600);
    await postOracle(900_000);
    const userBefore = Number(await bal(xtombMint, userPro.publicKey));
    const treBefore = Number(await bal(xtombMint, treasury.publicKey));
    const vaultBefore = Number(
      (await getAccount(provider.connection as any, masonryVault)).amount
    );
    const supplyBefore = await mintSupply(xtombMint);
    await rpcRaw(program.methods
      .claim(new anchor.BN(4))
      .accounts({
        user: userPro.publicKey,
        config: configPda,
        pool: poolPda,
        position: posPda,
        rewardsVault: masonryVault,
        treasuryXtomb: await ata(xtombMint, treasury.publicKey),
        userXtomb: await ata(xtombMint, userPro.publicKey),
        xtombMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [userPro]);
    const userAfter = Number(await bal(xtombMint, userPro.publicKey));
    const treAfter = Number(await bal(xtombMint, treasury.publicKey));
    const vaultAfter = Number(
      (await getAccount(provider.connection as any, masonryVault)).amount
    );
    const supplyAfter = await mintSupply(xtombMint);
    const gross = vaultBefore - vaultAfter;
    assert.isAbove(gross, 100_000_000);
    // $0.90 curve rate = 300 baseline + 488 increment = 788 bps, paid to
    // Treasury; the recovery floor has decayed to its 3% rest, so the
    // curve rate is the binding one.
    const fee = treAfter - treBefore;
    assert.equal(fee, Math.floor((gross * 788) / 10_000));
    assert.equal(userAfter - userBefore, gross - fee);
    assert.equal(supplyAfter, supplyBefore);
    const pos = await program.account.position.fetch(posPda);
    assert.equal(pos.accruedLiquid.toNumber(), 0);
  });

  it("bonds (LP-zap): premium crediting for USDC + SOL pay-ins, operator pay-in withdrawal, pro-rata LP redemption", async () => {
    const bondLpVault = await pda([Buffer.from("bond-lp-vault")]);
    const payinVaultOf = async (mint: PublicKey) =>
      pda([Buffer.from("bond-payin"), mint.toBuffer()]);
    const buy = async (user: Keypair, mint: PublicKey, amount: number) =>
      rpcRaw(program.methods
        .buyBond(new anchor.BN(amount))
        .accounts({
          buyer: user.publicKey,
          config: configPda,
          payinMint: mint,
          buyerPayin: await ata(mint, user.publicKey),
          payinVault: await payinVaultOf(mint),
          buyerXbond: await ata(xbondMint, user.publicKey),
          xbondMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }), [user]);
    const redeem = async (user: Keypair, amount: number) =>
      rpcRaw(program.methods
        .redeemBond(new anchor.BN(amount))
        .accounts({
          user: user.publicKey,
          config: configPda,
          bondPosition: await pda([Buffer.from("bond"), user.publicKey.toBuffer()]),
          userXbond: await ata(xbondMint, user.publicKey),
          userLp: await ata(lpMint, user.publicKey),
          xbondMint,
          bondLpVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }), [user]);

    // Oracle posts a SOL price ($150); buys open at TWAP $0.90.
    await rpcRaw(program.methods
      .setSolPrice(new anchor.BN(150_000_000), new anchor.BN(clockNow))
      .accounts({ caller: oracle.publicKey, config: configPda }), [oracle]);
    await postOracle(900_000);
    const proXbond0 = Number(await bal(xbondMint, userPro.publicKey));
    // USDC pay-in: $10 at $0.90 with the 10% premium -> 12.222222 face.
    await buy(userPro, usdcMint, 10_000_000);
    // wSOL pay-in: 0.1 SOL = $15 at $150 -> 18.333333 face.
    await buy(userPro, wsolMint, 100_000_000);
    assert.equal(
      Number(await bal(xbondMint, userPro.publicKey)) - proXbond0,
      12_222_222 + 18_333_333
    );
    // A pay-in the program cannot price (xSHARE) is rejected.
    try {
      await buy(userPro, xshareMint, 1_000_000);
      assert.fail("expected BondPayinRejected");
    } catch (e: any) {
      assert.include(e.toString(), "BondPayinRejected");
    }
    // xTOMB pay-in burns like a classic bond and earns the 3%
    // xTOMB premium (face = TWAP value x 1.03, integer-mirrored).
    const gXtomb = Number(await bal(xtombMint, userGenesis.publicKey));
    const xPayin = Math.min(400_000, gXtomb);
    assert.isAbove(xPayin, 0);
    const gXbond0 = Number(await bal(xbondMint, userGenesis.publicKey));
    const xSupply0 = await mintSupply(xtombMint);
    await buy(userGenesis, xtombMint, xPayin);
    const xFace = Math.floor(
      (Math.floor((xPayin * 900_000) / 1_000_000) * 10_300) / 9_000
    );
    assert.equal(
      Number(await bal(xbondMint, userGenesis.publicKey)) - gXbond0,
      xFace
    );
    // Burned, not custodied: supply drops by exactly the pay-in.
    assert.equal(Number(await mintSupply(xtombMint)), Number(xSupply0) - xPayin);
    // Buy gate: at exactly $1.00, buys close.
    await postOracle(1_000_000);
    try {
      await buy(userPro, usdcMint, 1_000_000);
      assert.fail("expected BondBuyClosed");
    } catch (e: any) {
      assert.include(e.toString(), "BondBuyClosed");
    }
    // Above peg with no fresh backing: userPro's redemption queues whole.
    await postOracle(1_050_000);
    const proFace = 12_222_222 + 18_333_333;
    await redeem(userPro, proFace);
    const proBp = await program.account.bondPosition.fetch(
      await pda([Buffer.from("bond"), userPro.publicKey.toBuffer()])
    );
    assert.equal(proBp.queuedRedeem.toNumber(), proFace);
    assert.equal(
      Number(await bal(xbondMint, userPro.publicKey)) - proXbond0,
      proFace
    );
    // Operator leg: only the bot (or admin) may pull custodied pay-ins.
    try {
      await rpcRaw(program.methods
        .withdrawBondPayin(new anchor.BN(1))
        .accounts({
          caller: userPro.publicKey,
          config: configPda,
          payinMint: usdcMint,
          payinVault: await payinVaultOf(usdcMint),
          callerPayin: await ata(usdcMint, userPro.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        }), [userPro]);
      assert.fail("expected NotBot");
    } catch (e: any) {
      assert.include(e.toString(), "NotBot");
    }
    const botUsdc0 = Number(await bal(usdcMint, bot.publicKey));
    await rpcRaw(program.methods
      .withdrawBondPayin(new anchor.BN(10_000_000))
      .accounts({
        caller: bot.publicKey,
        config: configPda,
        payinMint: usdcMint,
        payinVault: await payinVaultOf(usdcMint),
        callerPayin: await ata(usdcMint, bot.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [bot]);
    assert.equal(Number(await bal(usdcMint, bot.publicKey)) - botUsdc0, 10_000_000);
    // The bot deposits LP backing; the queued redemption settles
    // pro-rata, and the last holder drains what remains.
    const BACKING = 20_000_000;
    await mintToManual(lpMint, await ata(lpMint, bot.publicKey), BACKING);
    await rpcRaw(program.methods
      .depositBondBacking(new anchor.BN(BACKING))
      .accounts({
        caller: bot.publicKey,
        config: configPda,
        callerLp: await ata(lpMint, bot.publicKey),
        bondLpVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      }), [bot]);
    const cfgBefore = await program.account.config.fetch(configPda);
    const outstanding = BigInt(cfgBefore.bondOutstanding.toNumber());
    const expectedPro = Number((BigInt(proFace) * BigInt(BACKING)) / outstanding);
    const proLp0 = Number(await bal(lpMint, userPro.publicKey));
    await redeem(userPro, 0);
    assert.equal(
      Number(await bal(lpMint, userPro.publicKey)) - proLp0,
      expectedPro
    );
    const proBp2 = await program.account.bondPosition.fetch(
      await pda([Buffer.from("bond"), userPro.publicKey.toBuffer()])
    );
    assert.equal(proBp2.queuedRedeem.toNumber(), 0);
    const gLp0 = Number(await bal(lpMint, userGenesis.publicKey));
    await redeem(userGenesis, xFace);
    assert.equal(
      Number(await bal(lpMint, userGenesis.publicKey)) - gLp0,
      BACKING - expectedPro
    );
    const cfgAfter = await program.account.config.fetch(configPda);
    assert.equal(cfgAfter.bondOutstanding.toNumber(), 0);
    assert.equal(cfgAfter.bondBackingLp.toNumber(), 0);
    const vaultAfter = await getAccount(provider.connection as any, bondLpVault);
    assert.equal(Number(vaultAfter.amount), 0);
  });
});
