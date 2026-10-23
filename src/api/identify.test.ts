import { afterEach, describe, expect, it, vi } from 'vitest';
import { identify, parseCandidates } from './identify';

const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const PAIR = '0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f';
const WALLET = '0x00000000219ab540356cBB839Cbe05303d7705Fa';

function pair(chainId: string, base: string, quote: string, usd: number) {
  return {
    chainId,
    pairAddress: PAIR,
    baseToken: { address: base, name: base === PEPE ? 'Pepe' : 'Other', symbol: base === PEPE ? 'PEPE' : 'OTH' },
    quoteToken: { address: quote, name: 'Wrapped Ether', symbol: 'WETH' },
    liquidity: { usd },
  };
}

function stub(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.keys(routes).find((prefix) => url.includes(prefix));
    return hit ? Response.json(routes[hit]) : new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseCandidates', () => {
  it('accepts addresses and CoinGecko ids', () => {
    expect(parseCandidates({ candidates: [{ address: PEPE, network: 'eth' }, { coingeckoId: 'pepe' }] })).toEqual([
      { address: PEPE, network: 'eth', chainId: undefined },
      { coingeckoId: 'pepe' },
    ]);
  });

  it('rejects empty, oversized and malformed lists', () => {
    expect(parseCandidates({ candidates: [] })).toBeNull();
    expect(parseCandidates({ candidates: Array(6).fill({ address: PEPE }) })).toBeNull();
    expect(parseCandidates({ candidates: [{ address: 'hello' }] })).toBeNull();
    expect(parseCandidates(null)).toBeNull();
  });

  it('drops a network we do not support instead of trusting it', () => {
    expect(parseCandidates({ candidates: [{ address: PEPE, network: 'tron', chainId: 'arbitrum' }] })).toEqual([
      { address: PEPE, network: undefined, chainId: 'arbitrum' },
    ]);
  });
});

describe('identify', () => {
  it('names a token and picks the chain with the deepest pool', async () => {
    stub({ '/latest/dex/tokens/': { pairs: [pair('base', PEPE, WETH, 10), pair('ethereum', PEPE, WETH, 5_000)] } });
    const [token] = await identify([{ address: PEPE }]);
    expect(token).toMatchObject({ status: 'token', network: 'eth', chainName: 'Ethereum', symbol: 'PEPE', liquidityUsd: 5_000 });
  });

  it('keeps the chain the page told us about', async () => {
    stub({ '/latest/dex/tokens/': { pairs: [pair('base', PEPE, WETH, 10), pair('ethereum', PEPE, WETH, 5_000)] } });
    const [token] = await identify([{ address: PEPE, network: 'base' }]);
    expect(token).toMatchObject({ status: 'token', network: 'base' });
  });

  it('turns a DexScreener pair address into its base token', async () => {
    const fetchMock = stub({
      '/latest/dex/tokens/': { pairs: [] },
      '/latest/dex/pairs/ethereum/': { pairs: [pair('ethereum', PEPE, WETH, 900)] },
    });
    const [token] = await identify([{ address: PAIR, chainId: 'ethereum' }]);
    expect(token).toMatchObject({ input: PAIR, status: 'token', address: PEPE, symbol: 'PEPE' });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes(`/pairs/ethereum/${PAIR}`))).toBe(true);
  });

  it('says plainly when a chain is not supported', async () => {
    stub({ '/latest/dex/tokens/': { pairs: [pair('arbitrum', PEPE, WETH, 100)] } });
    const [token] = await identify([{ address: PEPE }]);
    expect(token).toMatchObject({ status: 'unsupported-chain', chainName: 'Arbitrum' });
    expect(token.message).toMatch(/can't check tokens on Arbitrum/);
  });

  it('marks an address with no trading as not found', async () => {
    stub({ '/latest/dex/tokens/': { pairs: [pair('ethereum', PEPE, WETH, 100)] } });
    const [token] = await identify([{ address: WALLET }]);
    expect(token.status).toBe('not-found');
  });

  it('reads contracts from a CoinGecko coin, preferring chains we support', async () => {
    stub({
      '/api/v3/coins/pepe': {
        name: 'Pepe',
        symbol: 'pepe',
        platforms: { ethereum: PEPE, arbitrum: '0x25d887ce7a35172c62febfd67a1856f20faebb00' },
      },
    });
    const tokens = await identify([{ coingeckoId: 'pepe' }]);
    expect(tokens).toEqual([
      expect.objectContaining({ status: 'token', address: PEPE, network: 'eth', symbol: 'PEPE', input: 'pepe' }),
    ]);
  });

  it('explains that a native coin has no contract', async () => {
    stub({ '/api/v3/coins/bitcoin': { name: 'Bitcoin', symbol: 'btc', platforms: { '': '' } } });
    const [token] = await identify([{ coingeckoId: 'bitcoin' }]);
    expect(token.status).toBe('not-a-contract');
    expect(token.message).toMatch(/Bitcoin is a coin with its own blockchain/);
  });
});
