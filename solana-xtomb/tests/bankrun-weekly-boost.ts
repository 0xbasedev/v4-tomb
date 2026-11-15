// xTOMB weekly loyalty boost — bankrun tests.
//
// Mirrors the EVM ShareRewardPool weekly-boost evidence (a)-(g),
// adapted for Jess's 2026-11-09 rulings: the 5% is baked in, and
// eligibility keys off MASONRY stake only (farms fund the boost).
//
// Timeline (loyalty weeks anchor at the farm start = Genesis end):
//   pre-anchor : alice + carol stake the Masonry; alice/bob stake
//                the two farm pools (weights 7500 / 2000)
//   anchor + 2d: carol dust-withdraws (dirties her week 0); bob
//                enters the Masonry mid-week (entrant)
//   anchor + 7d: week 0 closes -> (a) split, (b) sole-clean claim,
//                (c) dirty claim = 0, (d) entrant claim = 0
//   anchor + 8d: carol exits fully; dave stakes farm only
//   anchor +14d: week 1 closes -> farm-only claim = 0, (e) pro-rata
//   anchor +15d: alice + bob exit the Masonry entirely
//   anchor +21d: week 2 closes with zero eligible -> rolls forward
//   anchor +22d: dave enters the Masonry (entrant for week 3)
//   anchor +28d: week 3 also zero-eligible -> rolls forward again
//   anchor +35d: week 4 closes -> (g) dave claims 3 weeks of boost
//   anchor +42d: (f2) percent raised to 10 at the week-5 boundary
//                applies to week 5 only; week length is locked
//
// All warps land on whole days: farm emission is 813 base units/s
// and slices/accruals at whole-day segments are exact integers, so
// the assertions below are exact, not tolerances.
//
// Run:  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/bankrun-weekly-boost.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { startAnchor, Clock } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
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

const IDL = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../target/idl/xtomb.json"), "utf8")
);

const MPL_CORE_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
);
const DAY = 24 * 3600;
const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

// Exact expectations (emission 813/s; week = 604800 s).
const WEEK_GEN = 491_702_400; // one week of farm emission
const S = 24_585_120; // the 5% weekly slice
const POOL10_WEEK = 368_776_800; // 75% of WEEK_GEN
const POOL11_WEEK = 98_340_480; // 20% of WEEK_GEN

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

