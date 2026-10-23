import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTokenAddress, lookupToken } from './lookup';

const EVM = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

/** Each route is matched against the end of the URL; a number answers with that HTTP status. */
function serve(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((route) => url.includes(route));
    if (path === undefined) return new Response(null, { status: 404 });
    const body = routes[path];
    return typeof body === 'number' ? new Response(null, { status: body }) : Response.json(body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const noMentions = { data: [] } as const;

const pepePair = (chainId: string, liquidityUsd: number) => ({
  chainId,
  baseToken: { address: EVM, name: 'Pepe', symbol: 'PEPE' },
  quoteToken: { address: WETH, name: 'Wrapped Ether', symbol: 'WETH' },
  liquidity: { usd: liquidityUsd },
  pairCreatedAt: 1_681_492_871_000,
  info: { websites: [{ url: 'https://example.com' }] },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isTokenAddress', () => {
  it('accepts EVM and Solana addresses, ignoring spaces around them', () => {
    expect(isTokenAddress(EVM)).toBe(true);
    expect(isTokenAddress(` ${SOL}\n`)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const input of ['', 'pepe', EVM.slice(0, -1), `0x${'g'.repeat(40)}`, `${SOL.slice(0, -1)}0`]) {
      expect(isTokenAddress(input)).toBe(false);
    }
  });
});

describe('lookupToken', () => {
  it('runs the checks on the chain with the biggest trading pool', async () => {
    const fetchMock = serve({
      [`/token-pairs/v1/ethereum/${EVM}`]: [pepePair('ethereum', 5_000)],
      [`/token-pairs/v1/base/${EVM}`]: [pepePair('base', 80_000)],
      [`/token-pairs/v1/bsc/${EVM}`]: [],
      [`/token_security/8453?contract_addresses=${EVM}`]: { code: 1, result: { [EVM.toLowerCase()]: { is_mintable: '1' } } },
      [`/dex-metrics/v1/base/${EVM}`]: { cluster_pct: 12, top10_pct: 30 },
      'search/recent': noMentions,
    });

    const lookup = await lookupToken(EVM);

    expect(lookup).toMatchObject({ address: EVM, chain: { name: 'Base' }, name: 'Pepe', symbol: 'PEPE', failures: [] });
    expect(lookup.signals).toMatchObject({ chain: 'evm', liquidityUsd: 80_000, mintable: true, clusterPct: 12 });
    expect(lookup.foundation.score).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('only looks on Solana for a Solana address, and finds the token on either side of a pair', async () => {
    const fetchMock = serve({
      [`/token-pairs/v1/solana/${SOL}`]: [
        {
          chainId: 'solana',
          baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
          quoteToken: { address: SOL, name: 'Bonk', symbol: 'Bonk' },
          liquidity: { usd: 400_000 },
        },
      ],
      [`/solana/token_security?contract_addresses=${SOL}`]: { code: 1, result: { [SOL]: { freezable: { status: '0' } } } },
      [`/dex-metrics/v1/sol/${SOL}`]: { snipers_pct: 2 },
      'search/recent': noMentions,
    });

    const lookup = await lookupToken(SOL);

    expect(lookup).toMatchObject({ chain: { name: 'Solana' }, name: 'Bonk', symbol: 'Bonk' });
    expect(lookup.signals).toMatchObject({ chain: 'solana', canFreeze: false, snipersPct: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('still returns a result when a security or holder request fails, and says which part failed', async () => {
    serve({
      [`/token-pairs/v1/ethereum/${EVM}`]: [pepePair('ethereum', 30_000_000)],
      [`/token-pairs/v1/base/${EVM}`]: [],
      [`/token-pairs/v1/bsc/${EVM}`]: [],
      [`/token_security/1?contract_addresses=${EVM}`]: 401,
      [`/dex-metrics/v1/eth/${EVM}`]: { cluster_pct: 12 },
      'search/recent': noMentions,
    });

    const lookup = await lookupToken(EVM);

    expect(lookup.failures).toEqual([{ source: 'scan', status: 401 }]);
    expect(lookup.signals.honeypotRisk).toBeUndefined();
    expect(lookup.signals).toMatchObject({ liquidityUsd: 30_000_000, clusterPct: 12 });
  });

  it('says the token wasn’t found when no supported chain lists it', async () => {
    serve({
      [`/token-pairs/v1/ethereum/${EVM}`]: [],
      [`/token-pairs/v1/base/${EVM}`]: [],
      [`/token-pairs/v1/bsc/${EVM}`]: [],
    });

    await expect(lookupToken(EVM)).rejects.toMatchObject({
      reason: 'not-found',
      searched: [{ name: 'Ethereum' }, { name: 'Base' }, { name: 'BNB Chain' }],
    });
  });

  it('says the service is unavailable, not that the token is missing, when a listing request fails', async () => {
    serve({
      [`/token-pairs/v1/ethereum/${EVM}`]: 500,
      [`/token-pairs/v1/base/${EVM}`]: [],
      [`/token-pairs/v1/bsc/${EVM}`]: [],
    });

    await expect(lookupToken(EVM)).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('reads the official Twitter bio for named backers and a docs link', async () => {
    serve({
      [`/token-pairs/v1/ethereum/${EVM}`]: [
        {
          ...pepePair('ethereum', 30_000_000),
          info: {
            websites: [{ url: 'https://pepe.vip' }],
            socials: [{ type: 'twitter', url: 'https://twitter.com/pepecoineth' }],
          },
        },
      ],
      [`/token-pairs/v1/base/${EVM}`]: [],
      [`/token-pairs/v1/bsc/${EVM}`]: [],
      [`/token_security/1?contract_addresses=${EVM}`]: { code: 1, result: { [EVM.toLowerCase()]: { is_honeypot: '0' } } },
      [`/dex-metrics/v1/eth/${EVM}`]: { cluster_pct: 4 },
      '/2/users/by/username/pepecoineth': {
        data: {
          id: '42',
          username: 'pepecoineth',
          description: 'Official PEPE. Whitepaper in the bio. Built with @VitalikButerin',
          entities: {
            description: {
              urls: [{ expanded_url: 'https://pepe.vip/whitepaper.pdf' }],
              mentions: [{ username: 'VitalikButerin' }],
            },
          },
          public_metrics: { followers_count: 1000 },
        },
      },
      '/2/users/42/tweets': { data: [{ public_metrics: { like_count: 10, reply_count: 4, retweet_count: 1, quote_count: 0 } }] },
      '/2/users/by?usernames=vitalikbuterin': {
        data: [{ username: 'VitalikButerin', public_metrics: { followers_count: 5_000_000 } }],
      },
      'search/recent': noMentions,
      '/api/coingecko/': { tickers: [{ market: { name: 'Binance', identifier: 'binance' } }] },
    });

    const lookup = await lookupToken(EVM);

    expect(lookup.twitter).toBe('pepecoineth');
    expect(lookup.foundation.docsUrl).toBe('https://pepe.vip/whitepaper.pdf');
    expect(lookup.foundation.backers).toEqual([{ handle: 'VitalikButerin', followers: 5_000_000 }]);
    expect(lookup.foundation.exchanges).toContain('Binance');
    expect(lookup.foundation.score).toBeGreaterThan(70);
    expect(lookup.community?.official?.handle).toBe('pepecoineth');
  });

  it('rejects input that isn’t an address without calling any API', async () => {
    const fetchMock = serve({});

    await expect(lookupToken('not an address')).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('lookupToken with shared answers', () => {
  it('says how old a shared answer it accepts, and reports when each was fetched', async () => {
    const headersFor: Record<string, Headers> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/token-pairs/v1/ethereum/')) return Response.json([pepePair('ethereum', 50_000)]);
        if (url.includes('/token_security/')) return Response.json({ code: 1, result: { [EVM.toLowerCase()]: {} } });
        const headers = new Headers(init?.headers);
        if (url.includes('/dex-metrics/')) {
          headersFor.holders = headers;
          return Response.json({ top10_pct: 30 }, { headers: { 'x-saved-at': '5000' } });
        }
        if (url.includes('search/recent')) {
          headersFor.community = headers;
          return Response.json(noMentions, { headers: { 'x-saved-at': '7000' } });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const lookup = await lookupToken(EVM, undefined, 'eth');
    // PEPE launched in 2023, so it accepts day-old community answers and hour-old holder answers.
    expect(headersFor.community.get('x-share-seconds')).toBe('86400');
    expect(headersFor.holders.get('x-share-seconds')).toBe('3600');
    expect(lookup.checked).toEqual({ community: 7000, holders: 5000 });

    await lookupToken(EVM, undefined, 'eth', {}, true);
    expect(headersFor.community.get('x-share-seconds')).toBe('0');
    expect(headersFor.holders.get('x-share-seconds')).toBe('0');
  });
});
