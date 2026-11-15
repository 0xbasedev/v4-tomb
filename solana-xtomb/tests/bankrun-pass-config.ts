// xTOMB bankrun tests: pass prices and per-tier deposit fees are
// CONFIG fields, not hardcoded constants (Jess's standing
// configurability rule, 2026-11-08).
//
// The Config account's pass fields were tail-appended into its
// spare capacity; a stored 0 resolves to the compiled defaults
// (prices 50 / 100 / 300 USDC, deposit fees 200 / 100 / 0 bps).
// These tests prove, end to end:
//   1. Before any setter call the compiled defaults govern buys
//      and the standard-pool deposit fee.
//   2. set_pass_config reprices buys, reprices upgrade deltas (they
//      derive from the stored table), and retunes the deposit fees
//      — including a nonzero Ultra fee, which the old hardcoded
//      table could never express.
//   3. The setter validates (price > 0, fee <= 1000 bps) and is
//      admin-only.
//   4. Restoring the default table through the setter reprices
//      upgrades back.
// All assertions are exact balance / position deltas.
//
// Run:  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/bankrun-pass-config.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { startAnchor } from "solana-bankrun";
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
const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

describe("xtomb pass-config (bankrun)", () => {
  let provider: BankrunProvider;
  let program: Program<Xtomb>;
  let context: Awaited<ReturnType<typeof startAnchor>>;

  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  const team = Keypair.generate();
  const dev = Keypair.generate();
  const bot = Keypair.generate();
  const oracle = Keypair.generate();
  const userG = Keypair.generate(); // buys Genesis at the default price
  const userP = Keypair.generate(); // buys Pro at the retuned price
  const userU = Keypair.generate(); // buys Ultra at the retuned price

  let usdcMint: PublicKey;
  let configPda: PublicKey;

  async function pda(seeds: (Buffer | Uint8Array)[]) {
    return PublicKey.findProgramAddressSync(
      seeds.map((s) => Buffer.from(s)),
      program.programId
    )[0];
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

  async function treasuryUsdc(): Promise<bigint> {
    return bal(usdcMint, treasury.publicKey);
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

  async function buyPass(user: Keypair, tier: number) {
    const assetKp = Keypair.generate();
    await rpcRaw(
      program.methods.buyPass(tier).accounts({
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
  }

  async function upgradePass(user: Keypair, newTier: number) {
    await rpcRaw(
      program.methods.upgradePass(newTier).accounts({
        buyer: user.publicKey,
        config: configPda,
        pass: await pda([Buffer.from("pass"), user.publicKey.toBuffer()]),
        buyerUsdc: await ata(usdcMint, user.publicKey),
        treasuryUsdc: await ata(usdcMint, treasury.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      [user]
    );
  }

  async function stakeStandard(user: Keypair, amount: number) {
    await rpcRaw(
      program.methods
        .stake(new anchor.BN(1), new anchor.BN(amount), false)
        .accounts({
          user: user.publicKey,
          config: configPda,
          pool: await pda([Buffer.from("pool"), u64le(1)]),
          position: await pda([
            Buffer.from("position"),
            user.publicKey.toBuffer(),
            u64le(1),
          ]),
          pass: await pda([Buffer.from("pass"), user.publicKey.toBuffer()]),
          userToken: await ata(usdcMint, user.publicKey),
          vault: await pda([Buffer.from("pool-vault"), u64le(1)]),
          treasuryToken: await ata(usdcMint, treasury.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }),
      [user]
    );
    const pos = await program.account.position.fetch(
      await pda([Buffer.from("position"), user.publicKey.toBuffer(), u64le(1)])
    );
    return BigInt(pos.amount.toString());
  }

  async function setPassConfig(
    signer: Keypair,
    prices: [number, number, number],
    fees: [number, number, number]
  ) {
    await rpcRaw(
      program.methods
        .setPassConfig(
          new anchor.BN(prices[0]),
          new anchor.BN(prices[1]),
          new anchor.BN(prices[2]),
          fees[0],
          fees[1],
          fees[2]
        )
        .accounts({ admin: signer.publicKey, config: configPda }),
      [signer]
    );
  }

  async function storedPassConfig() {
    const cfg = await program.account.config.fetch(configPda);
    return {
      prices: [
        cfg.passPriceGenesisUsdc.toNumber(),
        cfg.passPriceProUsdc.toNumber(),
        cfg.passPriceUltraUsdc.toNumber(),
      ],
      fees: [
        cfg.passDepositFeeGenesisBps,
        cfg.passDepositFeeProBps,
        cfg.passDepositFeeUltraBps,
      ],
    };
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
    const genesisStart = Number(clock.unixTimestamp) - 3600; // 1h into Genesis

    for (const kp of [admin, treasury, team, dev, bot, oracle, userG, userP, userU]) {
      await fund(kp.publicKey, 10);
    }
    usdcMint = await createMintManual(6);
    for (const u of [userG, userP, userU]) {
      await mintToManual(usdcMint, await ata(usdcMint, u.publicKey), 100_000_000_000);
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
    const vault = (name: string) => pda([Buffer.from("vault"), Buffer.from(name)]);
    await rpcRaw(
      program.methods.createMints().accounts({
        admin: admin.publicKey,
        config: configPda,
        xtombMint: xtombKp.publicKey,
        xshareMint: xshareKp.publicKey,
        xbondMint: xbondKp.publicKey,
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

    await rpcRaw(
      program.methods
        .addPool(new anchor.BN(1), 0, usdcMint, 0)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          pool: await pda([Buffer.from("pool"), u64le(1)]),
          vault: await pda([Buffer.from("pool-vault"), u64le(1)]),
          assetMintAccount: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        }),
      [admin]
    );
  });

  it("compiled defaults govern before any setter call (50 USDC buy, 2% fee)", async () => {
    // Fresh config: the appended pass fields are all zero (unset).
    assert.deepEqual(await storedPassConfig(), {
      prices: [0, 0, 0],
      fees: [0, 0, 0],
    });
    await buyPass(userG, 1);
    assert.equal(await treasuryUsdc(), 50_000_000n);
    const credited = await stakeStandard(userG, 1_000_000_000);
    assert.equal(credited, 980_000_000n); // 2% default Genesis fee
    assert.equal(await treasuryUsdc(), 70_000_000n);
  });

  it("set_pass_config reprices buys and upgrades and retunes deposit fees", async () => {
    await setPassConfig(admin, [60, 120, 360], [300, 150, 25]);
    assert.deepEqual(await storedPassConfig(), {
      prices: [60, 120, 360],
      fees: [300, 150, 25],
    });
    await buyPass(userP, 2); // Pro at the retuned $120
    assert.equal(await treasuryUsdc(), 190_000_000n);
    await upgradePass(userG, 2); // Genesis -> Pro costs 120 - 60 = $60
    assert.equal(await treasuryUsdc(), 250_000_000n);
    const creditedP = await stakeStandard(userP, 1_000_000_000);
    assert.equal(creditedP, 985_000_000n); // retuned Pro fee 1.5%
    assert.equal(await treasuryUsdc(), 265_000_000n);
    await buyPass(userU, 3); // Ultra at the retuned $360
    assert.equal(await treasuryUsdc(), 625_000_000n);
    const creditedU = await stakeStandard(userU, 1_000_000_000);
    assert.equal(creditedU, 997_500_000n); // retuned Ultra fee 0.25%
    assert.equal(await treasuryUsdc(), 627_500_000n);
  });

  it("set_pass_config validates prices > 0 and fees <= 1000 bps", async () => {
    for (const [prices, fees] of [
      [
        [0, 120, 360],
        [300, 150, 25],
      ],
      [
        [60, 120, 360],
        [1001, 150, 25],
      ],
      [
        [60, 120, 360],
        [300, 150, 1001],
      ],
    ] as const) {
      try {
        await setPassConfig(
          admin,
          prices as unknown as [number, number, number],
          fees as unknown as [number, number, number]
        );
        assert.fail("expected BadPassConfig");
      } catch (e: any) {
        assert.include(e.toString(), "BadPassConfig");
      }
    }
    // Rejected calls wrote nothing.
    assert.deepEqual(await storedPassConfig(), {
      prices: [60, 120, 360],
      fees: [300, 150, 25],
    });
  });

  it("non-admin cannot call set_pass_config", async () => {
    try {
      await setPassConfig(userG, [1, 1, 1], [0, 0, 0]);
      assert.fail("expected admin check failure");
    } catch (e) {
      assert.isTrue(true);
    }
    assert.deepEqual(await storedPassConfig(), {
      prices: [60, 120, 360],
      fees: [300, 150, 25],
    });
  });

  it("restoring the default table reprices upgrades back (Pro -> Ultra $200)", async () => {
    await setPassConfig(admin, [50, 100, 300], [200, 100, 0]);
    assert.deepEqual(await storedPassConfig(), {
      prices: [50, 100, 300],
      fees: [200, 100, 0],
    });
    await upgradePass(userP, 3); // 300 - 100 = $200 at the restored table
    assert.equal(await treasuryUsdc(), 827_500_000n);
  });
});
