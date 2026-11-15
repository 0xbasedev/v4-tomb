// xTOMB bankrun regression tests: REPEAT settles must pay only the
// incremental accrual since the previous settle.
//
// Regression for the pending_rewards unit bug (found 2026-11-08):
// pending_rewards subtracted position.reward_debt — stored
// TOKEN-denominated (amount * acc_per_share / ACC_SCALE) — directly
// from pool.acc_per_share (PER-SHARE-denominated). A position's first
// settle was correct (debt 0), but every repeat settle overstated
// pending by roughly amount * acc_per_share / ACC_SCALE extra, and
// once the accumulator grew, repeat claims/harvests/compounds
// reverted with InsufficientRewards (the vault cannot cover the
// phantom amount) — bricking repeat settles on every pool kind.
//
// These tests settle the SAME position twice (Masonry: three times)
// on every settle path — Genesis claim, LP compound, Masonry claim,
// farm harvest — with exact-delta assertions computed from an
// independent BigInt mirror of the on-chain accumulator math, plus
// conservation checks (a rewards vault's cumulative outflow never
// exceeds the emissions actually credited to its pool, and split
// settles sum to the single-settle entitlement up to the stated
// rounding bound).
//
// Run:  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/bankrun-repeat-settle.ts

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

const IDL = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../target/idl/xtomb.json"), "utf8")
);

const MPL_CORE_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
);
const DAY = 24 * 3600;
const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

// ---- independent mirror of the on-chain accumulator math ----
// Rust: minted_seg = emission * share_bps * secs / 10_000 (floored per
// segment); acc += minted * ACC_SCALE / total_staked (floored);
// entitlement(amount, acc) = amount * acc / ACC_SCALE (floored);
// pending = entitlement(now) - entitlement already settled.
const SCALE = 1_000_000_000_000n;
const GEN_RATE = 49_603n; // 30_000_000_000 / 604_800, floored on-chain
const FARM_RATE = 813n; // 25_641_000_000 / 31_536_000, floored on-chain
const SHARE_STANDARD_DAY2 = 2_375n;
const SHARE_LP_DAY2 = 7_125n;

function genesisMinted(shareBps: bigint, secs: bigint): bigint {
  return (GEN_RATE * shareBps * secs) / 10_000n;
}
function accAfter(minted: bigint, accBefore: bigint, totalStaked: bigint): bigint {
  return accBefore + (minted * SCALE) / totalStaked;
}
function entitled(amount: bigint, acc: bigint): bigint {
  return (amount * acc) / SCALE;
}

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

