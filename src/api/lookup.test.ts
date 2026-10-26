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
    expect(fetchMock).toHaveBeenCalledTimes(8);
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
    expect(fetchMock).toHaveBeenCalledTimes(6);
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

describe('lookupToken on each plan', () => {
  const routes = (calls: string[]) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/token-pairs/v1/ethereum/')) return Response.json([{ ...pepePair('ethereum', 50_000), info: { socials: [{ type: 'twitter', url: 'https://x.com/pepecoineth' }] } }]);
      if (url.includes('/token_security/')) return Response.json({ code: 1, result: { [EVM.toLowerCase()]: {} } });
      if (url.includes('/users/by/username/')) return Response.json({ data: { id: '1', username: 'pepecoineth', public_metrics: { followers_count: 500_000 } } });
      if (url.includes('search/recent')) return Response.json(noMentions);
      if (url.includes('honeypot.is')) return Response.json({ honeypotResult: { isHoneypot: true }, simulationResult: { sellTax: 100 } });
      return new Response(null, { status: 404 });
    });

  it('Free reads Community from the library once a paid scan has saved it, without calling X', async () => {
    const { PLANS } = await import('../plans/plans');
    const { setLibraryStore, memoryLibrary } = await import('../plans/library');
    setLibraryStore(memoryLibrary());
    const calls: string[] = [];
    vi.stubGlobal('fetch', routes(calls));

    const paid = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.pro, library: true });
    expect(paid.communitySource).toBe('fetched');

    calls.length = 0;
    const free = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.free, library: true });
    expect(free.communitySource).toBe('library');
    expect(free.community?.score).toBe(paid.community?.score);
    expect(calls.some((url) => url.includes('/api/twitter'))).toBe(false);
    // Security still runs fresh.
    expect(calls.some((url) => url.includes('/token_security/'))).toBe(true);
  });

  it('Free skips Community on a token nobody has scanned when today\'s limits say no, without calling X', async () => {
    const { PLANS } = await import('../plans/plans');
    const { setLibraryStore, memoryLibrary } = await import('../plans/library');
    setLibraryStore(memoryLibrary());
    const calls: string[] = [];
    vi.stubGlobal('fetch', routes(calls));
    const free = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.free, library: true, mayCheckBasic: async () => false });
    expect(free.communitySource).toBe('skipped');
    expect(free.community).toBeUndefined();
    expect(calls.some((url) => url.includes('/api/twitter'))).toBe(false);
    expect(calls.some((url) => url.includes('/token_security/'))).toBe(true);
  });

  it('Free runs a basic check on a token nobody has scanned, saves it for Free only, and scores it cautiously', async () => {
    const { PLANS } = await import('../plans/plans');
    const { setLibraryStore, memoryLibrary } = await import('../plans/library');
    setLibraryStore(memoryLibrary());
    const calls: string[] = [];
    const spent: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/users/by/username/') && url.includes('expansions=most_recent_tweet_id')) {
          return Response.json({
            data: { id: '1', username: 'pepecoineth', public_metrics: { followers_count: 500_000 } },
            includes: { tweets: [{ id: '9', public_metrics: { like_count: 5000, reply_count: 900, retweet_count: 800 } }] },
          });
        }
        if (url.includes('counts/recent')) return Response.json({ meta: { total_tweet_count: 5000 } });
        return routes([])(input);
      }),
    );

    const free = await lookupToken(EVM, undefined, 'eth', {}, false, {
      plan: PLANS.free,
      library: true,
      mayCheckBasic: async () => true,
      spent: (cost) => spent.push(cost),
    });
    expect(free).toMatchObject({ communitySource: 'basic', communityFrom: 'basic', community: { basic: true, official: { followers: 500_000, tweetsLookedAt: 1 } } });
    // A busy account would score higher on a full check; a basic one tops out at 65.
    expect(free.community?.score).toBe(65);
    expect(spent).toEqual([0.02]);
    expect(calls.some((url) => url.includes('search/recent') || url.includes('/tweets?'))).toBe(false);

    calls.length = 0;
    const again = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.free, library: true, mayCheckBasic: async () => true });
    expect(again).toMatchObject({ communitySource: 'library', communityFrom: 'basic' });
    expect(calls.some((url) => url.includes('/api/twitter'))).toBe(false);

    // Pro never takes a basic check as its own.
    calls.length = 0;
    const pro = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.pro, library: true });
    expect(pro.communitySource).toBe('fetched');
    expect(calls.some((url) => url.includes('search/recent'))).toBe(true);
  });

  it('a basic check asks for the account and then its posts when X refuses the latest-post field', async () => {
    const { fetchBasicBundle } = await import('./twitter');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('expansions=most_recent_tweet_id')) return new Response(null, { status: 400 });
        if (url.includes('/users/by/username/')) return Response.json({ data: { id: '1', username: 'pepecoineth', public_metrics: { followers_count: 50 } } });
        if (url.includes('/users/1/tweets')) {
          return Response.json({ data: [{ id: '3', public_metrics: { like_count: 7, reply_count: 2 } }, { id: '2', public_metrics: { like_count: 99 } }] });
        }
        if (url.includes('counts/recent')) return Response.json({ meta: { total_tweet_count: 12 } });
        return new Response(null, { status: 404 });
      }),
    );
    const { bundle, cost } = await fetchBasicBundle({ handle: 'pepecoineth', symbol: 'PEPE' });
    expect(bundle.tweets).toEqual([{ likes: 7, replies: 2, reposts: 0 }]);
    expect(bundle).toMatchObject({ basic: true, mentionTotal: 12, profile: { followers: 50 } });
    expect(cost).toBeCloseTo(0.04, 3);
    expect(calls.find((url) => url.includes('/users/1/tweets'))).toContain('max_results=5');
  });

  it('Ultra reads 30 mentions and adds a second opinion that can only make security worse', async () => {
    const { PLANS } = await import('../plans/plans');
    const calls: string[] = [];
    vi.stubGlobal('fetch', routes(calls));
    const ultra = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.ultra });
    expect(calls.find((url) => url.includes('search/recent'))).toContain('max_results=30');
    expect(ultra.secondOpinion).toMatchObject({ source: 'Honeypot.is', ok: true });
    expect(ultra.signals.honeypotRisk).toBe(100);

    calls.length = 0;
    const pro = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.pro });
    expect(calls.find((url) => url.includes('search/recent'))).toContain('max_results=10');
    expect(calls.some((url) => url.includes('honeypot.is'))).toBe(false);
    expect(pro.secondOpinion).toBeUndefined();
  });
});

