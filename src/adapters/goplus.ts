import type { TokenSignals } from '../scoring';
import { anyTrue, compact, isNumber } from './util';

/** Numeric chain IDs for GET /api/v1/token_security/{chain_id}. Solana uses a separate path. */
export type GoPlusChainId = '1' | '8453' | '56' | 'solana';

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

export interface GoPlusResponse<T> {
  code?: number;
  result?: Record<string, T> | null;
}

/** Fields we read from GET /api/v1/token_security/{chain_id}?contract_addresses=… */
export interface GoPlusEvmToken {
  is_honeypot?: string;
  honeypot_with_same_creator?: string;
  owner_change_balance?: string;
  transfer_pausable?: string;
  buy_tax?: string;
  sell_tax?: string;
  transfer_tax?: string;
  slippage_modifiable?: string;
  personal_slippage_modifiable?: string;
  is_mintable?: string;
  is_blacklisted?: string;
  is_whitelisted?: string;
  is_open_source?: string;
  is_proxy?: string;
  hidden_owner?: string;
  can_take_back_ownership?: string;
  cannot_sell_all?: string;
  anti_whale_modifiable?: string;
  is_anti_whale?: string;
  trading_cooldown?: string;
  external_call?: string;
  selfdestruct?: string;
  owner_address?: string;
  lp_holders?: readonly { percent?: string; is_locked?: number }[] | null;
}

export interface GoPlusAuthority {
  status?: string;
}

/** Fields we read from GET /api/v1/solana/token_security?contract_addresses=… */
export interface GoPlusSolanaToken {
  mintable?: GoPlusAuthority;
  freezable?: GoPlusAuthority;
  closable?: GoPlusAuthority;
  balance_mutable_authority?: GoPlusAuthority;
  metadata_mutable?: GoPlusAuthority;
  transfer_fee_upgradable?: GoPlusAuthority;
  transfer_fee?: { current_fee_rate?: string | number };
  non_transferable?: string;
}

export type GoPlusToken = GoPlusEvmToken | GoPlusSolanaToken;

/** GoPlus uses "1" / "0" strings; a missing field means the check didn’t run. */
function flag(value: string | undefined): boolean | undefined {
  if (value === '1') return true;
  if (value === '0') return false;
  return undefined;
}

/** Tax arrives as a 0–1 fraction, or an empty string when unknown. */
function taxPct(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return number <= 1 ? number * 100 : number;
}

/** An empty owner means GoPlus couldn't find one, not that it was burned, so it stays unknown. */
function ownerGaveUp(address: string | undefined): boolean | undefined {
  if (address === undefined || address.trim() === '') return undefined;
  const normalised = address.trim().toLowerCase();
  return normalised === ZERO || normalised === DEAD;
}

function lockedLiquidityPct(holders: GoPlusEvmToken['lp_holders']): number | undefined {
  if (!holders?.length) return undefined;
  const locked = holders.reduce((sum, holder) => {
    if (holder.is_locked !== 1) return sum;
    const share = Number(holder.percent);
    return isNumber(share) ? sum + share * 100 : sum;
  }, 0);
  return Math.min(100, locked);
}

export function tokenFromGoPlus<T>(result: Record<string, T> | null | undefined, address: string): T | undefined {
  if (!result) return undefined;
  return result[address] ?? result[address.toLowerCase()];
}

export function signalsFromGoPlus(chainId: GoPlusChainId, token: GoPlusToken): Partial<TokenSignals> {
  if (chainId === 'solana') {
    const t = token as GoPlusSolanaToken;
    const fee = t.transfer_fee?.current_fee_rate;
    return compact({
      // GoPlus has no sell test on Solana. A non-transferable token can't be sold at all,
      // but a transferable one hasn't passed anything, so the sell test stays unknown.
      honeypotRisk: flag(t.non_transferable) ? 100 : undefined,
      mintable: flag(t.mintable?.status),
      canFreeze: flag(t.freezable?.status),
      canTakeTokens: anyTrue(flag(t.closable?.status), flag(t.balance_mutable_authority?.status)),
      feesChangeable: flag(t.transfer_fee_upgradable?.status),
      metadataMutable: flag(t.metadata_mutable?.status),
      transferFeePct: taxPct(fee),
    });
  }

  const t = token as GoPlusEvmToken;
  const honeypot = flag(t.is_honeypot);
  const hiddenControl = anyTrue(flag(t.hidden_owner), flag(t.can_take_back_ownership));
  const ownershipRenounced = ownerGaveUp(t.owner_address);
  // GoPlus still reports functions that exist in the code. Once the owner is a
  // burn address and can't take control back, those functions can't be used.
  const stillInControl = ownershipRenounced === true && hiddenControl === false ? false : true;
  const ifOwner = (value: boolean | undefined) => (value === undefined ? undefined : stillInControl && value);

  return compact({
    honeypotRisk: honeypot === undefined ? undefined : honeypot ? 100 : 0,
    canTakeTokens: ifOwner(flag(t.owner_change_balance)),
    knownScamCreator: flag(t.honeypot_with_same_creator),
    canPause: ifOwner(flag(t.transfer_pausable)),
    buyFeePct: taxPct(t.buy_tax),
    sellFeePct: taxPct(t.sell_tax),
    transferFeePct: taxPct(t.transfer_tax),
    feesChangeable: ifOwner(anyTrue(flag(t.slippage_modifiable), flag(t.personal_slippage_modifiable))),
    mintable: ifOwner(flag(t.is_mintable)),
    canFreeze: ifOwner(anyTrue(flag(t.is_blacklisted), flag(t.is_whitelisted))),
    hasBlacklist: ifOwner(flag(t.is_blacklisted)),
    hasWhitelist: ifOwner(flag(t.is_whitelisted)),
    codeVerified: flag(t.is_open_source),
    upgradeable: flag(t.is_proxy),
    hiddenControl,
    sellLimited: ifOwner(flag(t.cannot_sell_all)),
    cannotSellAll: ifOwner(flag(t.cannot_sell_all)),
    antiWhale: ifOwner(anyTrue(flag(t.anti_whale_modifiable), flag(t.is_anti_whale))),
    tradingCooldown: ifOwner(flag(t.trading_cooldown)),
    externalCall: flag(t.external_call),
    suspiciousFunctions: flag(t.selfdestruct),
    ownershipRenounced,
    liquidityLockedPct: lockedLiquidityPct(t.lp_holders),
  });
}
