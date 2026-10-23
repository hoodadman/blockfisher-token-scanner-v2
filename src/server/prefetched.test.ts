import { describe, expect, it } from 'vitest';
import { parsePrefetched } from './prefetched';

describe('parsePrefetched', () => {
  it('keeps only the fields the scanner reads, with the right types', () => {
    const parsed = parsePrefetched({
      pairs: [
        { chainId: 'ethereum', baseToken: { address: '0xabc', name: 7 }, liquidity: { usd: '9' }, info: { websites: [{ url: 'https://x.io' }], socials: [{ type: 'twitter', url: 'https://x.com/a' }] }, extra: 1 },
        { chainId: 5 },
        'nope',
      ],
    });
    expect(parsed.pairs).toEqual([
      {
        chainId: 'ethereum',
        baseToken: { address: '0xabc', name: undefined, symbol: undefined },
        quoteToken: undefined,
        liquidity: { usd: undefined },
        pairCreatedAt: undefined,
        info: { websites: [{ url: 'https://x.io' }], socials: [{ type: 'twitter', platform: undefined, url: 'https://x.com/a', handle: undefined }] },
      },
    ]);
    expect(parsed.coingecko).toBeUndefined();
  });

  it('caps how many pairs it accepts', () => {
    const parsed = parsePrefetched({ pairs: Array.from({ length: 50 }, () => ({ chainId: 'base' })) });
    expect(parsed.pairs).toHaveLength(30);
  });
});
