import { afterEach, describe, expect, it, vi } from 'vitest';
import { coingeckoContractUrl } from '../adapters/coingecko';
import { withApiHosts, type ApiHosts } from './hosts';
import { lookupToken } from './lookup';
import { runScan } from './scan';

const EVM = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';

const hosts: ApiHosts = {
  insightx: 'http://scanner.test/api/insightx',
  twitter: 'http://scanner.test/api/twitter',
  coingecko: 'http://scanner.test/api/coingecko',
  summarise: 'http://scanner.test/api/summarise',
  rpc: 'http://scanner.test/api/rpc',
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