describe("xtomb weekly boost (bankrun)", () => {
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
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const carol = Keypair.generate();
  const dave = Keypair.generate();

  let genesisStart = 0;
  let anchorTs = 0; // farm start = genesis end = loyalty week anchor
  let usdcMint: PublicKey;
  let lpMint: PublicKey;
  let xtombMint: PublicKey;
  let xshareMint: PublicKey;
  let configPda: PublicKey;
  let boostStatePda: PublicKey;
  let farmVault: PublicKey;

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

  async function warpTo(ts: number) {
    await warp(ts - clockNow);
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

  async function bal(mint: PublicKey, owner: PublicKey): Promise<bigint> {
    return (await getAccount(provider.connection as any, await ata(mint, owner))).amount;
  }

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

  async function postOracle(twapE6: number) {
    await rpcRaw(
      program.methods
        .setOracle(new anchor.BN(twapE6), new anchor.BN(clockNow), PublicKey.default)
        .accounts({ caller: oracle.publicKey, config: configPda }),
      [oracle]
    );
  }

  // ---- boost-specific helpers ----

  async function boostUserPda(user: PublicKey) {
    return pda([Buffer.from("boost-user"), user.toBuffer()]);
  }

  // The four remaining accounts every Masonry stake/unstake must
  // carry once the boost is initialized.
  async function boostRemaining(user: Keypair) {
    return [
      { pubkey: boostStatePda, isWritable: true, isSigner: false },
      { pubkey: await boostUserPda(user.publicKey), isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
      { pubkey: user.publicKey, isWritable: true, isSigner: true },
    ];
  }

  async function stakePool(user: Keypair, poolId: number, amount: number, withBoost: boolean) {
    const poolPda = await pda([Buffer.from("pool"), u64le(poolId)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(poolId)]);
    let builder = program.methods
      .stake(new anchor.BN(poolId), new anchor.BN(amount), false)
      .accounts({
        user: user.publicKey,
        config: configPda,
        pool: poolPda,
        position: await pda([
          Buffer.from("position"),
          user.publicKey.toBuffer(),
          u64le(poolId),
        ]),
        pass: await pda([Buffer.from("pass"), user.publicKey.toBuffer()]),
        userToken: await ata(lpMint, user.publicKey),
        vault: vaultPda,
        treasuryToken: await ata(lpMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      });
    if (withBoost) {
      builder = builder.remainingAccounts(await boostRemaining(user));
    }
    await rpcRaw(builder, [user]);
  }

  async function unstakeMasonry(user: Keypair, amount: number) {
    await postOracle(1_000_000);
    const poolPda = await pda([Buffer.from("pool"), u64le(4)]);
    const vaultPda = await pda([Buffer.from("pool-vault"), u64le(4)]);
    await rpcRaw(
      program.methods
        .unstake(new anchor.BN(4), new anchor.BN(amount))
        .accounts({
          user: user.publicKey,
          config: configPda,
          pool: poolPda,
          position: await pda([
            Buffer.from("position"),
            user.publicKey.toBuffer(),
            u64le(4),
          ]),
          pass: await pda([Buffer.from("pass"), user.publicKey.toBuffer()]),
          vault: vaultPda,
          userToken: await ata(lpMint, user.publicKey),
          taxDestination: await ata(lpMint, treasury.publicKey),
          xtombMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(await boostRemaining(user)),
      [user]
    );
  }

  async function claimBoost(user: Keypair): Promise<number> {
    const before = Number(await bal(xshareMint, user.publicKey));
    await rpcRaw(
      program.methods.claimBoost().accounts({
        user: user.publicKey,
        config: configPda,
        boostState: boostStatePda,
        boostUser: await boostUserPda(user.publicKey),
        farmVault,
        userXshare: await ata(xshareMint, user.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      [user]
    );
    return Number(await bal(xshareMint, user.publicKey)) - before;
  }

  async function settleBoost() {
    await rpcRaw(
      program.methods
        .settleBoost()
        .accounts({ crank: admin.publicKey, config: configPda, boostState: boostStatePda }),
      [admin]
    );
  }

  async function boostState() {
    return program.account.boostState.fetch(boostStatePda);
  }

  // The week tables live in the BoostState account's raw data tail
  // (u64 LE per week; offsets WEEK_BOOST_OFF=128, WEEK_ELIG_OFF=
  // 128 + 8*366 = 3056 — see state.rs), not in the IDL struct.
  async function weekTableAt(base: number, w: number): Promise<number> {
    const info = await provider.connection.getAccountInfo(boostStatePda);
    return Number(info!.data.readBigUInt64LE(base + 8 * w));
  }
  const weekBoostAt = (w: number) => weekTableAt(128, w);
  const weekEligAt = (w: number) => weekTableAt(3056, w);

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
    boostStatePda = await pda([Buffer.from("boost-state")]);
    farmVault = await pda([Buffer.from("vault"), Buffer.from("farm")]);
    const clock = await context.banksClient.getClock();
    clockNow = Number(clock.unixTimestamp);
    genesisStart = clockNow - 2 * DAY;
    anchorTs = genesisStart + 7 * DAY;

    for (const kp of [admin, treasury, team, dev, bot, oracle, alice, bob, carol, dave]) {
      await fund(kp.publicKey, 10);
    }
    usdcMint = await createMintManual(6);
    lpMint = await createMintManual(6);
    for (const u of [alice, bob, carol, dave]) {
      const lpAta = await ata(lpMint, u.publicKey);
      await mintToManual(lpMint, lpAta, 10_000_000_000);
    }

    await rpcRaw(
      program.methods
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
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        }),
      [admin]
    );

    const xtombKp = Keypair.generate();
    const xshareKp = Keypair.generate();
    const xbondKp = Keypair.generate();
    xtombMint = xtombKp.publicKey;
    xshareMint = xshareKp.publicKey;
    const vault = (name: string) => pda([Buffer.from("vault"), Buffer.from(name)]);
    await rpcRaw(
      program.methods.createMints().accounts({
        admin: admin.publicKey,
        config: configPda,
        xtombMint,
        xshareMint,
        xbondMint: xbondKp.publicKey,
        rewardsVault: await vault("rewards"),
        farmVault,
        treasuryVaultXtomb: await vault("treasury-xtomb"),
        treasuryVaultXshare: await vault("treasury-xshare"),
        vestingVault: await vault("vesting"),
        masonryVault: await vault("masonry"),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      }),
      [admin, xtombKp, xshareKp, xbondKp]
    );

    const addPool = async (id: number, kind: number, mint: PublicKey, weight: number) => {
      await rpcRaw(
        program.methods.addPool(new anchor.BN(id), kind, mint, weight).accounts({
          admin: admin.publicKey,
          config: configPda,
          pool: await pda([Buffer.from("pool"), u64le(id)]),
          vault: await pda([Buffer.from("pool-vault"), u64le(id)]),
          assetMintAccount: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        }),
        [admin]
      );
    };
    await addPool(4, 3, lpMint, 0); // Masonry, LP asset
    await addPool(10, 2, lpMint, 7500); // farm xTOMB-LP share
    await addPool(11, 2, lpMint, 2000); // farm xSHARE-LP share

    await rpcRaw(
      program.methods.initializeBoost().accounts({
        admin: admin.publicKey,
        config: configPda,
        boostState: boostStatePda,
        systemProgram: SystemProgram.programId,
      }),
      [admin]
    );
  });

  it("setup: the 5% / 7-day defaults are baked into Config", async () => {
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.weeklyBoostPercent, 5);
    assert.isTrue(cfg.boostPercentConfigured);
    assert.equal(cfg.weekLengthDays, 7);
    assert.equal(cfg.farmWeightTotalBps, 9500);
    assert.isTrue(cfg.boostInitialized);
    const st = await boostState();
    assert.equal(st.anchorTs.toNumber(), anchorTs);
    assert.equal(st.lastSettleTs.toNumber(), anchorTs);
    assert.equal(st.closedWeeks.toNumber(), 0);
    assert.equal(st.totalBoostAccrued.toNumber(), 0);
  });

  it("(f) admin surface: bounds enforced, non-admin rejected, week length settable pre-start", async () => {
    const setCfg = (caller: Keypair, percent: number, days: number) =>
      rpcRaw(
        program.methods
          .setBoostConfig(percent, days)
          .accounts({
            admin: caller.publicKey,
            config: configPda,
            boostState: boostStatePda,
          }),
        [caller]
      );
    try {
      await setCfg(admin, 26, 7);
      assert.fail("expected BadBoostConfig");
    } catch (e: any) {
      assert.include(e.toString(), "BadBoostConfig");
    }
    try {
      await setCfg(admin, 5, 0);
      assert.fail("expected BadBoostConfig");
    } catch (e: any) {
      assert.include(e.toString(), "BadBoostConfig");
    }
    try {
      await setCfg(admin, 5, 31);
      assert.fail("expected BadBoostConfig");
    } catch (e: any) {
      assert.include(e.toString(), "BadBoostConfig");
    }
    try {
      await setCfg(alice, 5, 7);
      assert.fail("expected admin rejection");
    } catch (e: any) {
      assert.include(e.toString(), "ConstraintHasOne");
    }
    // Pre-start week-length change is allowed (and reversible).
    await setCfg(admin, 5, 14);
    assert.equal((await program.account.config.fetch(configPda)).weekLengthDays, 14);
    await setCfg(admin, 5, 7);
    assert.equal((await program.account.config.fetch(configPda)).weekLengthDays, 7);
  });

  it("pre-anchor stakes land; a Masonry stake without boost accounts is rejected", async () => {
    // Once initialized, the boost accounts are mandatory for the
    // Masonry — eligibility cannot be dodged by omitting them.
    try {
      await stakePool(alice, 4, 300_000_000, false);
      assert.fail("expected BoostAccountsMissing");
    } catch (e: any) {
      assert.include(e.toString(), "BoostAccountsMissing");
    }
    await stakePool(alice, 4, 300_000_000, true); // Masonry 300
    await stakePool(carol, 4, 200_000_000, true); // Masonry 200
    await stakePool(alice, 10, 100_000_000, false); // farm pool 10
    await stakePool(bob, 11, 100_000_000, false); // farm pool 11
    const st = await boostState();
    assert.equal(st.totalMasonryStaked.toNumber(), 500_000_000);
    assert.equal(st.openEligibleTotal.toNumber(), 500_000_000);
  });

  it("mid-week-0: carol's dust withdrawal dirties her week; bob enters as an entrant", async () => {
    await warpTo(anchorTs + 2 * DAY);
    const wts = clockNow;
    await unstakeMasonry(carol, 1); // 1 base unit: dust voids the week
    const rec = await program.account.boostUser.fetch(await boostUserPda(carol.publicKey));
    assert.isTrue(rec.weekDirty);
    assert.equal(rec.lastLpWithdrawalAt.toNumber(), wts); // the §7 loyalty clock
    assert.equal(rec.stakeTotal.toNumber(), 199_999_999);
    const st = await boostState();
    assert.equal(st.openEligibleTotal.toNumber(), 300_000_000);
    await stakePool(bob, 4, 100_000_000, true); // mid-week entrant
    const bobRec = await program.account.boostUser.fetch(await boostUserPda(bob.publicKey));
    assert.equal(bobRec.weekStartAmount.toNumber(), 0); // earns nothing this week
  });

  it("(a) week 0: farm emissions split exactly 75/20/5 and conserve", async () => {
    await warpTo(anchorTs + 7 * DAY);
    const harvest = async (user: Keypair, poolId: number) => {
      const vaultBefore = Number(
        (await getAccount(provider.connection as any, farmVault)).amount
      );
      await rpcRaw(
        program.methods.harvest(new anchor.BN(poolId)).accounts({
          user: user.publicKey,
          config: configPda,
          pool: await pda([Buffer.from("pool"), u64le(poolId)]),
          position: await pda([
            Buffer.from("position"),
            user.publicKey.toBuffer(),
            u64le(poolId),
          ]),
          farmVault,
          treasuryXshare: await ata(xshareMint, treasury.publicKey),
          userXshare: await ata(xshareMint, user.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [user]
      );
      const vaultAfter = Number(
        (await getAccount(provider.connection as any, farmVault)).amount
      );
      return vaultBefore - vaultAfter; // gross pending (net + fee)
    };
    const p10 = await harvest(alice, 10);
    const p11 = await harvest(bob, 11);
    assert.equal(p10, POOL10_WEEK);
    assert.equal(p11, POOL11_WEEK);
    await settleBoost();
    const st = await boostState();
    assert.equal(await weekBoostAt(0), S);
    assert.equal(await weekEligAt(0), 300_000_000);
    assert.equal(st.closedWeeks.toNumber(), 1);
    assert.equal(st.totalBoostAccrued.toNumber(), S);
    assert.equal(p10 + p11 + S, WEEK_GEN); // conservation, to the unit
  });

  it("(b)(c)(d) week-0 claims: clean staker paid in full; dirty and entrant get nothing", async () => {
    assert.equal(await claimBoost(alice), S); // sole eligible staker
    assert.equal(await claimBoost(alice), 0); // second claim pays nothing
    assert.equal(await claimBoost(carol), 0); // dust withdrawal voided her week
    assert.equal(await claimBoost(bob), 0); // mid-week entrant waits a full week
  });

  it("week 1: carol exits fully; dave's farm-only stake earns nothing", async () => {
    await warpTo(anchorTs + 8 * DAY);
    await unstakeMasonry(carol, 199_999_999);
    await stakePool(dave, 10, 500_000_000, false); // farm only, all week 1
    await warpTo(anchorTs + 14 * DAY);
    await settleBoost();
    assert.equal(await weekEligAt(1), 400_000_000);
    assert.equal(await weekBoostAt(1), S);
    assert.equal(await claimBoost(dave), 0); // farm stake alone never qualifies
  });

  it("(e) week-1 bucket splits pro-rata between the two clean stakers", async () => {
    assert.equal(await claimBoost(alice), 18_438_840); // 300/400 of S
    assert.equal(await claimBoost(bob), 6_146_280); // 100/400 of S
  });

  it("(g) zero-eligible weeks roll their buckets forward until a full clean week", async () => {
    await warpTo(anchorTs + 15 * DAY);
    await unstakeMasonry(alice, 300_000_000);
    await unstakeMasonry(bob, 100_000_000);
    await warpTo(anchorTs + 21 * DAY);
    await settleBoost();
    assert.equal(await weekEligAt(2), 0);
    assert.equal(await weekBoostAt(2), 0); // rolled out
    assert.equal(await weekBoostAt(3), S); // rolled in (+ its own week still accruing)
    await warpTo(anchorTs + 22 * DAY);
    await stakePool(dave, 4, 50_000_000, true); // entrant in week 3
    await warpTo(anchorTs + 28 * DAY);
    await settleBoost();
    assert.equal(await weekEligAt(3), 0); // dave was an entrant
    assert.equal(await weekBoostAt(3), 0);
    assert.equal(await weekBoostAt(4), 2 * S); // two rolled buckets waiting
    await warpTo(anchorTs + 35 * DAY);
    // Week 4 is dave's first full week: he collects weeks 2+3+4.
    assert.equal(await claimBoost(dave), 3 * S);
  });

  it("(f2) percent change applies from the change; week length locked after farm start", async () => {
    try {
      await rpcRaw(
        program.methods.setBoostConfig(5, 14).accounts({
          admin: admin.publicKey,
          config: configPda,
          boostState: boostStatePda,
        }),
        [admin]
      );
      assert.fail("expected BoostWeekLengthLocked");
    } catch (e: any) {
      assert.include(e.toString(), "BoostWeekLengthLocked");
    }
    await rpcRaw(
      program.methods.setBoostConfig(10, 7).accounts({
        admin: admin.publicKey,
        config: configPda,
        boostState: boostStatePda,
      }),
      [admin]
    );
    assert.equal((await program.account.config.fetch(configPda)).weeklyBoostPercent, 10);
    await warpTo(anchorTs + 42 * DAY);
    await settleBoost();
    // Week 5 ran entirely at 10%: bw = floor(9500*10/90) = 1055,
    // slice = floor(491702400 * 1055 / 10555) = 49,146,947.
    assert.equal(await weekBoostAt(5), 49_146_947);
  });
});
