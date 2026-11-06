import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter, TtlCache, handleIdentify, handleScan } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TtlCache', () => {
  it('forgets entries after their time is up', () => {
    let now = 0;
    const cache = new TtlCache<number>(1_000, 10, () => now);
    cache.set('a', 1);
    now = 999;
    expect(cache.get('a')).toBe(1);
    now = 1_000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('drops the oldest entry when full', () => {
    const cache = new TtlCache<number>(1_000, 2, () => 0);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });
});

describe('RateLimiter', () => {
  it('allows the limit, then asks the client to wait until the window resets', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.take('ip')).toBe(0);
    expect(limiter.take('ip')).toBe(0);
    expect(limiter.take('ip')).toBe(60);
    expect(limiter.take('other')).toBe(0);
    now = 60_000;
    expect(limiter.take('ip')).toBe(0);
  });
});

describe('handlers', () => {
  it('rejects a scan with no usable address without calling anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await handleScan({}, 'ip')).status).toBe(400);
    expect((await handleScan({ address: 'nope' }, 'ip')).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 502 when the market data service is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const reply = await handleIdentify({ candidates: [{ address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933' }] }, 'ip');
    expect(reply.status).toBe(502);
  });

  it('rejects a bad identify body', async () => {
    expect((await handleIdentify({ candidates: 'x' }, 'ip')).status).toBe(400);
  });
});

describe('client-supplied market data', () => {
  it('scans with pairs from the request instead of asking DexScreener', async () => {
    const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const reply = await handleScan(
      {
        address: PEPE,
        network: 'eth',
        pairs: [
          { chainId: 'ethereum', baseToken: { address: PEPE, name: 'Pepe', symbol: 'PEPE' }, liquidity: { usd: 5000 }, evil: 'ignored' },
          { chainId: 'base', baseToken: { address: PEPE }, liquidity: { usd: 1 } },
        ],
        coingecko: { tickers: [{ market: { identifier: 'binance', name: 'Binance' } }] },
      },
      'client-a',
    );
    expect(reply.status).toBe(200);
    const body = reply.body as { report: { name?: string; chain: { network: string } } };
    expect(body.report).toMatchObject({ name: 'Pepe', chain: { network: 'eth' } });
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.some((url) => url.includes('dexscreener'))).toBe(false);
    expect(urls.some((url) => url.includes('coingecko'))).toBe(false);
  });
});

describe('a repeated scan request', () => {
  it('shares the scan already running instead of starting another', async () => {
    const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { address: PEPE, network: 'eth', pairs: [{ chainId: 'ethereum', baseToken: { address: PEPE }, liquidity: { usd: 1 } }] };
    const [first, second] = await Promise.all([handleScan(body, 'client-b'), handleScan(body, 'client-b')]);
    expect(second).toBe(first);
    const goPlusCalls = fetchMock.mock.calls.filter((call) => String((call as unknown[])[0]).includes('gopluslabs'));
    expect(goPlusCalls).toHaveLength(1);
  });
});

describe('plans', () => {
  it('turns down a Re-check on Free without calling anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const reply = await handleScan({ address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', plan: 'free', refresh: true }, 'ip-free');
    expect(reply.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says which plan ran', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const address = `0x${'e'.repeat(40)}`;
    const reply = await handleScan({ address, network: 'eth', plan: 'ultra', pairs: [{ chainId: 'ethereum', baseToken: { address }, liquidity: { usd: 1 } }] }, 'ultra-client');
    const body = reply.body as { report: { plan: string; notes: string[] }; freshChecks: { limit: number } };
    expect(body.report.plan).toBe('ultra');
    expect(body.report.notes).toEqual([]);
    expect(body.freshChecks.limit).toBe(30);
  });
});

const tokenWithX = (i: number) => {
  const address = `0x${i.toString(16).padStart(40, '0')}`;
  return {
    address,
    network: 'eth',
    pairs: [{ chainId: 'ethereum', baseToken: { address, name: `Token ${i}`, symbol: `T${i}` }, liquidity: { usd: 1 }, info: { socials: [{ type: 'twitter', url: `https://x.com/token${i}` }] } }],
  };
};

const recording = (calls: string[]) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('search/recent')) return Response.json({ data: [], meta: { result_count: 0 } });
    return new Response(null, { status: 404 });
  });