describe("xtomb repeat-settle regression (bankrun)", () => {
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
  const userA = Keypair.generate(); // Genesis standard pool, claim x2
  const userLP = Keypair.generate(); // LP pool, compound x2
  const userM = Keypair.generate(); // Masonry, claim x3
  const userF = Keypair.generate(); // farm, harvest x2

  let genesisStart = 0;
  let usdcMint: PublicKey;
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

  async function vaultBal(addr: PublicKey): Promise<bigint> {
    return (await getAccount(provider.connection as any, addr)).amount;
  }

  async function mintSupply(mint: PublicKey): Promise<bigint> {
    const info = await provider.connection.getAccountInfo(mint);
    return info!.data.readBigUInt64LE(36);
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

  async function postOracle(twapE6: number, ts?: number) {
    await rpcRaw(
      program.methods
        .setOracle(
          new anchor.BN(twapE6),
          new anchor.BN(ts ?? clockNow),
          PublicKey.default
        )
        .accounts({ caller: oracle.publicKey, config: configPda }),
      [oracle]
    );
  }

  async function poolState(id: number) {
    const pool = await program.account.pool.fetch(
      await pda([Buffer.from("pool"), u64le(id)])
    );
    return {
      acc: BigInt(pool.accPerShare.toString()),
      totalStaked: BigInt(pool.totalStaked.toString()),
    };
  }

  async function posState(user: PublicKey, id: number) {
    const pos = await program.account.position.fetch(
      await pda([Buffer.from("position"), user.toBuffer(), u64le(id)])
    );
    return {
      amount: BigInt(pos.amount.toString()),
      accruedLiquid: BigInt(pos.accruedLiquid.toString()),
      accruedVested: BigInt(pos.accruedVested.toString()),
      vestingTotal: BigInt(pos.vestingTotal.toString()),
    };
  }

  async function cfgState() {
    const cfg = await program.account.config.fetch(configPda);
    return {
      distributed: BigInt(cfg.genesisRewardsDistributed.toString()),
      circulating: BigInt(cfg.circulatingXtomb.toString()),
      currentEpoch: cfg.currentEpoch.toNumber(),
    };
  }

  function stakeAccounts(user: PublicKey, id: number, mint: PublicKey) {
    return (async () => ({
      user,
      config: configPda,
      pool: await pda([Buffer.from("pool"), u64le(id)]),
      position: await pda([Buffer.from("position"), user.toBuffer(), u64le(id)]),
      pass: await pda([Buffer.from("pass"), user.toBuffer()]),
      userToken: await ata(mint, user),
      vault: await pda([Buffer.from("pool-vault"), u64le(id)]),
      treasuryToken: await ata(mint, treasury.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }))();
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
    genesisStart = clockNow - 2 * DAY; // Day 2+: LP pool open

    for (const kp of [admin, treasury, team, dev, bot, oracle, userA, userLP, userM, userF]) {
      await fund(kp.publicKey, 10);
    }
    usdcMint = await createMintManual(6);
    lpMint = await createMintManual(6);
    for (const u of [userA, userLP, userM, userF]) {
      await mintToManual(usdcMint, await ata(usdcMint, u.publicKey), 100_000_000_000);
      await mintToManual(lpMint, await ata(lpMint, u.publicKey), 10_000_000_000);
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
    xbondMint = xbondKp.publicKey;
    const vault = (name: string) => pda([Buffer.from("vault"), Buffer.from(name)]);
    await rpcRaw(
      program.methods
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
        }),
      [admin, xtombKp, xshareKp, xbondKp]
    );

    const addPool = async (id: number, kind: number, mint: PublicKey, weight: number) => {
      await rpcRaw(
        program.methods
          .addPool(new anchor.BN(id), kind, mint, weight)
          .accounts({
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
    await addPool(1, 0, usdcMint, 0); // standard
    await addPool(2, 1, lpMint, 0); // LP
    await addPool(4, 3, xtombMint, 0); // Masonry
    await addPool(10, 2, lpMint, 10000); // farm, 100% weight

    const buy = async (user: Keypair, tier: number) => {
      const assetKp = Keypair.generate();
      await rpcRaw(
        program.methods
          .buyPass(tier)
          .accounts({
            buyer: user.publicKey,
            config: configPda,
            pass: await pda([Buffer.from("pass"), user.publicKey.toBuffer()]),
            asset: assetKp.publicKey,
            buyerUsdc: await ata(usdcMint, user.publicKey),
            treasuryUsdc: await ata(usdcMint, treasury.publicKey),
            mplCoreProgram: MPL_CORE_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          }),
        [user, assetKp]
      );
    };
    await buy(userA, 2); // Pro: 1% standard deposit fee -> 990,000,000 net
    await buy(userLP, 2);
    await buy(userM, 2);
    await buy(userF, 1);
  });

  it("Genesis standard pool: second claim pays ONLY the second window's accrual", async () => {
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    // Stake 1,000 USDC as Pro -> 990,000,000 credited, sole staker.
    await rpcRaw(
      program.methods
        .stake(new anchor.BN(1), new anchor.BN(1_000_000_000), false)
        .accounts(await stakeAccounts(userA.publicKey, 1, usdcMint)),
      [userA]
    );
    const st = await poolState(1);
    assert.equal(st.totalStaked, 990_000_000n);
    assert.equal(st.acc, 0n);
    const A = 990_000_000n;
    let paidGross = 0n; // cumulative gross settled (liquid+vested) so far
    let cumVested = 0n; // cumulative vested halves booked so far
    let accPrev = 0n;

    const claimOnce = async (secs: number, mintedExpected: bigint) => {
      await warp(secs);
      await postOracle(1_000_000);
      const cfgBefore = await cfgState();
      const userBefore = await bal(xtombMint, userA.publicKey);
      const vaultBefore = await vaultBal(rewardsVault);
      const supplyBefore = await mintSupply(xtombMint);
      await rpcRaw(
        program.methods
          .claim(new anchor.BN(1))
          .accounts({
            user: userA.publicKey,
            config: configPda,
            pool: await pda([Buffer.from("pool"), u64le(1)]),
            position: await pda([
              Buffer.from("position"),
              userA.publicKey.toBuffer(),
              u64le(1),
            ]),
            rewardsVault,
            treasuryXtomb: await ata(xtombMint, treasury.publicKey),
            userXtomb: await ata(xtombMint, userA.publicKey),
            xtombMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          }),
        [userA]
      );
      // Mirror: pool accrued exactly the single segment for this window.
      const accNow = accAfter(mintedExpected, accPrev, A);
      const gross = entitled(A, accNow) - paidGross;
      const liquid = gross / 2n;
      const fee = (liquid * 300n) / 10_000n; // 3% Fire Tax at peg, burned
      const poolAfter = await poolState(1);
      assert.equal(poolAfter.acc, accNow, "accumulator matches mirror");
      const cfgAfter = await cfgState();
      assert.equal(
        cfgAfter.distributed - cfgBefore.distributed,
        mintedExpected,
        "Genesis distributed delta == segment mint"
      );
      assert.equal(vaultBefore - (await vaultBal(rewardsVault)), liquid, "vault pays liquid only");
      assert.equal(
        (await bal(xtombMint, userA.publicKey)) - userBefore,
        liquid - fee,
        "user receives liquid minus 3% Fire Tax"
      );
      assert.equal(
        supplyBefore - (await mintSupply(xtombMint)),
        fee,
        "the Fire Tax burns out of the mint supply"
      );
      cumVested += gross - liquid;
      const pos = await posState(userA.publicKey, 1);
      assert.equal(pos.accruedLiquid, 0n);
      assert.equal(pos.vestingTotal, cumVested, "vested halves accumulate exactly");
      assert.equal(pos.accruedVested, cumVested);
      paidGross += gross;
      accPrev = accNow;
      return gross;
    };

    // Window 1: 1h -> minted floor(49603*2375*3600/10000) = 42,410,565.
    const g1 = await claimOnce(3600, genesisMinted(SHARE_STANDARD_DAY2, 3600n));
    assert.equal(g1 > 20_000_000n, true);
    // Window 2: 4h -> minted 169,642,260. THE regression: before the
    // fix this claim computed a phantom pending (~212.0M gross against
    // the true 169.6M) and overpaid the liquid half by ~21.2M out of
    // the rewards vault; against a shallow vault (the Masonry case
    // measured in production testing) the same phantom pending
    // reverts InsufficientRewards instead.
    const g2 = await claimOnce(4 * 3600, genesisMinted(SHARE_STANDARD_DAY2, 14_400n));
    assert.isAbove(Number(g2), 80_000_000);
    // Conservation across both claims: the rewards vault paid out
    // exactly the two liquid halves; the two vested halves are booked
    // on the position (asserted per-claim above) and remain backed by
    // the vault's remaining balance.
    const pos = await posState(userA.publicKey, 1);
    assert.equal(pos.accruedVested, pos.vestingTotal);
    assert.equal(pos.vestingTotal > 0n, true);
  });

  it("LP pool: second compound credits ONLY the second window's rewards", async () => {
    const rewardsVault = await pda([Buffer.from("vault"), Buffer.from("rewards")]);
    const treLpBefore = await bal(lpMint, treasury.publicKey);
    const lpSupplyBefore = await mintSupply(lpMint);
    await rpcRaw(
      program.methods
        .stake(new anchor.BN(2), new anchor.BN(1_000_000_000), false)
        .accounts(await stakeAccounts(userLP.publicKey, 2, lpMint)),
      [userLP]
    );
    // Pro -> 0.5% LP fee goes to the Treasury wallet as POL (Q8, Jess
    // 2026-11-08): treasury LP balance up by exactly the fee, the LP
    // mint supply unchanged (no burn), credited 995,000,000.
    let amount = 995_000_000n;
    assert.equal((await posState(userLP.publicKey, 2)).amount, amount);
    assert.equal((await bal(lpMint, treasury.publicKey)) - treLpBefore, 5_000_000n);
    assert.equal(await mintSupply(lpMint), lpSupplyBefore);
    let accPrev = 0n;
    let cumVested = 0n;

    const compoundOnce = async (secs: number) => {
      await warp(secs);
      await postOracle(1_000_000);
      const cfgBefore = await cfgState();
      const vaultBefore = await vaultBal(rewardsVault);
      const supplyBefore = await mintSupply(xtombMint);
      const treBefore = await bal(xtombMint, treasury.publicKey);
      await rpcRaw(
        program.methods
          .compound(new anchor.BN(2), false)
          .accounts({
            caller: userLP.publicKey,
            owner: userLP.publicKey,
            config: configPda,
            pool: await pda([Buffer.from("pool"), u64le(2)]),
            position: await pda([
              Buffer.from("position"),
              userLP.publicKey.toBuffer(),
              u64le(2),
            ]),
            pass: await pda([Buffer.from("pass"), userLP.publicKey.toBuffer()]),
            rewardsVault,
            treasuryXtomb: await ata(xtombMint, treasury.publicKey),
            xtombMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          }),
        [userLP]
      );
      const minted = genesisMinted(SHARE_LP_DAY2, BigInt(secs));
      const accNow = accAfter(minted, accPrev, amount);
      // Full settle for the window (entitlement delta at the amount
      // that was staked throughout the window).
      const gross = entitled(amount, accNow) - entitled(amount, accPrev);
      // Genesis pools split the settle 50/50: only the liquid half
      // compounds; the vested half stays booked on the position. The
      // compounded net is credited to the position in place — the
      // rewards vault funds the Fire Tax burn and the LP fee, which
      // since Q8 (Jess 2026-11-08) goes to Treasury as POL instead of
      // burning: only the Fire Tax reduces the xTOMB supply.
      const liquid = gross / 2n;
      const fireTax = (liquid * 300n) / 10_000n;
      const lpFee = ((liquid - fireTax) * 50n) / 10_000n;
      const net = liquid - fireTax - lpFee;
      const poolAfter = await poolState(2);
      assert.equal(poolAfter.acc, accNow, "LP accumulator matches mirror");
      const cfgAfter = await cfgState();
      assert.equal(cfgAfter.distributed - cfgBefore.distributed, minted);
      assert.equal(vaultBefore - (await vaultBal(rewardsVault)), fireTax + lpFee);
      assert.equal(supplyBefore - (await mintSupply(xtombMint)), fireTax);
      assert.equal((await bal(xtombMint, treasury.publicKey)) - treBefore, lpFee);
      cumVested += gross - liquid;
      const pos = await posState(userLP.publicKey, 2);
      assert.equal(pos.amount, amount + net, "position grows by net only");
      assert.equal(pos.accruedLiquid, 0n);
      assert.equal(pos.accruedVested, cumVested, "vested halves accumulate exactly");
      amount += net;
      accPrev = accNow;
      return gross;
    };

    const g1 = await compoundOnce(3600);
    assert.isAbove(Number(g1), 100_000_000);
    // Second window is 4x longer. Before the fix, the second settle
    // overstated pending (phantom ~2x on the compounded balance), so
    // the position was over-credited and the burns overcharged.
    const g2 = await compoundOnce(4 * 3600);
    assert.isAbove(Number(g2), Number(g1));
  });

  it("Masonry: three sequential claims each pay exactly one epoch batch", async () => {
    const poolPda = await pda([Buffer.from("pool"), u64le(4)]);
    const masonryVault = await pda([Buffer.from("vault"), Buffer.from("masonry")]);
    // Masonry epochs run post-Genesis (and post-Genesis routing sends
    // the claim Fire Tax to Treasury; inside the Genesis window the
    // same branch would burn it). Warp past Genesis end first.
    const postGenesis = genesisStart + 7 * DAY + 3600;
    if (clockNow < postGenesis) {
      await warp(postGenesis - clockNow);
    }
    // Fund userM with xTOMB out of userA's claimed rewards.
    await transferManual(
      await ata(xtombMint, userA.publicKey),
      await ata(xtombMint, userM.publicKey),
      userA,
      20_000_000
    );
    await rpcRaw(
      program.methods
        .stake(new anchor.BN(4), new anchor.BN(20_000_000), false)
        .accounts(await stakeAccounts(userM.publicKey, 4, xtombMint)),
      [userM]
    );
    assert.equal((await posState(userM.publicKey, 4)).amount, 20_000_000n);
    // Open Epoch 0 (admin trigger sets the epoch clock).
    await rpcRaw(
      program.methods
        .advanceEpoch(true)
        .accounts({
          caller: admin.publicKey,
          config: configPda,
          masonryPool: poolPda,
          xtombMint,
          masonryVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
      [admin]
    );

    // Advance exactly one epoch. The caller manages the clock so
    // that 6-11h have elapsed since the previous epoch: each claim
    // below warps 8h, so advancing immediately after a claim sees
    // exactly one epoch due (advance_epoch would otherwise process
    // up to MAX_EPOCHS_PER_CALL due epochs in a single call).
    const advance = async (twap: number) => {
      await postOracle(twap);
      await rpcRaw(
        program.methods
          .advanceEpoch(false)
          .accounts({
            caller: admin.publicKey,
            config: configPda,
            masonryPool: poolPda,
            xtombMint,
            masonryVault,
            tokenProgram: TOKEN_PROGRAM_ID,
          }),
        [admin]
      );
    };
    const claimMasonry = async (expectedGross: bigint) => {
      await warp(8 * 3600); // cooldown + floor fully decayed to its 3% rest
      await postOracle(1_000_000);
      const userBefore = await bal(xtombMint, userM.publicKey);
      const treBefore = await bal(xtombMint, treasury.publicKey);
      const vaultBefore = await vaultBal(masonryVault);
      const supplyBefore = await mintSupply(xtombMint);
      await rpcRaw(
        program.methods
          .claim(new anchor.BN(4))
          .accounts({
            user: userM.publicKey,
            config: configPda,
            pool: poolPda,
            position: await pda([
              Buffer.from("position"),
              userM.publicKey.toBuffer(),
              u64le(4),
            ]),
            rewardsVault: masonryVault,
            treasuryXtomb: await ata(xtombMint, treasury.publicKey),
            userXtomb: await ata(xtombMint, userM.publicKey),
            xtombMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          }),
        [userM]
      );
      const fee = (expectedGross * 300n) / 10_000n; // 3% Fire Tax at peg
      assert.equal(vaultBefore - (await vaultBal(masonryVault)), expectedGross);
      assert.equal((await bal(xtombMint, userM.publicKey)) - userBefore, expectedGross - fee);
      assert.equal((await bal(xtombMint, treasury.publicKey)) - treBefore, fee);
      assert.equal(await mintSupply(xtombMint), supplyBefore, "no burn post-Genesis");
      assert.equal((await posState(userM.publicKey, 4)).accruedLiquid, 0n);
    };

    // Bootstrap epoch idx 0: mint 3% of 41,000 circulating, half to
    // the Masonry -> 615,000,000, all of it to the sole staker.
    await warp(6 * 3600);
    await advance(1_000_000);
    assert.equal((await cfgState()).circulating, 41_615_000_000n);
    await claimMasonry(615_000_000n);
    // Bootstrap epoch idx 1: 3% of 41,615 -> share 624,225,000. Before
    // the fix this second claim reverted InsufficientRewards
    // (pending computed ~8.0e9 against ~1.24e9 in the vault).
    await advance(1_000_000);
    assert.equal((await cfgState()).circulating, 42_239_225_000n);
    await claimMasonry(624_225_000n);
    // Expansion epoch idx 2 at $1.02: 2% of 42,239.225 -> share
    // 422,392,250.
    await advance(1_020_000);
    assert.equal((await cfgState()).circulating, 42_661_617_250n);
    await claimMasonry(422_392_250n);
    // Conservation: the Masonry vault received exactly the three
    // epoch shares and paid out exactly their sum — nothing remains.
    assert.equal(await vaultBal(masonryVault), 0n);
  });

  it("farm: second harvest pays ONLY the second window's emission", async () => {
    const farmVault = await pda([Buffer.from("vault"), Buffer.from("farm")]);
    const farmStart = genesisStart + 7 * DAY;
    if (clockNow < farmStart + 6 * 3600) {
      await warp(farmStart + 6 * 3600 - clockNow);
    }
    await rpcRaw(
      program.methods
        .stake(new anchor.BN(10), new anchor.BN(1_000_000_000), false)
        .accounts(await stakeAccounts(userF.publicKey, 10, lpMint)),
      [userF]
    );
    assert.equal((await posState(userF.publicKey, 10)).amount, 1_000_000_000n);
    let paidGross = 0n;

    const harvestOnce = async (secs: number) => {
      await warp(secs);
      const userBefore = await bal(xshareMint, userF.publicKey);
      const treBefore = await bal(xshareMint, treasury.publicKey);
      const vaultBefore = await vaultBal(farmVault);
      await rpcRaw(
        program.methods
          .harvest(new anchor.BN(10))
          .accounts({
            user: userF.publicKey,
            config: configPda,
            pool: await pda([Buffer.from("pool"), u64le(10)]),
            position: await pda([
              Buffer.from("position"),
              userF.publicKey.toBuffer(),
              u64le(10),
            ]),
            farmVault,
            treasuryXshare: await ata(xshareMint, treasury.publicKey),
            userXshare: await ata(xshareMint, userF.publicKey),
            tokenProgram: TOKEN_PROGRAM_ID,
          }),
        [userF]
      );
      // Sole staker at 100% weight: pending == the pool's share of
      // the window's emission exactly (acc arithmetic is exact at
      // these magnitudes). Since the weekly-boost build (Jess
      // 2026-11-09: the 5% is baked in), the pool accrues against
      // weight + boostWeight = 10000 + floor(10000*5/95) = 10526;
      // the 5% carve-out stays in the vault in this suite (no boost
      // state is initialized here), so vault conservation below is
      // unchanged in shape.
      const gross = (FARM_RATE * 10000n * BigInt(secs)) / 10526n;
      const fee = (gross * 200n) / 10_000n; // flat 2% claim fee, by design
      assert.equal(vaultBefore - (await vaultBal(farmVault)), gross);
      assert.equal((await bal(xshareMint, userF.publicKey)) - userBefore, gross - fee);
      assert.equal((await bal(xshareMint, treasury.publicKey)) - treBefore, fee);
      assert.equal((await posState(userF.publicKey, 10)).accruedLiquid, 0n);
      paidGross += gross;
      return gross;
    };

    const g1 = await harvestOnce(24 * 3600); // 66,733,041
    assert.equal(g1, 66_733_041n);
    // Before the fix this second harvest reverted
    // InsufficientRewards on a phantom pending in the billions.
    const g2 = await harvestOnce(12 * 3600); // 33,366,520
    assert.equal(g2, 33_366_520n);
    // Conservation: cumulative outflow == cumulative pool emission
    // for the elapsed windows; the vault keeps the rest of the
    // 25,641 budget (including the boost carve-out).
    assert.equal(paidGross, 100_099_561n);
    assert.equal(await vaultBal(farmVault), 25_641_000_000n - paidGross);
  });
});
