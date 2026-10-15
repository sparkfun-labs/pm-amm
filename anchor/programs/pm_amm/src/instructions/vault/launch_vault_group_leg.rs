//! Step 2 (run once per leg) of the multi-outcome vault launch.
//!
//! Creates one binary leg: Market PDA + YES/NO mints + market vault +
//! Metaplex metadata. Computes the seed price from
//! `leg_totals[leg_index] / total` bps, then attaches the new leg market to
//! the GroupMarket. Permissionless caller pays the rent but gains no rights:
//! the leg's `market.authority` (creator fee) is the vault's creator.
//!
//! When `legs_launched == leg_count`, the vault is considered fully launched
//! and `claim_committer_group` opens.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::metadata::mpl_token_metadata::instructions::{
    CreateMetadataAccountV3, CreateMetadataAccountV3InstructionArgs,
};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::PmAmmError;
use crate::instructions::initialize_market::{NO_MINT_SEED, VAULT_SEED, YES_MINT_SEED};
use crate::state::{CommitmentVaultGroup, GroupMarket, Market};

#[derive(Accounts)]
#[instruction(leg_index: u8, market_id: u64)]
pub struct LaunchVaultGroupLeg<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [CommitmentVaultGroup::SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, CommitmentVaultGroup>>,

    #[account(
        mut,
        seeds = [GroupMarket::SEED, group_market.group_id.to_le_bytes().as_ref()],
        bump = group_market.bump,
        // Bind the group to THIS vault — the vault's group_market field
        // is set by launch_vault_group_market and is the source of truth
        // for which group the legs attach to.
        constraint = group_market.key() == vault.group_market @ PmAmmError::Unauthorized,
        constraint = !group_market.resolved @ PmAmmError::GroupAlreadyResolved,
    )]
    pub group_market: Box<Account<'info, GroupMarket>>,

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

    /// CHECK: Created via CPI to Metaplex Token Metadata.
    #[account(mut)]
    pub yes_metadata: UncheckedAccount<'info>,
    /// CHECK: idem
    #[account(mut)]
    pub no_metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex program.
    #[account(address = anchor_spl::metadata::mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<LaunchVaultGroupLeg>, leg_index: u8, market_id: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let vault = &mut ctx.accounts.vault;
    require!(
        vault.group_market_initialized,
        PmAmmError::VaultGroupNotInitialized
    );
    require!(
        (leg_index as usize) < vault.leg_count as usize,
        PmAmmError::VaultGroupLegOutOfBounds
    );

    // Idempotency: the GroupMarket slot must still be empty.
    let group = &mut ctx.accounts.group_market;
    require!(
        group.legs[leg_index as usize] == Pubkey::default(),
        PmAmmError::VaultGroupLegAlreadyLaunched
    );

    // Per-leg bps from commit ratio. Already guarded by `all_legs_above_min_share`
    // at launch_vault_group_market, but defensive: re-check here in case
    // someone reaches this ix without having gone through the gate.
    let leg_bps = vault.leg_share_bps(leg_index as usize);
    require!(leg_bps >= 100, PmAmmError::VaultGroupInsufficientLegShare);
    // Initialize_market caps at 9900; cap here too. Σ totals = 1.0 means
    // no single leg can exceed 9900 if leg_count ≥ 2 AND every leg ≥ 100 bps.
    let clamped_bps = leg_bps.min(9900);

    // The leg market only needs to be unexpired here — NOT `> now + 300`.
    // Re-applying the 300s MIN_DURATION headroom per leg against a moving `now`
    // let the group enter the irreversible launched state (refund disabled)
    // while a leg launched late became un-launchable → permanent fund lock,
    // guaranteed for min-duration vaults (audit #5). MIN_DURATION is already
    // enforced at vault init; a late leg just resolves sooner via the cascade.
    let market_end_ts = vault.market_end_ts;
    require!(market_end_ts > now, PmAmmError::MarketExpired);

    // ----- Inline equivalent of initialize_market::handler -----
    let market = &mut ctx.accounts.market;
    // The vault creator, NOT the permissionless payer (who would otherwise
    // capture the leg's creator fee). Same as `group.authority`.
    market.authority = vault.authority;
    market.market_id = market_id;
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = ctx.accounts.market_vault.key();
    market.start_ts = now;
    market.end_ts = market_end_ts;
    let mut name_bytes = [0u8; 64];
    let leg_label = vault.leg_name_str(leg_index as usize);
    let display = truncate_str(&format!("{} - {}", vault.name_str(), leg_label), 64);
    name_bytes[..display.len()].copy_from_slice(display.as_bytes());
    market.name = name_bytes;
    market.l_zero = 0;
    market.reserve_yes = 0;
    market.reserve_no = 0;
    market.last_accrual_ts = now;
    market.cum_yes_per_share = 0;
    market.cum_no_per_share = 0;
    market.total_yes_distributed = 0;
    market.total_no_distributed = 0;
    market.total_lp_shares = 0;
    market.resolved = false;
    market.winning_side = 0;
    market.bump = ctx.bumps.market;
    market.initial_price_bps = clamped_bps;
    market.group = group.key();

    // ----- Metaplex metadata -----
    let id_bytes = market_id.to_le_bytes();
    let bump = ctx.bumps.market;
    let signer_seeds: &[&[u8]] = &[Market::SEED, &id_bytes, &[bump]];

    let yes_name = truncate_str(&format!("YES - {}", leg_label), 32);
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

    let no_name = truncate_str(&format!("NO - {}", leg_label), 32);
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

    // ----- Attach the leg to the group (inline; vault PDA is the authority) -----
    let market_key = ctx.accounts.market.key();
    group.legs[leg_index as usize] = market_key;
    group.total_seeded_bps = group.total_seeded_bps.saturating_add(clamped_bps as u32);

    vault.legs_launched = vault.legs_launched.saturating_add(1);

    msg!(
        "VaultGroup {} leg {} launched: market={} bps={} ({}/{} legs launched)",
        vault.vault_id,
        leg_index,
        market_key,
        clamped_bps,
        vault.legs_launched,
        vault.leg_count
    );
    Ok(())
}

fn truncate_str(s: &str, max_len: usize) -> String {
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
fn create_token_metadata<'info>(
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
