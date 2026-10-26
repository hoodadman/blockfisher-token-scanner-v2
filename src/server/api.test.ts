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

  it('says which plan ran, and runs Ultra at Pro depth once its deep scans are used up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    let last: { report: { plan: string; notes: string[] } } | undefined;
    for (let i = 1; i <= 21; i++) {
      // A different token each time, so the result cache doesn't answer.
      const address = `0x${i.toString(16).padStart(40, '0')}`;
      const reply = await handleScan({ address, network: 'eth', plan: 'ultra', pairs: [{ chainId: 'ethereum', baseToken: { address }, liquidity: { usd: 1 } }] }, 'ultra-client');
      last = reply.body as typeof last;
      if (i === 1) expect(last?.report.notes).toEqual([]);
    }
    expect(last?.report.plan).toBe('ultra');
    expect(last?.report.notes.join(' ')).toMatch(/Pro depth/);
  });
});
