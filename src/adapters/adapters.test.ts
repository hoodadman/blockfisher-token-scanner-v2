import { describe, expect, it } from 'vitest';
import {
  buildSignals,
  handleFromSocial,
  ownLinksOnly,
  signalsFromDexScreener,
  signalsFromGoPlus,
  signalsFromInsightXDexMetrics,
  twitterHandleFromDexScreener,
  websitesFromDexScreener,
} from '.';

describe('signalsFromDexScreener', () => {
  it('uses the deepest pool and the earliest pair', () => {
    const signals = signalsFromDexScreener([
      { chainId: 'solana', liquidity: { usd: 12_000 }, pairCreatedAt: 2_000, info: null },
      { chainId: 'solana', liquidity: { usd: 40_000 }, pairCreatedAt: 1_000, info: { socials: [{ type: 'twitter' }] } },
    ]);
    expect(signals).toEqual({ liquidityUsd: 40_000, launchedAt: 1_000, hasWebsiteOrSocials: true });
  });

  it('returns nothing for a token with no pairs', () => {
    expect(signalsFromDexScreener([])).toEqual({});
  });

  it('reads the first Twitter handle from a pair’s social links', () => {
    expect(handleFromSocial({ type: 'twitter', url: 'https://twitter.com/pepecoineth' })).toBe('pepecoineth');
    expect(handleFromSocial({ type: 'x', url: 'https://x.com/bonk_inu' })).toBe('bonk_inu');
    // A post link names its writer, who is often a caller, not the project.
    expect(handleFromSocial({ type: 'x', url: 'https://x.com/somecaller/status/1' })).toBeUndefined();
    expect(twitterHandleFromDexScreener([{ chainId: 'ethereum', info: { socials: [{ type: 'telegram', url: 'https://t.me/x' }] } }])).toBeUndefined();
  });

  it('drops links from pairs where the token is the second token', () => {
    const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
    const pairs = ownLinksOnly(
      [
        { chainId: 'ethereum', baseToken: { address: '0x1111111111111111111111111111111111111111' }, quoteToken: { address: usdt }, liquidity: { usd: 5 }, info: { socials: [{ type: 'twitter', url: 'https://x.com/newcoin' }] } },
        { chainId: 'ethereum', baseToken: { address: usdt.toLowerCase() }, liquidity: { usd: 9 }, info: { socials: [{ type: 'twitter', url: 'https://x.com/tether' }] } },
      ],
      usdt,
    );
    expect(twitterHandleFromDexScreener(pairs)).toBe('tether');
    expect(signalsFromDexScreener(pairs).liquidityUsd).toBe(9);
    expect(twitterHandleFromDexScreener(pairs.slice(0, 1))).toBeUndefined();
  });

  it('collects website links from DexScreener info', () => {
    expect(
      websitesFromDexScreener([
        { chainId: 'ethereum', info: { websites: [{ url: 'https://pepe.vip' }, { url: 'https://docs.pepe.vip' }] } },
        { chainId: 'ethereum', info: { websites: ['https://pepe.vip'] } },
      ]),
    ).toEqual(['https://pepe.vip', 'https://docs.pepe.vip']);
  });
});

describe('signalsFromGoPlus', () => {
  it('maps EVM flags, converting tax fractions and treating a zero owner as given up', () => {
    const signals = signalsFromGoPlus('1', {
      is_honeypot: '0',
      honeypot_with_same_creator: '0',
      owner_change_balance: '0',
      transfer_pausable: '1',
      buy_tax: '0',
      sell_tax: '0.12',
      transfer_tax: '',
      slippage_modifiable: '0',
      personal_slippage_modifiable: '0',
      is_mintable: '0',
      is_blacklisted: '0',
      is_whitelisted: '1',
      is_open_source: '1',
      is_proxy: '0',
      hidden_owner: '0',
      can_take_back_ownership: '1',
      cannot_sell_all: '0',
      anti_whale_modifiable: '0',
      owner_address: '0x0000000000000000000000000000000000000000',
      lp_holders: [{ percent: '0.4', is_locked: 1 }, { percent: '0.6', is_locked: 0 }],
    });
    expect(signals).toMatchObject({
      honeypotRisk: 0,
      sellFeePct: 12,
      canFreeze: true,
      hasWhitelist: true,
      hiddenControl: true,
      ownershipRenounced: true,
      canPause: true,
      liquidityLockedPct: 40,
    });
  });

  it('treats a missing EVM flag as unknown, not a pass', () => {
    expect(signalsFromGoPlus('8453', { is_blacklisted: '0' }).hasBlacklist).toBe(false);
    expect(signalsFromGoPlus('8453', { is_blacklisted: '0' }).hasWhitelist).toBeUndefined();
    expect(signalsFromGoPlus('8453', { is_blacklisted: '0', is_whitelisted: '0' }).canFreeze).toBe(false);
  });

  it('ignores owner-only powers once ownership is given up and can’t be taken back', () => {
    const signals = signalsFromGoPlus('1', {
      is_blacklisted: '1',
      transfer_pausable: '1',
      anti_whale_modifiable: '1',
      is_mintable: '1',
      owner_address: '0x0000000000000000000000000000000000000000',
      hidden_owner: '0',
      can_take_back_ownership: '0',
    });
    expect(signals).toMatchObject({
      ownershipRenounced: true,
      hiddenControl: false,
      canFreeze: false,
      hasBlacklist: false,
      antiWhale: false,
      canPause: false,
      mintable: false,
    });
  });

  it('maps Solana authorities from status fields', () => {
    const signals = signalsFromGoPlus('solana', {
      mintable: { status: '1' },
      freezable: { status: '0' },
      closable: { status: '0' },
      balance_mutable_authority: { status: '0' },
      metadata_mutable: { status: '1' },
      transfer_fee_upgradable: { status: '0' },
      transfer_fee: { current_fee_rate: '0' },
      non_transferable: '0',
    });
    expect(signals).toMatchObject({
      mintable: true,
      canFreeze: false,
      canTakeTokens: false,
      metadataMutable: true,
      feesChangeable: false,
      honeypotRisk: 0,
      transferFeePct: 0,
    });
  });
});

describe('signalsFromInsightXDexMetrics', () => {
  it('ignores sniper, bundler and creator figures outside Solana, where InsightX reports 0', () => {
    const metrics = { cluster_pct: 32.5, snipers_pct: 0, bundlers_pct: 0, dev_pct: 0, insiders_pct: 0, top10_pct: 45.3 };
    expect(signalsFromInsightXDexMetrics('base', metrics)).toEqual({ clusterPct: 32.5, top10Pct: 45.3 });
    expect(signalsFromInsightXDexMetrics('sol', metrics)).toMatchObject({ snipersPct: 0, devPct: 0 });
  });
});

describe('buildSignals', () => {
  it('sets the chain from the network and merges every source', () => {
    const signals = buildSignals('sol', {
      dexScreenerPairs: [{ chainId: 'solana', liquidity: { usd: 5_000 } }],
      goPlus: { mintable: { status: '1' } },
      insightXDexMetrics: { cluster_pct: 10 },
    });
    expect(signals).toEqual({
      chain: 'solana',
      liquidityUsd: 5_000,
      hasWebsiteOrSocials: false,
      mintable: true,
      clusterPct: 10,
    });
  });
});