describe('trickle-down between plans', () => {
  const tweets = (prefix: string, count: number) => ({
    data: Array.from({ length: count }, (_, i) => ({ id: `${prefix}${100 - i}`, author_id: 'a', public_metrics: { like_count: 1 } })),
    includes: { users: [{ id: 'a', public_metrics: { followers_count: 10 } }] },
  });
  const routes = (calls: string[]) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/token-pairs/v1/ethereum/')) return Response.json([{ ...pepePair('ethereum', 50_000), info: { socials: [{ type: 'twitter', url: 'https://x.com/pepecoineth' }] } }]);
      if (url.includes('/token_security/')) return Response.json({ code: 1, result: { [EVM.toLowerCase()]: {} } });
      if (url.includes('/users/by/username/')) {
        return Response.json({ data: { id: '1', username: 'pepecoineth', description: '@a1 @a2 @a3 @a4 @a5 @a6 @a7', public_metrics: { followers_count: 500_000 } } });
      }
      if (url.includes('/users/by?usernames=')) {
        const names = decodeURIComponent(url.split('usernames=')[1].split('&')[0]).split(',');
        return Response.json({ data: names.map((username) => ({ username, public_metrics: { followers_count: 1 } })) });
      }
      if (url.includes('/users/1/tweets')) return Response.json(tweets('p', Number(url.match(/max_results=(\d+)/)![1])));
      if (url.includes('search/recent')) return Response.json(tweets('m', Number(url.match(/max_results=(\d+)/)![1])));
      if (url.includes('counts/recent')) return Response.json({ meta: { total_tweet_count: 400 } });
      return new Response(null, { status: 404 });
    });

  it('Ultra reads on from a recent Pro scan instead of starting again', async () => {
    const { PLANS } = await import('../plans/plans');
    const { setLibraryStore, memoryLibrary } = await import('../plans/library');
    setLibraryStore(memoryLibrary());
    const calls: string[] = [];
    vi.stubGlobal('fetch', routes(calls));

    const pro = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.pro, library: true });
    expect(pro.communitySource).toBe('fetched');

    calls.length = 0;
    const ultra = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.ultra, library: true });
    expect(ultra.communitySource).toBe('expanded');
    const x = calls.filter((url) => url.includes('/api/twitter'));
    // Only what Pro didn't read: 20 older mentions, 15 older posts, bio accounts 6 to 7.
    expect(x.find((url) => url.includes('search/recent'))).toMatch(/max_results=20.*until_id=m91/);
    expect(x.find((url) => url.includes('/users/1/tweets'))).toMatch(/max_results=15.*until_id=p86/);
    expect(decodeURIComponent(x.find((url) => url.includes('/users/by?usernames='))!)).toContain('usernames=a6,a7&');
    expect(x.some((url) => url.includes('/users/by/username/') || url.includes('counts/recent'))).toBe(false);

    // Free now gets the Ultra result, without calling X.
    calls.length = 0;
    const free = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.free, library: true });
    expect(free).toMatchObject({ communitySource: 'library', communityFrom: 'ultra' });
    expect(free.community?.score).toBe(ultra.community?.score);
    expect(calls.some((url) => url.includes('/api/twitter'))).toBe(false);

    // So does Pro, inside its window.
    calls.length = 0;
    const proAgain = await lookupToken(EVM, undefined, 'eth', {}, false, { plan: PLANS.pro, library: true });
    expect(proAgain).toMatchObject({ communitySource: 'library', communityFrom: 'ultra' });
    expect(calls.some((url) => url.includes('/api/twitter'))).toBe(false);
  });
});
