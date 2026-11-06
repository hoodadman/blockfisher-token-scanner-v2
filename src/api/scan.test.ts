import { afterEach, describe, expect, it, vi } from 'vitest';
import { coingeckoContractUrl } from '../adapters/coingecko';
import { withApiHosts, type ApiHosts } from './hosts';
import { lookupToken } from './lookup';
import { capAlert, runScan } from './scan';

const EVM = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';

const hosts: ApiHosts = {
  insightx: 'http://scanner.test/api/insightx',
  twitter: 'http://scanner.test/api/twitter',
  coingecko: 'http://scanner.test/api/coingecko',
  summarise: 'http://scanner.test/api/summarise',
  socials: 'http://scanner.test/api/socials',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runScan', () => {
  it('rejects a value that is not a contract address', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await runScan('not an address', hosts);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/token address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends holder checks through the supplied host', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dexscreener.com')) {
        return Response.json([
          {
            chainId: 'ethereum',
            baseToken: { address: EVM, name: 'Pepe', symbol: 'PEPE' },
            quoteToken: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', name: 'WETH', symbol: 'WETH' },
            liquidity: { usd: 10 },
          },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await withApiHosts(hosts, () => lookupToken(EVM).catch(() => undefined));

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.startsWith('http://scanner.test/api/insightx/'))).toBe(true);
    expect(coingeckoContractUrl('eth', EVM)).toMatch(/^\/api\/coingecko\//);
  });
});

describe('capAlert', () => {
  const NOW = Date.UTC(2026, 10, 5, 12);
  const checks = (left: number) => ({ used: 30 - left, limit: 30, left, resetsAt: Date.UTC(2026, 11, 1) });

  it('stays away while fresh checks are left', () => {
    expect(capAlert({ plan: 'pro', communitySource: 'fetched', checked: {}, capped: false }, checks(3), NOW)).toBeUndefined();
  });

  it('says how old the saved result is, that Security ran fresh, and when checks reset', () => {
    const alert = capAlert({ plan: 'pro', communitySource: 'library', checked: { community: NOW - 3 * 86_400_000 }, capped: true }, checks(0), NOW);
    expect(alert).toBe(
      'You’ve used all 30 of this month’s fresh community checks. Community and Foundation are from a saved scan 3 days old. Security still runs fresh on every scan. Your checks reset on 1 December.',
    );
  });

  it('shows on a scan from a recent saved result too, once none are left', () => {
    expect(capAlert({ plan: 'ultra', communitySource: 'library', checked: { community: NOW }, capped: false }, checks(0), NOW)).toMatch(/show the latest saved scan/);
  });
});