describe('monthly fresh community checks', () => {
  it('Free gets 4 a month; after that Community is capped, but Security still runs on every scan', async () => {
    const { resetLimits } = await import('./api');
    resetLimits();
    const calls: string[] = [];
    vi.stubGlobal('fetch', recording(calls));
    for (let i = 101; i <= 104; i++) {
      const reply = await handleScan({ ...tokenWithX(i), plan: 'free' }, 'free-monthly');
      const report = (reply.body as { report: { communitySource: string; capAlert?: string } }).report;
      expect(report.communitySource).toBe('fetched');
      // The alert shows from the scan that used the last one.
      if (i < 104) expect(report.capAlert).toBeUndefined();
      else expect(report.capAlert).toMatch(/used all 4/);
    }
    calls.length = 0;
    const fifth = await handleScan({ ...tokenWithX(105), plan: 'free' }, 'free-monthly');
    const body = fifth.body as { report: { communitySource: string; capped: boolean; capAlert?: string; freshChecks?: { left: number } }; freshChecks: { used: number; left: number } };
    expect(body.report).toMatchObject({ communitySource: 'skipped', capped: true, freshChecks: { left: 0 } });
    expect(body.report.capAlert).toMatch(/used all 4 of this month’s fresh community checks.*Security still runs fresh on every scan.*Pro gives 30/);
    expect(body.freshChecks).toMatchObject({ used: 4, left: 0 });
    expect(calls.some((url) => url.includes('/api/twitter'))).toBe(false);
    expect(calls.some((url) => url.includes('gopluslabs'))).toBe(true);
    // Someone else's month is their own.
    const other = await handleScan({ ...tokenWithX(105), plan: 'free' }, 'free-other');
    expect((other.body as { report: { communitySource: string } }).report.communitySource).toBe('fetched');
    resetLimits();
  });

  it('Pro gets 30 a month, and a Re-check is turned down once they are used up', async () => {
    const { resetLimits } = await import('./api');
    resetLimits();
    vi.stubGlobal('fetch', recording([]));
    for (let i = 201; i <= 230; i++) await handleScan({ ...tokenWithX(i), plan: 'pro' }, 'pro-monthly');
    const next = await handleScan({ ...tokenWithX(231), plan: 'pro' }, 'pro-monthly');
    expect((next.body as { report: { capped: boolean } }).report.capped).toBe(true);
    const recheck = await handleScan({ ...tokenWithX(201), plan: 'pro', refresh: true }, 'pro-monthly');
    expect(recheck.status).toBe(429);
    resetLimits();
  });

  it('Free users together also stop at the shared daily budget', async () => {
    const { resetLimits } = await import('./api');
    resetLimits(0.01);
    const calls: string[] = [];
    vi.stubGlobal('fetch', recording(calls));
    const reply = await handleScan({ ...tokenWithX(301), plan: 'free' }, 'free-budget');
    expect((reply.body as { report: { communitySource: string } }).report.communitySource).toBe('skipped');
    expect(calls.some((url) => url.includes('/api/twitter'))).toBe(false);
    expect(calls.some((url) => url.includes('gopluslabs'))).toBe(true);
    resetLimits();
  });
});

describe('the hourly limit', () => {
  it('allows 60 scans an hour on every plan, counting answers from the cache', async () => {
    const { resetLimits } = await import('./api');
    resetLimits();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const token = tokenWithX(401);
    for (let i = 0; i < 60; i++) expect((await handleScan({ ...token, plan: 'ultra' }, 'hourly')).status).toBe(200);
    expect((await handleScan({ ...token, plan: 'ultra' }, 'hourly')).status).toBe(429);
    resetLimits();
  });
});
