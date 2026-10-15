/**
 * Integration tests for Bet Vault v2 + the entry-side surplus fix.
 *
 * Acceptance criteria from the Bet Vault v2 handoff (Alice 70 YES / Bob 30 NO):
 *   - lp_bps = 0      → winner takes exactly the pot, loser 0, 0 USDC left.
 *   - lp_bps = 5000   → no trade: winner 100; outside trader right / wrong →
 *                        winner < 100 / > 100; loser 0; market vault ≈ 0.
 *   - launch / resolve by a stranger → Unauthorized; allowlist enforced;
 *     one-sided vault → launch rejected, refund OK.
 *   - regular deposit_liquidity at 70% and a legacy vault launched at 70% →
 *     after resolution + all claims, the market vault ≈ 0 (nothing stranded).
 *   - swapping without the creator fee account is creator-only.
 *   - a stranger launching a legacy commitment vault doesn't become its
 *     market.authority (can't resolve it).
 *
 * Localnet has no clock-warp, so the lifecycle runs on ONE real timeline:
 * every vault/market is opened in `before`, then the suite waits for the
 * commit window (60 s) and for market expiry (~6 min) once — driven forward by
 * `advanceChainTo` rather than by sleeping, since `anchor test` runs surfpool
 * in per-transaction block production. This file runs last (see Anchor.toml).
 */

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PmAmm } from "../../target/types/pm_amm";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const PROTOCOL_DAO = new PublicKey("4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph");
const COMMIT_SECS = 60;
const MARKET_SECS = 345; // launch needs market_end > now + 300
const ONE = 1_000_000; // 1 USDC (6 dp)
const DUST = 100; // raw units tolerated as rounding dust (0.0001 USDC)
const VOID_GRACE = 300; // MIN_VOID_GRACE_SECS — the resolver's deadline
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u64 = (n: anchor.BN | number) => new anchor.BN(n.toString()).toArrayLike(Buffer, "le", 8);
const pda = (seeds: Buffer[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

type User = { kp: Keypair; usdc: PublicKey };
type Bet = { vault: PublicKey; market?: PublicKey };

describe("bet_vault v2 + entry-side surplus fix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.pmAmm as Program<PmAmm>;
  const conn = provider.connection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = program.methods as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accs = program.account as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payer = (provider.wallet as any).payer as Keypair;
  const pid = program.programId;

  let usdcMint: PublicKey;
  let daoUsdc: PublicKey;
  let alice: User, bob: User, carol: User, mallory: User, dave: User;
  let nextId = Math.floor(Math.random() * 1e9) + 7_000_000_000;
  const bets: Record<string, Bet> = {};
  let commitEnd = 0; // latest commit deadline across every vault
  let marketEnd = 0;
  let lastEnd = 0; // latest expiry across every market in the suite

  // ---------------------------------------------------------------- helpers

  const marketPdas = (market: PublicKey) => {
    const yesMint = pda([Buffer.from("yes_mint"), market.toBuffer()], pid);
    const noMint = pda([Buffer.from("no_mint"), market.toBuffer()], pid);
    const meta = (mint: PublicKey) =>
      pda([Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX);
    return {
      yesMint,
      noMint,
      vault: pda([Buffer.from("vault"), market.toBuffer()], pid),
      yesMetadata: meta(yesMint),
      noMetadata: meta(noMint),
    };
  };
  const lpPda = (market: PublicKey, owner: PublicKey) =>
    pda([Buffer.from("lp"), market.toBuffer(), owner.toBuffer()], pid);
  const betVaultPda = (id: number) => pda([Buffer.from("bet_vault"), u64(id)], pid);
  const betCollateral = (vault: PublicKey) => getAssociatedTokenAddressSync(usdcMint, vault, true);
  const betPosition = (vault: PublicKey, owner: PublicKey) =>
    pda([Buffer.from("bet_position"), vault.toBuffer(), owner.toBuffer()], pid);
  const bal = async (acct: PublicKey) => {
    try {
      return Number((await getAccount(conn, acct)).amount);
    } catch {
      return 0;
    }
  };
  /** Owner's ATA, created if missing. Retries: surfpool mints a block per
   *  transaction, so a freshly created account can lag one RPC read behind. */
  async function ata(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    for (let i = 0; ; i++) {
      try {
        return (
          await getOrCreateAssociatedTokenAccount(conn, payer, mint, owner, true, "confirmed", {
            commitment: "confirmed",
          })
        ).address;
      } catch (e) {
        if (i >= 4) throw e;
        await sleep(400);
      }
    }
  }

  async function mkUser(): Promise<User> {
    const kp = Keypair.generate();
    const sig = await conn.requestAirdrop(kp.publicKey, 20 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    const usdc = await ata(usdcMint, kp.publicKey);
    await mintTo(conn, payer, usdcMint, usdc, payer, 1_000 * ONE);
    return { kp, usdc };
  }

  /** Validator unix time, from the Clock sysvar. */
  async function chainNow(): Promise<number> {
    const info = await conn.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY);
    if (!info) throw new Error("clock sysvar unavailable");
    return Number(info.data.readBigInt64LE(32)); // unix_timestamp
  }

  /**
   * Move the validator clock to `ts`. `anchor test` runs surfpool with
   * `--block-production-mode transaction`: no transaction, no block, no time.
   * So we mint blocks with throwaway transfers (~0.45 s of chain time each)
   * instead of sleeping. On a plain validator the clock advances on its own and
   * the loop exits after one check.
   */
  async function advanceChainTo(ts: number) {
    for (let now = await chainNow(); now < ts; now = await chainNow()) {
      const { blockhash } = await conn.getLatestBlockhash();
      await Promise.all(
        Array.from({ length: 25 }, () => {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: payer.publicKey,
              toPubkey: Keypair.generate().publicKey, // unique → unique signature
              lamports: 1,
            }),
          );
          tx.recentBlockhash = blockhash;
          tx.feePayer = payer.publicKey;
          tx.sign(payer);
          return conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        }),
      );
      await sleep(300);
    }
  }

  async function expectErr(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e) {
      assert.include(String(e), code);
      return;
    }
    assert.fail(`expected ${code}`);
  }

  async function openBet(o: {
    lpBps: number;
    allowlist?: PublicKey[];
    resolver?: PublicKey;
    minTotal?: number;
    voidGraceSecs?: number;
  }) {
    const id = nextId++;
    const vault = betVaultPda(id);
    await m
      .initializeBetVault(
        new anchor.BN(id),
        `Bet ${id}`,
        new anchor.BN(COMMIT_SECS),
        new anchor.BN(MARKET_SECS),
        new anchor.BN(o.minTotal ?? ONE),
        o.lpBps,
        o.resolver ?? PublicKey.default,
        o.allowlist ?? [],
        new anchor.BN(o.voidGraceSecs ?? 0),
      )
      .accountsPartial({
        authority: alice.kp.publicKey,
        betVault: vault,
        collateralMint: usdcMint,
        vaultCollateral: betCollateral(vault),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([alice.kp])
      .rpc();
    return vault;
  }

  const commit = (u: User, vault: PublicKey, side: "yes" | "no", usd: number) =>
    m
      .betCommit({ [side]: {} }, new anchor.BN(usd * ONE))
      .accountsPartial({
        signer: u.kp.publicKey,
        betVault: vault,
        vaultCollateral: betCollateral(vault),
        userCollateral: u.usdc,
        position: betPosition(vault, u.kp.publicKey),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([u.kp])
      .rpc();

  async function launch(u: User, vault: PublicKey): Promise<PublicKey> {
    const id = nextId++;
    const market = pda([Buffer.from("market"), u64(id)], pid);
    const p = marketPdas(market);
    await m
      .launchBetVault(new anchor.BN(id))
      .accountsPartial({
        payer: u.kp.publicKey,
        betVault: vault,
        market,
        collateralMint: usdcMint,
        yesMint: p.yesMint,
        noMint: p.noMint,
        marketVault: p.vault,
        vaultCollateral: betCollateral(vault),
        vaultLpPosition: lpPda(market, vault),
        yesMetadata: p.yesMetadata,
        noMetadata: p.noMetadata,
        tokenMetadataProgram: METAPLEX,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([CU])
      .signers([u.kp])
      .rpc();
    return market;
  }

  /** Buy `side` with `usd` on `market`; creator fee to `creatorUsdc` (null = swapper is creator). */
  async function buy(
    u: User,
    market: PublicKey,
    side: "yes" | "no",
    usd: number,
    creatorUsdc: PublicKey | null,
  ) {
    const p = marketPdas(market);
    const dir = side === "yes" ? { usdcToYes: {} } : { usdcToNo: {} };
    await m
      .swap(dir, new anchor.BN(usd * ONE), new anchor.BN(0))
      .accountsPartial({
        signer: u.kp.publicKey,
        market,
        collateralMint: usdcMint,
        yesMint: p.yesMint,
        noMint: p.noMint,
        vault: p.vault,
        userCollateral: u.usdc,
        userYes: await ata(p.yesMint, u.kp.publicKey),
        userNo: await ata(p.noMint, u.kp.publicKey),
        daoUsdc,
        creatorUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([CU])
      .signers([u.kp])
      .rpc();
  }

  const resolveBet = (u: User, bet: Bet, side: "yes" | "no") =>
    m
      .resolveBetVault({ [side]: {} })
      .accountsPartial({ resolver: u.kp.publicKey, betVault: bet.vault, market: bet.market })
      .signers([u.kp])
      .rpc();

  const voidVault = (bet: Bet) =>
    m
      .voidBetVault()
      .accountsPartial({
        signer: provider.wallet.publicKey,
        betVault: bet.vault,
        market: bet.market,
        marketVault: marketPdas(bet.market!).vault,
        vaultCollateral: betCollateral(bet.vault),
        vaultLpPosition: lpPda(bet.market!, bet.vault),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([CU])
      .rpc();

  const settle = (bet: Bet) =>
    m
      .settleBetVault()
      .accountsPartial({
        signer: provider.wallet.publicKey,
        betVault: bet.vault,
        market: bet.market,
        marketVault: marketPdas(bet.market!).vault,
        vaultCollateral: betCollateral(bet.vault),
        vaultLpPosition: lpPda(bet.market!, bet.vault),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([CU])
      .rpc();

  /** claim_bet (or refund_bet) and return the USDC received. */
  async function claimBet(u: User, vault: PublicKey, ix: "claimBet" | "refundBet" = "claimBet") {
    const before = await bal(u.usdc);
    await m[ix]()
      .accountsPartial({
        signer: u.kp.publicKey,
        betVault: vault,
        vaultCollateral: betCollateral(vault),
        userCollateral: u.usdc,
        position: betPosition(vault, u.kp.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([u.kp])
      .rpc();
    return (await bal(u.usdc)) - before;
  }

  /** Redeem everything `owner` holds on a resolved market; returns USDC received. */
  async function claimWinnings(u: { kp: Keypair; usdc: PublicKey }, market: PublicKey) {
    const p = marketPdas(market);
    const userYes = await ata(p.yesMint, u.kp.publicKey);
    const userNo = await ata(p.noMint, u.kp.publicKey);
    if ((await bal(userYes)) + (await bal(userNo)) === 0) return 0;
    const before = await bal(u.usdc);
    await m
      .claimWinnings(new anchor.BN(0))
      .accountsPartial({
        signer: u.kp.publicKey,
        market,
        collateralMint: usdcMint,
        yesMint: p.yesMint,
        noMint: p.noMint,
        vault: p.vault,
        userYes,
        userNo,
        userCollateral: u.usdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([u.kp])
      .rpc();
    return (await bal(u.usdc)) - before;
  }

  const deposit = (u: User, market: PublicKey, usd: number) =>
    m
      .depositLiquidity(new anchor.BN(usd * ONE))
      .accountsPartial({
        signer: u.kp.publicKey,
        market,
        collateralMint: usdcMint,
        vault: marketPdas(market).vault,
        userCollateral: u.usdc,
        lpPosition: lpPda(market, u.kp.publicKey),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([CU])
      .signers([u.kp])
      .rpc();

  const claimResiduals = async (u: { kp: Keypair }, market: PublicKey) => {
    const p = marketPdas(market);
    await m
      .claimLpResiduals()
      .accountsPartial({
        signer: u.kp.publicKey,
        market,
        yesMint: p.yesMint,
        noMint: p.noMint,
        lpPosition: lpPda(market, u.kp.publicKey),
        userYes: await ata(p.yesMint, u.kp.publicKey),
        userNo: await ata(p.noMint, u.kp.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([CU])
      .signers([u.kp])
      .rpc();
  };

  const approx = (got: number, wantUsd: number, tolUsd: number, what: string) =>
    assert.approximately(got / ONE, wantUsd, tolUsd, `${what}: got ${got / ONE}`);

  // ------------------------------------------------- regular market at 70%

  const legacy: { market?: PublicKey; vault?: PublicKey; vaultMarket?: PublicKey } = {};
  const owner = { kp: payer, usdc: PublicKey.default };

  async function openRegularMarketAt70() {
    const id = nextId++;
    const market = pda([Buffer.from("market"), u64(id)], pid);
    const p = marketPdas(market);
    owner.usdc = await ata(usdcMint, payer.publicKey);
    await mintTo(conn, payer, usdcMint, owner.usdc, payer, 1_000 * ONE);
    await m
      .initializeMarket(new anchor.BN(id), new anchor.BN(marketEnd), "Regular 70%", 7000)
      .accountsPartial({
        authority: payer.publicKey,
        market,
        collateralMint: usdcMint,
        yesMint: p.yesMint,
        noMint: p.noMint,
        vault: p.vault,
        yesMetadata: p.yesMetadata,
        noMetadata: p.noMetadata,
        tokenMetadataProgram: METAPLEX,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    await m
      .depositLiquidity(new anchor.BN(100 * ONE))
      .accountsPartial({
        signer: payer.publicKey,
        market,
        collateralMint: usdcMint,
        vault: p.vault,
        userCollateral: owner.usdc,
        lpPosition: lpPda(market, payer.publicKey),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([CU])
      .rpc();
    legacy.market = market;
  }

  // ------------------------------------------ legacy commitment vault at 70%

  const legacyVaultPda = (id: number) => pda([Buffer.from("vault"), u64(id)], pid);
  const legacyCollateral = (v: PublicKey) =>
    pda([Buffer.from("vault_collateral"), v.toBuffer()], pid);
  const commitPda = (v: PublicKey, o: PublicKey) =>
    pda([Buffer.from("commit"), v.toBuffer(), o.toBuffer()], pid);

  async function openLegacyVaultAt70() {
    const id = nextId++;
    const vault = legacyVaultPda(id);
    await m
      .initializeVault(
        new anchor.BN(id),
        "Legacy 70%",
        new anchor.BN(COMMIT_SECS),
        new anchor.BN(MARKET_SECS),
        new anchor.BN(ONE),
      )
      .accountsPartial({
        authority: payer.publicKey,
        vault,
        collateralMint: usdcMint,
        vaultCollateral: legacyCollateral(vault),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    for (const [u, side, usd] of [
      [alice, "yes", 70],
      [bob, "no", 30],
    ] as const) {
      await m
        .vaultCommit({ [side]: {} }, new anchor.BN(usd * ONE))
        .accountsPartial({
          signer: u.kp.publicKey,
          vault,
          collateralMint: usdcMint,
          vaultCollateral: legacyCollateral(vault),
          userCollateral: u.usdc,
          commitPosition: commitPda(vault, u.kp.publicKey),
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([u.kp])
        .rpc();
    }
    legacy.vault = vault;
  }

  async function launchAndClaimLegacy(launcher: Keypair) {
    const id = nextId++;
    const market = pda([Buffer.from("market"), u64(id)], pid);
    const p = marketPdas(market);
    await m
      .launchVaultMarket(new anchor.BN(id))
      .accountsPartial({
        payer: launcher.publicKey,
        vault: legacy.vault,
        market,
        collateralMint: usdcMint,
        yesMint: p.yesMint,
        noMint: p.noMint,
        marketVault: p.vault,
        vaultCollateral: legacyCollateral(legacy.vault!),
        yesMetadata: p.yesMetadata,
        noMetadata: p.noMetadata,
        tokenMetadataProgram: METAPLEX,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([CU])
      .signers([launcher])
      .rpc();
    for (const u of [alice, bob]) {
      await m
        .claimCommitter()
        .accountsPartial({
          signer: u.kp.publicKey,
          vault: legacy.vault,
          market,
          commitPosition: commitPda(legacy.vault!, u.kp.publicKey),
          lpPosition: lpPda(market, u.kp.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([u.kp])
        .rpc();
    }
    legacy.vaultMarket = market;
    lastEnd = Math.max(lastEnd, (await accs.market.fetch(market)).endTs.toNumber());
  }

  // ------------------------------------------------------------------ setup

  before(async () => {
    usdcMint = await createMint(conn, payer, payer.publicKey, null, 6);
    daoUsdc = await ata(usdcMint, PROTOCOL_DAO);
    [alice, bob, carol, mallory, dave] = await Promise.all([
      mkUser(),
      mkUser(),
      mkUser(),
      mkUser(),
      mkUser(),
    ]);

    // A: lp 0 (pure bet) — B: lp 50%, no trade — C: lp 50%, Carol right —
    // D: lp 50%, Carol wrong — E: one-sided (refund path) — F: two bettors on
    // the winning side (pro-rata + dust) — G: below min_total (refund path) —
    // I: like D, plus Mallory's deposit + withdraw round-trip (LP dilution).
    for (const [k, lpBps] of [
      ["A", 0],
      ["B", 5000],
      ["C", 5000],
      ["D", 5000],
      ["E", 5000],
      ["F", 5000],
      ["I", 5000],
    ] as const) {
      bets[k] = { vault: await openBet({ lpBps }) };
    }
    bets.G = { vault: await openBet({ lpBps: 5000, minTotal: 100 * ONE }) };
    // H: launched but never resolved — the void fallback (short grace so the
    // suite can reach it).
    bets.H = { vault: await openBet({ lpBps: 5000, voidGraceSecs: VOID_GRACE }) };
    for (const k of ["A", "B", "C", "D", "I"]) {
      await commit(alice, bets[k].vault, "yes", 70);
      await commit(bob, bets[k].vault, "no", 30);
    }
    await commit(alice, bets.E.vault, "yes", 50);
    // F: 40 + 30 on YES against 30 on NO — an odd pot (100) over an odd winning
    // side (70), so the pro-rata split leaves dust for the last claim to sweep.
    await commit(alice, bets.F.vault, "yes", 40);
    await commit(dave, bets.F.vault, "yes", 30);
    await commit(bob, bets.F.vault, "no", 30);
    await commit(alice, bets.G.vault, "yes", 2); // below min_total = 100
    await commit(alice, bets.H.vault, "yes", 70);
    await commit(bob, bets.H.vault, "no", 30);
    marketEnd = (await accs.betVault.fetch(bets.A.vault)).marketEndTs.toNumber();
    commitEnd = (await accs.betVault.fetch(bets.G.vault)).commitEndTs.toNumber();
    lastEnd = (await accs.betVault.fetch(bets.D.vault)).marketEndTs.toNumber();

    await openRegularMarketAt70();
    await openLegacyVaultAt70();
    const legacyV = await accs.commitmentVault.fetch(legacy.vault!);
    commitEnd = Math.max(commitEnd, legacyV.commitEndTs.toNumber());
  });

  // ------------------------------------------------------ pre-launch checks

  it("initialize_bet_vault rejects lp_bps > 10_000 and an allowlist > 8", async () => {
    await expectErr(openBet({ lpBps: 10_001 }), "InvalidLpBps");
    const nine = Array.from({ length: 9 }, () => Keypair.generate().publicKey);
    await expectErr(openBet({ lpBps: 0, allowlist: nine }), "AllowlistTooLong");
  });

  it("allowlist: only listed keys can commit (1v1)", async () => {
    const vault = await openBet({ lpBps: 5000, allowlist: [alice.kp.publicKey, bob.kp.publicKey] });
    await commit(alice, vault, "yes", 1);
    await expectErr(commit(carol, vault, "no", 1), "NotOnAllowlist");
  });

  it("regular deposit at 70% credits the entry-side surplus to the LP", async () => {
    const lp = await accs.lpPosition.fetch(lpPda(legacy.market!, payer.publicKey));
    const mk = await accs.market.fetch(legacy.market!);
    approx(lp.excessYes.toNumber(), 73.37, 0.05, "excess YES");
    assert.isAtMost(lp.excessNo.toNumber(), 1, "NO is the calibrated side");
    assert.equal(mk.unclaimedExcessYes.toString(), lp.excessYes.toString());
  });

  it("a follow-up deposit at 70% credits its own surplus (second LP)", async () => {
    const mk0 = await accs.market.fetch(legacy.market!);
    await deposit(carol, legacy.market!, 50);
    const lp = await accs.lpPosition.fetch(lpPda(legacy.market!, carol.kp.publicKey));
    const mk1 = await accs.market.fetch(legacy.market!);
    // Half the first deposit at the same price → about half its surplus, and
    // the market counter is the sum of both LPs' claims.
    approx(lp.excessYes.toNumber(), 36.68, 0.3, "2nd LP excess YES");
    assert.isAtMost(lp.excessNo.toNumber(), 1);
    assert.equal(
      mk1.unclaimedExcessYes.toNumber() - mk0.unclaimedExcessYes.toNumber(),
      lp.excessYes.toNumber(),
    );
  });

  it("swap without the creator fee account is creator-only", async () => {
    await expectErr(buy(carol, legacy.market!, "yes", 1, null), "Unauthorized");
  });

  // ---------------------------------------------------------------- launch

  it("launch: a stranger can't launch; authority launches at the stake odds", async () => {
    await advanceChainTo(commitEnd + 1);
    await expectErr(launch(mallory, bets.B.vault), "Unauthorized");
    for (const k of ["A", "B", "C", "D", "F", "H", "I"])
      bets[k].market = await launch(alice, bets[k].vault);

    const b = await accs.betVault.fetch(bets.B.vault);
    const mk = await accs.market.fetch(bets.B.market!);
    assert.equal(b.priceBps, 7000);
    assert.equal(b.effectiveLpBps, 5000);
    assert.ok(mk.authority.equals(bets.B.vault), "vault PDA is market.authority");
    assert.equal(await bal(betCollateral(bets.B.vault)), 50 * ONE, "half kept in the vault");
    assert.equal(await bal(marketPdas(bets.B.market!).vault), 50 * ONE, "half as liquidity");
    assert.equal(await bal(marketPdas(bets.A.market!).vault), 0, "lp 0 → no liquidity");
  });

  it("below min_total: launch rejected, every committer refunded 1:1", async () => {
    await expectErr(launch(alice, bets.G.vault), "VaultBelowMinTotal");
    assert.equal(await claimBet(alice, bets.G.vault, "refundBet"), 2 * ONE);
    assert.equal(await bal(betCollateral(bets.G.vault)), 0, "vault emptied");
  });

  it("one-sided vault: launch rejected, refund returns the stake 1:1", async () => {
    await expectErr(launch(alice, bets.E.vault), "BetVaultInvalidOdds");
    assert.equal(await claimBet(alice, bets.E.vault, "refundBet"), 50 * ONE);
  });

  it("Carol trades against the pot; the creator fee lands in the pot", async () => {
    const before = await bal(betCollateral(bets.C.vault));
    await buy(carol, bets.C.market!, "yes", 20, betCollateral(bets.C.vault));
    await buy(carol, bets.D.market!, "yes", 20, betCollateral(bets.D.vault));
    assert.equal((await bal(betCollateral(bets.C.vault))) - before, 0.2 * ONE, "1% creator fee");
  });

  it("legacy vault: a stranger may launch, but the vault creator stays market.authority", async () => {
    // launch_vault_market is permissionless: Mallory pays the rent, but must
    // not become the market's resolver / fee recipient.
    await launchAndClaimLegacy(mallory.kp);
    const mk = await accs.market.fetch(legacy.vaultMarket!);
    assert.ok(mk.authority.equals(payer.publicKey), "vault creator is market.authority");
  });

  it("LP dilution: a deposit + immediate withdraw can't skim the pot", async () => {
    // After Carol's buy the pool holds more NO than the vault's shares were
    // minted for. With shares minted 1:1 per USDC, Mallory's round-trip got a
    // pro-rata slice of that NO pile on top of her own surplus: ~+2 free pairs
    // and ~+16 free NO, taken from the pot. Shares ∝ the L_0 she adds → none.
    const market = bets.I.market!;
    const p = marketPdas(market);
    await buy(carol, market, "yes", 20, betCollateral(bets.I.vault));
    const usd = 900;
    await deposit(mallory, market, usd);
    const lp = await accs.lpPosition.fetch(lpPda(market, mallory.kp.publicKey));
    const userYes = await ata(p.yesMint, mallory.kp.publicKey);
    const userNo = await ata(p.noMint, mallory.kp.publicKey);
    await m
      .withdrawLiquidity(lp.shares)
      .accountsPartial({
        signer: mallory.kp.publicKey,
        market,
        collateralMint: usdcMint,
        yesMint: p.yesMint,
        noMint: p.noMint,
        lpPosition: lpPda(market, mallory.kp.publicKey),
        userYes,
        userNo,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([CU])
      .signers([mallory.kp])
      .rpc();
    const [yes, no] = [await bal(userYes), await bal(userNo)];
    // She gets back what she put in — `usd` of each side — and not a lamport more.
    assert.isAtMost(yes, usd * ONE, `YES back: ${yes / ONE}`);
    assert.isAtMost(no, usd * ONE, `NO back: ${no / ONE}`);
    approx(yes, usd, 0.01, "YES back");
    approx(no, usd, 0.01, "NO back");
  });

  // ------------------------------------------------------ resolve & settle

  it("resolution: stranger rejected, resolver resolves", async () => {
    await advanceChainTo(lastEnd + 1);
    await expectErr(resolveBet(mallory, bets.A, "yes"), "Unauthorized");
    for (const k of ["A", "B", "C", "F"]) await resolveBet(alice, bets[k], "yes");
    await resolveBet(alice, bets.D, "no");
    await resolveBet(alice, bets.I, "no");
    // Mallory launched the legacy vault market but can't resolve it.
    await expectErr(
      m
        .resolveMarket({ no: {} })
        .accountsPartial({ signer: mallory.kp.publicKey, market: legacy.vaultMarket! })
        .signers([mallory.kp])
        .rpc(),
      "Unauthorized",
    );
    for (const market of [legacy.market!, legacy.vaultMarket!]) {
      await m.resolveMarket({ yes: {} }).accountsPartial({ signer: payer.publicKey, market }).rpc();
    }
    for (const k of ["A", "B", "C", "D", "F", "I"]) await settle(bets[k]);
    await expectErr(settle(bets.A), "BetVaultAlreadySettled");
  });

  it("lp 0: Alice takes the whole pot, Bob 0, nothing left", async () => {
    assert.equal(await claimBet(alice, bets.A.vault), 100 * ONE);
    assert.equal(await claimBet(bob, bets.A.vault), 0);
    assert.equal(await bal(betCollateral(bets.A.vault)), 0);
  });

  it("lp 50%, no trade: Alice ≈ 100, Bob 0, market + vault ≈ 0", async () => {
    approx(await claimBet(alice, bets.B.vault), 100, 0.01, "Alice");
    assert.equal(await claimBet(bob, bets.B.vault), 0);
    assert.isAtMost(await bal(betCollateral(bets.B.vault)), DUST);
    assert.isAtMost(await bal(marketPdas(bets.B.market!).vault), DUST, "no stranded collateral");
  });

  it("lp 50%, Carol right: Alice < 100 (≈ 94), Carol paid, market ≈ 0", async () => {
    const a = await claimBet(alice, bets.C.vault);
    approx(a, 94.0, 0.5, "Alice");
    assert.isBelow(a, 100 * ONE);
    assert.equal(await claimBet(bob, bets.C.vault), 0);
    assert.isAbove(await claimWinnings(carol, bets.C.market!), 20 * ONE, "Carol wins");
    assert.isAtMost(await bal(marketPdas(bets.C.market!).vault), DUST);
  });

  it("lp 50%, Carol wrong: Bob > 100 (≈ 119.8), Alice 0, market ≈ 0", async () => {
    const b = await claimBet(bob, bets.D.vault);
    approx(b, 119.8, 0.5, "Bob");
    assert.equal(await claimBet(alice, bets.D.vault), 0);
    assert.equal(await claimWinnings(carol, bets.D.market!), 0, "Carol's YES is worthless");
    assert.isAtMost(await bal(marketPdas(bets.D.market!).vault), DUST);
  });

  it("after Mallory's round-trip, Bob's pot is intact (≈ 119.8, same as D)", async () => {
    approx(await claimBet(bob, bets.I.vault), 119.8, 0.5, "Bob");
    assert.equal(await claimBet(alice, bets.I.vault), 0);
    approx(await claimWinnings(mallory, bets.I.market!), 900, 0.01, "Mallory: her 900 NO");
    assert.equal(await claimWinnings(carol, bets.I.market!), 0, "Carol's YES is worthless");
    assert.isAtMost(await bal(marketPdas(bets.I.market!).vault), DUST);
  });

  it("void is refused while the resolver still has time", async () => {
    await expectErr(voidVault(bets.H), "VoidTooEarly");
  });

  it("void after the grace period: every stake is refunded, nothing left", async () => {
    await advanceChainTo(lastEnd + VOID_GRACE + 2);
    await voidVault(bets.H);
    const v = await accs.betVault.fetch(bets.H.vault);
    assert.equal(v.voided, true);
    approx(v.payoutPool.toNumber(), 100, 0.01, "refund pool");
    // No winner, no loser: both sides get their stake back.
    approx(await claimBet(alice, bets.H.vault), 70, 0.01, "Alice");
    approx(await claimBet(bob, bets.H.vault), 30, 0.01, "Bob");
    assert.equal(await bal(betCollateral(bets.H.vault)), 0, "bet vault emptied");
    assert.isAtMost(await bal(marketPdas(bets.H.market!).vault), DUST, "market emptied");
  });

  it("two bettors on the winning side split it pro-rata, last claim sweeps dust", async () => {
    const pool = (await accs.betVault.fetch(bets.F.vault)).payoutPool.toNumber();
    const a = await claimBet(alice, bets.F.vault); // 40 of the 70 winning stake
    const d = await claimBet(dave, bets.F.vault); // 30 of it
    assert.equal(await claimBet(bob, bets.F.vault), 0, "losing side");
    approx(a, (pool * 4) / 7 / ONE, 0.01, "Alice 4/7");
    approx(d, (pool * 3) / 7 / ONE, 0.01, "Dave 3/7");
    assert.equal(a + d, pool, "the pool is fully distributed (dust swept)");
    assert.equal(await bal(betCollateral(bets.F.vault)), 0, "nothing left");
  });

  it("regular deposits at 70%: both LPs recover their stake, market ≈ 0", async () => {
    await claimResiduals(owner, legacy.market!);
    const first = await claimWinnings(owner, legacy.market!);
    await claimResiduals(carol, legacy.market!);
    const second = await claimWinnings(carol, legacy.market!);
    // 150 deposited, 150 paid out: nothing is created or stranded. Shares are
    // minted ∝ the L_0 each deposit adds, so each LP gets their own deposit
    // back to the rounding dust (flooring keeps it in the vault, never over).
    assert.isAtMost(first + second, 150 * ONE, "never more than deposited");
    assert.isAtMost(Math.abs(first - 100 * ONE), DUST, `first LP: ${first / ONE}`);
    assert.isAtMost(Math.abs(second - 50 * ONE), DUST, `second LP: ${second / ONE}`);
    assert.isAtMost(await bal(marketPdas(legacy.market!).vault), DUST);
  });

  it("legacy vault at 70%: committers recover the pot, market vault ≈ 0", async () => {
    let total = 0;
    for (const u of [alice, bob]) {
      await claimResiduals(u, legacy.vaultMarket!);
      total += await claimWinnings(u, legacy.vaultMarket!);
    }
    approx(total, 100, 0.01, "committers");
    assert.isAtMost(await bal(marketPdas(legacy.vaultMarket!).vault), DUST);
  });
});
