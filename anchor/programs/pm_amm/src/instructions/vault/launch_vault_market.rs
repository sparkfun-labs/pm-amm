//! Launch the underlying pm-AMM market once the commit phase ends.
//! Permissionless — any signer can trigger it. The caller pays the rent of
//! the freshly-created Market, mints, vault, and Metaplex metadata accounts,
//! but gains no rights: `market.authority` (resolver + creator fee) is the
//! vault's creator, never the payer.
//!
//! What happens atomically in this single instruction:
//!   1. Compute the launch price from the commit ratio
//!      (`yes_total / total`) → bps, clamped to `[100, 9900]`.
//!   2. Initialize the underlying binary market via internal call (NOT a CPI
//!      to ourselves — direct call to `initialize_market::handler`).
//!   3. Deposit the whole pot as liquidity (audit #6, option C): calibrate
//!      `max(x, y) = total`, record the entry-side surplus, and move the USDC
//!      into the market vault. Committers materialize their LP slice (shares
//!      + surplus) in `claim_committer`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::metadata::mpl_token_metadata::instructions::{
    CreateMetadataAccountV3, CreateMetadataAccountV3InstructionArgs,
};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use fixed::types::I80F48;

use crate::errors::PmAmmError;
use crate::instructions::initialize_market::{NO_MINT_SEED, VAULT_SEED, YES_MINT_SEED};
use crate::instructions::vault::VAULT_COLLATERAL_SEED;
use crate::pm_math;
use crate::state::{CommitmentVault, Market};

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct LaunchVaultMarket<'info> {
    /// Permissionless caller — pays the rent for the new Market/mints/vault.
    /// Gets no authority over the market (see `market.authority` below).
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [CommitmentVault::SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, CommitmentVault>>,

    /// New Market PDA — derived from `market_id` (typically vault_id reused).
    #[account(
        init,
        payer = payer,
        space = Market::LEN,
        seeds = [Market::SEED, market_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(constraint = collateral_mint.key() == vault.collateral_mint @ PmAmmError::InvalidWinningMint)]
    pub collateral_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        token::mint = collateral_mint,
        token::authority = market,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// The commitment vault's collateral ATA — its committed USDC is deposited
    /// into `market_vault` here as the bootstrap liquidity (option C).
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral: Box<Account<'info, TokenAccount>>,

    /// CHECK: Created via CPI to Metaplex Token Metadata program.
    #[account(mut)]
    pub yes_metadata: UncheckedAccount<'info>,
    /// CHECK: idem
    #[account(mut)]
    pub no_metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex Token Metadata program.
    #[account(address = anchor_spl::metadata::mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<LaunchVaultMarket>, market_id: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let vault = &mut ctx.accounts.vault;
    require!(!vault.launched, PmAmmError::VaultAlreadyLaunched);
    require!(now >= vault.commit_end_ts, PmAmmError::CommitPhaseNotEnded);
    require!(
        vault.total() >= vault.min_total,
        PmAmmError::VaultBelowMinTotal
    );

    // Compute launch price from commit ratio.
    let price_bps = vault.compute_price_bps();

    // ----- Inline equivalent of initialize_market::handler -----
    // Validate the resulting market duration is long enough.
    let market_end_ts = vault.market_end_ts;
    require!(
        market_end_ts > now + 300, // matches initialize_market::MIN_DURATION_SECS
        PmAmmError::InvalidDuration
    );

    let market = &mut ctx.accounts.market;
    // The vault creator, NOT the payer: `market.authority` resolves the market
    // and receives the creator fee, and launch is permissionless — anyone
    // front-running the launch would otherwise resolve the committers' pot.
    market.authority = vault.authority;
    market.market_id = market_id;
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = ctx.accounts.market_vault.key();
    market.start_ts = now;
    market.end_ts = market_end_ts;
    let mut name_bytes = [0u8; 64];
    name_bytes[..vault.name.len().min(64)].copy_from_slice(&vault.name);
    market.name = name_bytes;
    // Bootstrap the AMM with the WHOLE committed pot as liquidity (option C,
    // audit #6): committers become LPs. Calibrate L_0 so max(x,y) = total at the
    // commit-ratio price (fix #1 solvency) and set total_lp_shares = total. The
    // USDC is moved vault_collateral -> market_vault at the end of this handler.
    let total = vault.total();
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let time_remaining = market_end_ts - now;
    let price = I80F48::from_num(price_bps) / I80F48::from_num(10_000u16);
    let l_zero = pm_math::suggest_l_zero_for_max_reserve(total, time_remaining, price)?;
    let l_eff = pm_math::l_effective(l_zero, time_remaining)?;
    let (x, y) = pm_math::reserves_from_price(price, l_eff)?;

    market.set_l_zero_fixed(l_zero);
    market.set_reserve_yes_fixed(x);
    market.set_reserve_no_fixed(y);
    // Entry-side surplus of the whole pot: owed to committers pro-rata, credited
    // to their LpPosition in `claim_committer` (counted by the solvency guard).
    let (excess_yes, excess_no) = crate::state::deposit_excess(total, x, y);
    market.unclaimed_excess_yes = excess_yes;
    market.unclaimed_excess_no = excess_no;
    vault.launch_excess_yes = excess_yes;
    vault.launch_excess_no = excess_no;
    market.last_accrual_ts = now;
    market.cum_yes_per_share = 0;
    market.cum_no_per_share = 0;
    market.total_yes_distributed = 0;
    market.total_no_distributed = 0;
    market.set_total_lp_shares_fixed(I80F48::from_num(total));
    market.resolved = false;
    market.winning_side = 0;
    market.bump = ctx.bumps.market;
    market.initial_price_bps = price_bps;
    market.group = Pubkey::default();

    // Metaplex metadata for YES and NO mints — same as initialize_market.
    let id_bytes = market_id.to_le_bytes();
    let bump = ctx.bumps.market;
    let signer_seeds: &[&[u8]] = &[Market::SEED, &id_bytes, &[bump]];

    let yes_name = truncate_str(&format!("YES - {}", vault.name_str()), 32);
    create_token_metadata(
        ctx.accounts.yes_metadata.to_account_info(),
        ctx.accounts.yes_mint.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.rent.to_account_info(),
        yes_name,
        "YES".to_string(),
        String::new(),
        signer_seeds,
    )?;

    let no_name = truncate_str(&format!("NO - {}", vault.name_str()), 32);
    create_token_metadata(
        ctx.accounts.no_metadata.to_account_info(),
        ctx.accounts.no_mint.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.rent.to_account_info(),
        no_name,
        "NO".to_string(),
        String::new(),
        signer_seeds,
    )?;

    // Mark the vault as launched and record the market pubkey + price.
    vault.launched = true;
    vault.winning_price_bps = price_bps;
    vault.market = ctx.accounts.market.key();

    msg!(
        "Vault {} launched market {} at price_bps={} (yes={} no={} total={})",
        vault.vault_id,
        market_id,
        price_bps,
        vault.yes_total,
        vault.no_total,
        vault.total()
    );

    // Move the committed pot into the market vault as the LP collateral that
    // backs the bootstrapped reserves. The commitment vault PDA signs. (The
    // `vault` &mut binding's borrow has ended above, so we use ctx.accounts.)
    let vault_seeds: &[&[&[u8]]] = &[&[
        CommitmentVault::SEED,
        vault_id_bytes.as_ref(),
        &[vault_bump],
    ]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault_collateral.to_account_info(),
                to: ctx.accounts.market_vault.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_seeds,
        ),
        total,
    )?;

    Ok(())
}

pub(crate) fn truncate_str(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        let mut end = max_len;
        while !s.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        s[..end].to_string()
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn create_token_metadata<'info>(
    metadata_ai: AccountInfo<'info>,
    mint_ai: AccountInfo<'info>,
    authority_ai: AccountInfo<'info>,
    payer_ai: AccountInfo<'info>,
    system_ai: AccountInfo<'info>,
    rent_ai: AccountInfo<'info>,
    token_name: String,
    symbol: String,
    uri: String,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let ix = CreateMetadataAccountV3 {
        metadata: metadata_ai.key(),
        mint: mint_ai.key(),
        mint_authority: authority_ai.key(),
        payer: payer_ai.key(),
        update_authority: (authority_ai.key(), true),
        system_program: system_ai.key(),
        rent: Some(rent_ai.key()),
    }
    .instruction(CreateMetadataAccountV3InstructionArgs {
        data: DataV2 {
            name: token_name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        },
        is_mutable: true,
        collection_details: None,
    });

    invoke_signed(
        &ix,
        &[
            metadata_ai,
            mint_ai,
            authority_ai.clone(),
            payer_ai,
            system_ai,
            rent_ai,
        ],
        &[signer_seeds],
    )?;
    Ok(())
}
