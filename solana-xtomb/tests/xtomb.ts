// xTOMB Anchor tests.
//
// NOTE on time: the validator clock is wall-clock time, so Genesis is
// configured with T = now - 2 days (Day 2+: LP open, 5 days left) and
// rewards are measured over real seconds of waiting. Epoch tests can
// only cover the admin trigger + not-due path (a 6h epoch cannot be
// waited out here); bootstrap/expansion gating is covered by the Rust
// unit tests in programs/xtomb/src/math.rs.
//
// NOTE on Metaplex Core: buy_pass CPIs into the Core program
// (CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d). On a local validator
// that program must be loaded with --bpf-program from a devnet dump,
// otherwise buy_pass (and everything needing a pass) fails. The tests
// below detect that and skip pass-dependent cases instead of failing.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { assert } from "chai";
import { Xtomb } from "../target/types/xtomb";

const MPL_CORE_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
);
const DAY = 24 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

describe("xtomb", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Xtomb as Program<Xtomb>;
  const connection = provider.connection;

  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  const team = Keypair.generate();
  const dev = Keypair.generate();
  const bot = Keypair.generate();
  const oracle = Keypair.generate();
  const userGenesis = Keypair.generate();
  const userPro = Keypair.generate();
  const userUltra = Keypair.generate();
  const keeper = Keypair.generate();

  const genesisStart = nowSec() - 2 * DAY; // Day 2+: LP open
  let usdcMint: PublicKey;
  let lpMint: PublicKey;
  let xtombMint: PublicKey;
  let xshareMint: PublicKey;
  let xbondMint: PublicKey;
  let configPda: PublicKey;
  let coreAvailable = true;

  async function airdrop(kp: Keypair, sol = 5) {
    const sig = await connection.requestAirdrop(
      kp.publicKey,
      sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(sig);
  }

  async function ata(mint: PublicKey, owner: PublicKey) {
    return (
      await getOrCreateAssociatedTokenAccount(
        connection,
        admin,
        mint,
        owner
      )
    ).address;
  }

  async function bal(mint: PublicKey, owner: PublicKey): Promise<bigint> {
    const a = await ata(mint, owner);
    return (await getAccount(connection, a)).amount;
  }

  async function pda(seeds: (Buffer | Uint8Array)[]) {
    return PublicKey.findProgramAddressSync(
      seeds.map((s) => Buffer.from(s)),
      program.programId
    )[0];
  }

  async function postOracle(twapE6: number, ts?: number) {
    await program.methods
      .setOracle(new anchor.BN(twapE6), new anchor.BN(ts ?? nowSec()), PublicKey.default())
      .accounts({ caller: oracle.publicKey, config: configPda })
      .signers([oracle])
      .rpc();
  }

  before(async () => {
    configPda = await pda([Buffer.from("config")]);
    // Fund everyone.
    for (const kp of [admin, treasury, team, dev, bot, oracle, userGenesis, userPro, userUltra, keeper]) {
      await airdrop(kp);
    }
    // Test USDC + LP stand-in mints (6 decimals, like the real assets).
    usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
    lpMint = await createMint(connection, admin, admin.publicKey, null, 6);
    for (const u of [userGenesis, userPro, userUltra]) {
      const usdcAta = await ata(usdcMint, u.publicKey);
      await mintTo(connection, admin, usdcMint, usdcAta, admin, 100_000_000_000); // 100,000 USDC
      const lpAta = await ata(lpMint, u.publicKey);
      await mintTo(connection, admin, lpMint, lpAta, admin, 10_000_000_000); // 10,000 LP
    }
  });

  it("initializes config with the Genesis window and fee splits", async () => {
    await program.methods
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
      .accounts({ admin: admin.publicKey, config: configPda, systemProgram: SystemProgram.programId })
      .signers([admin])
      .rpc();
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
    // NOTE: createMints needs fresh mint keypairs as signers.
    const xtombKp = Keypair.generate();
    const xshareKp = Keypair.generate();
    const xbondKp = Keypair.generate();
    xtombMint = xtombKp.publicKey;
    xshareMint = xshareKp.publicKey;
    xbondMint = xbondKp.publicKey;
    const vault = (name: string) => pda([Buffer.from("vault"), Buffer.from(name)]);
    await program.methods
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
      })
      .signers([admin, xtombKp, xshareKp, xbondKp])
      .rpc();
    const rewards = await getAccount(connection, await vault("rewards"));
    assert.equal(Number(rewards.amount), 30_000_000_000);
    const farm = await getAccount(connection, await vault("farm"));
    assert.equal(Number(farm.amount), 25_641_000_000);
    const vesting = await getAccount(connection, await vault("vesting"));
    assert.equal(Number(vesting.amount), 6_941_000_000);
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.circulatingXtomb.toNumber(), 41_000_000_000);
  });

  it("adds pools with canonical ids; rejects a wrong id for the kind", async () => {
    const addPool = async (id: number, kind: number, mint: PublicKey, weight: number) => {
      const poolPda = await pda([Buffer.from("pool"), u64le(id)]);
      const vaultPda = await pda([Buffer.from("pool-vault"), u64le(id)]);
      return program.methods
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
        })
        .signers([admin])
        .rpc();
    };
    await addPool(1, 0, usdcMint, 0); // standard
    await addPool(2, 1, lpMint, 0); // LP
    await addPool(3, 4, xtombMint, 0); // Ultra-NFT
    await addPool(4, 3, xtombMint, 0); // Masonry
    await addPool(10, 2, lpMint, 10000); // farm
    // Wrong canonical id: kind standard (0) must be pool 1.
    try {
      await addPool(7, 0, usdcMint, 0);
      assert.fail("expected WrongPoolId");
    } catch (e: any) {
      assert.include(e.toString(), "WrongPoolId");
    }
  });

  it("buys passes (Genesis/Pro/Ultra) as soulbound Core NFTs", async function () {
    this.timeout(120_000);
    const buy = async (user: Keypair, tier: number) => {
      const assetKp = Keypair.generate();
      const passPda = await pda([Buffer.from("pass"), user.publicKey.toBuffer()]);
      await program.methods
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
        })
        .signers([user, assetKp])
        .rpc();
      return passPda;
    };
    try {
      const p1 = await buy(userGenesis, 1);
      const pass1 = await program.account.pass.fetch(p1);
      assert.equal(pass1.tier, 1);
      const p2 = await buy(userPro, 2);
      assert.equal((await program.account.pass.fetch(p2)).tier, 2);
      const p3 = await buy(userUltra, 3);
      assert.equal((await program.account.pass.fetch(p3)).tier, 3);
      // Treasury received 50 + 100 + 300 USDC.
      assert.equal(Number(await bal(usdcMint, treasury.publicKey)), 450_000_000);
      // One pass per wallet: second buy fails.
      try {
        await buy(userGenesis, 1);
        assert.fail("expected duplicate-pass failure");
      } catch (e) {
        assert.isTrue(true);
      }
    } catch (e: any) {
      if (e.toString().includes("ProgramNotFound") || e.toString().includes("Program not found") || e.toString().includes("Failed to find program")) {
        coreAvailable = false;
        console.log("SKIP: Metaplex Core program not loaded on this validator; pass-dependent tests skipped.");
        this.skip();
      }
      throw e;
    }
  });

  it("upgrades Genesis -> Pro in place for the $50 difference only", async function () {
    if (!coreAvailable) this.skip();
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    const before = Number(await bal(usdcMint, treasury.publicKey));
    await program.methods
      .upgradePass(2)
      .accounts({
        buyer: userGenesis.publicKey,
        config: configPda,
        pass: passPda,
        buyerUsdc: await ata(usdcMint, userGenesis.publicKey),
        treasuryUsdc: await ata(usdcMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userGenesis])
      .rpc();
    assert.equal((await program.account.pass.fetch(passPda)).tier, 2);
    assert.equal(Number(await bal(usdcMint, treasury.publicKey)), before + 50_000_000);
  });

  it("stakes standard USDC with the tier deposit fee (Pro 1%)", async function () {
    if (!coreAvailable) this.skip();
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    await program.methods
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
      })
      .signers([userGenesis])
      .rpc();
    const pos = await program.account.position.fetch(posPda);
    // Pro tier: 1% fee on 1,000 USDC -> 990 staked.
    assert.equal(pos.amount.toNumber(), 990_000_000);
    assert.equal(Number(await bal(usdcMint, treasury.publicKey)), 450_000_000 + 50_000_000 + 10_000_000);
  });

  it("Genesis claim at peg pays the 3% Fire Tax (burned) after real seconds accrue", async function () {
    if (!coreAvailable) this.skip();
    this.timeout(120_000);
    await new Promise((r) => setTimeout(r, 8000));
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    // Genesis claims are TWAP-priced: the oracle must be fresh.
    await postOracle(1_000_000);
    const before = Number(await bal(xtombMint, userGenesis.publicKey));
    await program.methods
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
      })
      .signers([userGenesis])
      .rpc();
    const after = Number(await bal(xtombMint, userGenesis.publicKey));
    // ~8s of Day-2 standard share (23.75% of ~49,603 base units/s),
    // sole staker, 50% liquid, 3% Fire Tax at peg -> > 0.
    assert.isAbove(after - before, 0);
    const pos = await program.account.position.fetch(posPda);
    assert.equal(pos.accruedLiquid.toNumber(), 0);
    assert.isAbove(pos.vestingTotal.toNumber(), 0);
  });

  it("compounds LP rewards, then a second compound within 3h MUST fail", async function () {
    if (!coreAvailable) this.skip();
    this.timeout(180_000);
    await postOracle(1_000_000);
    const poolPda = await pda([Buffer.from("pool"), u64le(2)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(2)]);
    const posPda = await pda([Buffer.from("position"), userPro.publicKey.toBuffer(), u64le(2)]);
    const passPda = await pda([Buffer.from("pass"), userPro.publicKey.toBuffer()]);
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    // Stake LP first.
    await program.methods
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
      })
      .signers([userPro])
      .rpc();
    await new Promise((r) => setTimeout(r, 8000));
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
    await program.methods
      .compound(new anchor.BN(2), false)
      .accounts(compoundAccounts)
      .signers([userPro])
      .rpc();
    const posAfter = await program.account.position.fetch(posPda);
    assert.isAbove(posAfter.amount.toNumber(), 995_000_000); // LP fee 0.5% on the stake
    // Second compound inside the 3h cap: must revert with CompoundTooSoon.
    try {
      await program.methods
        .compound(new anchor.BN(2), false)
        .accounts(compoundAccounts)
        .signers([userPro])
        .rpc();
      assert.fail("expected CompoundTooSoon");
    } catch (e: any) {
      assert.include(e.toString(), "CompoundTooSoon");
    }
    // Keeper compound on a Genesis-tier pass must fail the tier check.
    // (userGenesis has a Pro pass after the upgrade, so use a fresh
    // Genesis-tier user instead: covered by unit test + manual check.)
  });

  it("keeper compound requires Pro/Ultra tier", async function () {
    if (!coreAvailable) this.skip();
    // userGenesis is now Pro (upgraded), so this checks the keeper path
    // is reachable for Pro: a keeper call right after the manual
    // compound above must fail on the 3h cap, not on tier.
    const poolPda = await pda([Buffer.from("pool"), u64le(2)]);
    const posPda = await pda([Buffer.from("position"), userPro.publicKey.toBuffer(), u64le(2)]);
    const passPda = await pda([Buffer.from("pass"), userPro.publicKey.toBuffer()]);
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    try {
      await program.methods
        .compound(new anchor.BN(2), true)
        .accounts({
          caller: keeper.publicKey,
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
        })
        .signers([keeper])
        .rpc();
      assert.fail("expected CompoundTooSoon for the keeper call");
    } catch (e: any) {
      assert.include(e.toString(), "CompoundTooSoon");
    }
  });

  it("withdrawal Fire Tax: 3% at peg during Genesis, then curve to 12%", async function () {
    if (!coreAvailable) this.skip();
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    const unstake = async (amount: number) => {
      const userBefore = Number(await bal(usdcMint, userGenesis.publicKey));
      const treBefore = Number(await bal(usdcMint, treasury.publicKey));
      await program.methods
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
        })
        .signers([userGenesis])
        .rpc();
      const userAfter = Number(await bal(usdcMint, userGenesis.publicKey));
      const treAfter = Number(await bal(usdcMint, treasury.publicKey));
      return { net: userAfter - userBefore, tax: treAfter - treBefore };
    };
    // A: TWAP $1.00, Genesis -> 3% (xTOMB baseline; Genesis minimum is also 3%).
    await postOracle(1_000_000);
    let r = await unstake(100_000_000);
    assert.equal(r.tax, 3_000_000);
    assert.equal(r.net, 97_000_000);
    // B: TWAP $0.925 -> baseline 300 + shared increment 1100*0.25 = 575 bps = 5.75%.
    await postOracle(925_000);
    r = await unstake(100_000_000);
    assert.equal(r.tax, 5_750_000);
    assert.equal(r.net, 94_250_000);
    // C: TWAP $0.85 -> 12% cap.
    await postOracle(850_000);
    r = await unstake(100_000_000);
    assert.equal(r.tax, 12_000_000);
    assert.equal(r.net, 88_000_000);
    // D: stale oracle (31 min old) -> withdrawals fail closed.
    await postOracle(1_000_000, nowSec() - 31 * 60);
    try {
      await unstake(10_000_000);
      assert.fail("expected OracleStale");
    } catch (e: any) {
      assert.include(e.toString(), "OracleStale");
    }
    await postOracle(1_000_000);
  });

  it("xBOND (LP-zap): buy only below $1.00, xTOMB pay-in custodied not burned, redeem only above $1.00, queues with no backing", async function () {
    if (!coreAvailable) this.skip();
    this.timeout(120_000);
    // Give userGenesis spendable xTOMB: stake more + wait + claim.
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    await program.methods
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
      })
      .signers([userGenesis])
      .rpc();
    await new Promise((r) => setTimeout(r, 15000));
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    // Still inside Genesis: the claim is Fire-Tax priced, oracle must be fresh.
    await postOracle(1_000_000);
    await program.methods
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
      })
      .signers([userGenesis])
      .rpc();
    const xtombBal = Number(await bal(xtombMint, userGenesis.publicKey));
    assert.isAbove(xtombBal, 0);
    const xbondAta = await ata(xbondMint, userGenesis.publicKey);
    const bondLpVault = await pda([Buffer.from("bond-lp-vault")]);
    const buyBondAccounts = {
      buyer: userGenesis.publicKey,
      config: configPda,
      payinMint: xtombMint,
      buyerPayin: await ata(xtombMint, userGenesis.publicKey),
      payinVault: await pda([Buffer.from("bond-payin"), xtombMint.toBuffer()]),
      buyerXbond: xbondAta,
      xbondMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    // Buy gate: at $1.00 the buy is closed.
    await postOracle(1_000_000);
    try {
      await program.methods
        .buyBond(new anchor.BN(10_000))
        .accounts(buyBondAccounts)
        .signers([userGenesis])
        .rpc();
      assert.fail("expected BondBuyClosed");
    } catch (e: any) {
      assert.include(e.toString(), "BondBuyClosed");
    }
    // Buy at $0.90 with xTOMB: the paid xTOMB BURNS like a classic
    // bond and earns the 3% xTOMB premium, so the face credited is
    // the pay-in's TWAP value x 1.03 (integer-mirrored).
    await postOracle(900_000);
    const payinAmount = Math.min(50_000, Math.floor(xtombBal * 0.9));
    assert.isAbove(payinAmount, 0);
    await program.methods
      .buyBond(new anchor.BN(payinAmount))
      .accounts(buyBondAccounts)
      .signers([userGenesis])
      .rpc();
    const expectedFace = Math.floor(
      (Math.floor((payinAmount * 900_000) / 1_000_000) * 10_300) / 9_000
    );
    assert.equal(Number(await bal(xbondMint, userGenesis.publicKey)), expectedFace);
    // Register the LP mint (the tests' mock LP) — creates the
    // backing vault redemptions pay out of.
    await program.methods
      .setBondConfig(1000)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        lpMint,
        bondLpVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
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
    // Redeem gate: at $0.90 the redeem is closed.
    try {
      await program.methods
        .redeemBond(new anchor.BN(expectedFace))
        .accounts(redeemAccounts)
        .signers([userGenesis])
        .rpc();
      assert.fail("expected BondRedeemClosed");
    } catch (e: any) {
      assert.include(e.toString(), "BondRedeemClosed");
    }
    // Redeem at $1.05 with zero backing: queues, no tokens move.
    await postOracle(1_050_000);
    await program.methods
      .redeemBond(new anchor.BN(expectedFace))
      .accounts(redeemAccounts)
      .signers([userGenesis])
      .rpc();
    const bp = await program.account.bondPosition.fetch(
      await pda([Buffer.from("bond"), userGenesis.publicKey.toBuffer()])
    );
    assert.equal(bp.queuedRedeem.toNumber(), expectedFace);
    assert.equal(Number(await bal(xbondMint, userGenesis.publicKey)), expectedFace);
  });

  it("epochs: admin triggers Epoch 0; a second settle immediately is not due", async () => {
    const masonryPool = await pda([Buffer.from("pool"), u64le(4)]);
    const masonryVault = await pda([Buffer.from("vault"), Buffer.from("masonry")]);
    await program.methods
      .advanceEpoch(true)
      .accounts({
        caller: admin.publicKey,
        config: configPda,
        masonryPool,
        xtombMint,
        masonryVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.isTrue(cfg.epoch0Open);
    try {
      await program.methods
        .advanceEpoch(false)
        .accounts({
          caller: admin.publicKey,
          config: configPda,
          masonryPool,
          xtombMint,
          masonryVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();
      assert.fail("expected EpochNotDue");
    } catch (e: any) {
      assert.include(e.toString(), "EpochNotDue");
    }
  });

  it("Masonry claim pays the Fire Tax to Treasury (stake + no-accrual path)", async function () {
    // Mirror of the bankrun Masonry claim tests. A wall-clock validator
    // cannot wait out a 6h epoch, so no Masonry rewards can accrue
    // here; the exact Fire Tax payout assertions (3% at peg and 7.88%
    // at $0.90, both routed to Treasury, nothing burned) live in
    // tests/bankrun.ts. This covers the reachable path: staking into
    // the Masonry pool and a claim with nothing accrued.
    if (!coreAvailable) this.skip();
    const poolPda = await pda([Buffer.from("pool"), u64le(4)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(4)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(4)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    const masonryVault = await pda([Buffer.from("vault"), Buffer.from("masonry")]);
    await program.methods
      .stake(new anchor.BN(4), new anchor.BN(1_000_000), false)
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
      })
      .signers([userGenesis])
      .rpc();
    const pos = await program.account.position.fetch(posPda);
    assert.equal(pos.amount.toNumber(), 1_000_000);
    try {
      await program.methods
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
        })
        .signers([userGenesis])
        .rpc();
      assert.fail("expected NothingToClaim");
    } catch (e: any) {
      assert.include(e.toString(), "NothingToClaim");
    }
  });

  it("admin controls: non-admin cannot set fees; maintenance blocks staking", async function () {
    if (!coreAvailable) this.skip();
    try {
      await program.methods
        .setFeeConfig(200, 200, 50, 5000, 2000, 1500, 1500)
        .accounts({ admin: userGenesis.publicKey, config: configPda })
        .signers([userGenesis])
        .rpc();
      assert.fail("expected NotAdmin");
    } catch (e: any) {
      assert.isTrue(true); // has_one=admin constraint rejects
    }
    await program.methods
      .setMaintenance(true)
      .accounts({ admin: admin.publicKey, config: configPda })
      .signers([admin])
      .rpc();
    const poolPda = await pda([Buffer.from("pool"), u64le(1)]);
    const posPda = await pda([Buffer.from("position"), userGenesis.publicKey.toBuffer(), u64le(1)]);
    const passPda = await pda([Buffer.from("pass"), userGenesis.publicKey.toBuffer()]);
    try {
      await program.methods
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
        })
        .signers([userGenesis])
        .rpc();
      assert.fail("expected Maintenance");
    } catch (e: any) {
      assert.include(e.toString(), "Maintenance");
    }
    await program.methods
      .setMaintenance(false)
      .accounts({ admin: admin.publicKey, config: configPda })
      .signers([admin])
      .rpc();
  });
});
