# Mainnet-beta deployment guide

This is a **trust-based POC going live with real money**. The following risks are
**knowingly accepted** by the operator (they are NOT fixed):

1. **Centralized resolution** — whoever holds resolution authority picks the
   winning side and can drain via `claim_winnings`. No oracle, no timelock, no
   dispute, no permissionless fallback (audit findings #2/#3).
2. **Single-key upgrade authority** — that key can replace the program and drain
   every vault. No multisig.
3. **No third-party security audit.**
4. **Multi-outcome Σ pᵢ = 1** is only enforced at seed and at resolution; between
   trades it is left to arbitrage.

The program itself is **collateral-agnostic** (it never mints USDC, only the
program-owned YES/NO tokens), so moving to real USDC needs **no on-chain code
change** — only configuration + a deploy.

## ✅ Current mainnet deployment (LIVE)

| | |
|---|---|
| Program ID | `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` |
| Upgrade authority | `2TBg1fasPKnBczbtJpvD6LmEUxNnCoigTDQHB3VnUpv7` (dedicated mainnet key) |
| Collateral | real USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Protocol DAO (50% of the swap fee) | `4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph` (since the Sprint 25 upgrade; was `HKLj…3ZeL`) |
| Program data | 1,550,000 bytes (first deploy `--max-len 1400000`, extended +150,000 on 2026-09-23) |
| On-chain IDL | deferred (optional — `anchor idl` lacks priority fees, congestion-blocked) |

### Upgrade log

| Date | Change | Slot / tx |
|---|---|---|
| 2026-09-23 | Sprint 25 (`sparkfun-labs/pm-amm#1`): entry-side surplus fix, Bet Vault v2, swap creator-fee fix, LP shares ∝ L_0, new protocol DAO. `.so` SHA-256 `5106fe71…` (identical to devnet) | slot 449755892, tx `49bmXfGR…FYNR6Z2` |
| 2026-10-15 | Vault launch authority fix (`sparkfun-labs/pm-amm#9`): `launch_vault_market` / `launch_vault_group_leg` set `market.authority = vault.authority` (was the permissionless payer). `.so` SHA-256 `cd12a8a7…` (identical to devnet) | slot 457158853, tx `38tQQzzj…KwkNDUCm` |

Upgrade notes (Sprint 25):
- The `.so` (1,513,072 bytes) outgrew the 1,400,000-byte account, so
  `solana program extend GV1F… 150000` ran first. It cost only the tx fee: the
  account already held more lamports than the new size's rent.
- An upgrade stages the whole `.so` in a buffer (~7.7 SOL of rent, refunded on
  success). The authority needs that much free SOL before the deploy.
- `MAINNET_MAX_LEN` only applies to the first deploy; an upgrade reuses the
  existing account size (extend it if the new `.so` is bigger).
- The protocol DAO is compiled in: every client must pass the NEW DAO's ATA from
  the upgrade on (`@pm-amm/sdk` from this repo does; npm `0.1.0` is stale).

The steps below are the reproducible procedure (and apply to future **upgrades** —
same `pnpm run deploy:mainnet`, which reuses the program ID).

---

## 1. Build the program

```bash
pnpm run build          # produces anchor/target/deploy/pm_amm.so (+ IDL/types)
pnpm run test:rust      # 84 unit tests must be green
```

## 2. Create + fund the mainnet authority key

Generate a **fresh, dedicated** keypair (do NOT reuse the devnet key). Keep its
secret safe — it controls every vault.

```bash
solana-keygen new -o ~/.config/solana/pm-amm-mainnet.json
solana-keygen pubkey ~/.config/solana/pm-amm-mainnet.json   # note the address
```

Fund that address with REAL SOL. For this ~1.3 MB program the rent is:
- **~9.75 SOL** in economical mode (`MAINNET_MAX_LEN=1400000`, recommended)
- **~18.2 SOL** in default mode (2× upgrade headroom)

Send **~12 SOL** to be safe (rent + fees + margin). The rent is a **recoverable
deposit** (refunded if you ever `solana program close` the program), not a fee —
the only truly-spent amount is ~0.02 SOL of transaction fees.

## 3. Deploy to mainnet (spends real SOL)

The program keeps the **same ID as devnet** (`GV1F…`) — `declare_id!` is compiled
in and clusters are isolated. The program-id keypair is already at
`anchor/target/deploy/pm_amm-keypair.json`.

```bash
MAINNET_RPC_URL="https://your-dedicated-mainnet-rpc" \
MAINNET_AUTHORITY_KEYPAIR="$HOME/.config/solana/pm-amm-mainnet.json" \
MAINNET_MAX_LEN=1400000 \
pnpm run deploy:mainnet
```

The script prints the program ID, authority, balance, max-len, and priority fee,
then asks you to type `DEPLOY MAINNET` to confirm. Afterwards, verify the authority:

```bash
solana program show GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y --url "$MAINNET_RPC_URL"
```

**Why these flags matter (learned the hard way on the first deploy):**
- **Use a DEDICATED RPC.** The public endpoint (`api.mainnet-beta.solana.com`)
  rate-limits the ~1300 write transactions → the deploy dies with
  `Data writes to account failed: Max retries exceeded`. Helius/Triton/QuickNode work.
- The script already passes `--use-rpc`, a **priority fee**
  (`--with-compute-unit-price`, override via `MAINNET_PRIORITY_FEE`, default 200000),
  and `--max-sign-attempts 80`. Without the priority fee the writes don't land on a
  congested mainnet — even on a dedicated RPC.
- `MAINNET_MAX_LEN=1400000` → ~9.75 SOL rent instead of ~18 (less upgrade headroom).
- **If it fails mid-write**, a buffer is left and the CLI prints its address + a
  `solana program close <buffer>` command. Your SOL is safe in that buffer. Resume
  by passing the buffer keypair via `--buffer` (writes only the missing chunks, no
  extra rent), or close it to reclaim the lamports.

## 4. Point the front at mainnet (Vercel Production env)

Set these in the Vercel project (see `app/.env.mainnet.example`):

| Var | Value |
|---|---|
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `mainnet-beta` |
| `NEXT_PUBLIC_PROGRAM_ID` | `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` |
| `NEXT_PUBLIC_USDC_MINT` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `NEXT_PUBLIC_RPC_URL` | your dedicated mainnet RPC |

**Do NOT set `MINT_AUTHORITY_KEY`** — the faucet is hard-disabled on mainnet (the
button is hidden and the API returns 503). Real USDC is not mintable.

⚠️ **Replace** any existing devnet env vars (don't just add) — a stale
`NEXT_PUBLIC_PROGRAM_ID`/`NEXT_PUBLIC_USDC_MINT` overrides the code defaults and
points the app at the wrong cluster.

⚠️ `NEXT_PUBLIC_RPC_URL` is **exposed to the browser**. If you reuse your deploy
RPC key here, its quota becomes public — for production use a separate front-end
key with usage limits.

Redeploy the front (env changes need a rebuild). The first swap on any market will
create the protocol-DAO and creator fee ATAs automatically.

## 5. Smoke-test with tiny amounts first

Before announcing: create one market, deposit a few real USDC, do a small swap
(check the 2% fee lands at the DAO + creator), resolve, and claim — all with
amounts you can afford to lose. Then verify vault solvency on-chain.

---

## What stays solid

The pm-AMM engine: paper-faithful math, the audit-#1 full-collateralization fix
(+ on-chain solvency guard on every swap), vault liveness (#4/#5), committers=LPs
(#6), and 266 tests. **Within honest operation, funds are mechanically safe.** The
gap is purely the trust/governance layer enumerated at the top.
