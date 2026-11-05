import { afterEach, describe, expect, it } from 'vitest';
import { dexLinksFor, type DexScreenerPair } from '../adapters';
import { memoryLibrary, readLibrary, setLibraryStore, writeLibrary } from '../plans/library';
import { searchQuery, type TwitterBundle } from './twitter';

const TOKEN = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const POOL = '0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f';
const SOL = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

const pair = (over: Partial<DexScreenerPair> = {}): DexScreenerPair => ({
  chainId: 'ethereum',
  pairAddress: POOL,
  baseToken: { address: TOKEN, name: 'Pepe', symbol: 'PEPE' },
  liquidity: { usd: 1_000 },
  ...over,
});

describe('dexLinksFor', () => {
  it('links the token page and its deepest pool', () => {
    const deeper = '0x11950d141EcB863F01007AdD7D1A342041227b58';
    expect(dexLinksFor([pair(), pair({ pairAddress: deeper, liquidity: { usd: 9_000 } })], TOKEN)).toEqual({
      token: `https://dexscreener.com/ethereum/${TOKEN}`,
      pair: `https://dexscreener.com/ethereum/${deeper}`,
    });
  });

  it('never builds a link from a malformed pool address', () => {
    expect(dexLinksFor([pair({ pairAddress: 'evil.com/x' })], TOKEN)).toEqual({ token: `https://dexscreener.com/ethereum/${TOKEN}` });
  });
});

describe('searchQuery', () => {
  it('also finds posts with the contract address or a link to the pool', () => {
    const query = searchQuery({ symbol: 'PEPE', name: 'Pepe', handle: 'pepecoineth', address: TOKEN, dexPair: `https://dexscreener.com/ethereum/${POOL}` });
    expect(query).toBe(
      `($PEPE OR #PEPE OR ${TOKEN} OR url:${TOKEN} OR "Pepe" OR url:"dexscreener.com/ethereum/${POOL}") -is:retweet -from:pepecoineth`,
    );
  });

  it('keeps Solana addresses as they are and stays inside X\'s 512 characters', () => {
    const query = searchQuery({ symbol: 'X'.repeat(200), name: 'A long name that is still forty chars', address: SOL, dexPair: `https://dexscreener.com/solana/${SOL}` })!;
    expect(query).toContain(SOL);
    expect(query.length).toBeLessThanOrEqual(512);
  });

  it('leaves out anything that is not an address', () => {
    expect(searchQuery({ symbol: 'PEPE', address: 'x OR url:evil' })).toBe('($PEPE OR #PEPE) -is:retweet');
  });
});

describe('saved X data names its token', () => {
  afterEach(() => setLibraryStore(memoryLibrary()));
  const bundle: TwitterBundle = { tweets: [], mentions: [], mentionedPeople: [] };

  it('saves the chain, address and DEX links with the X data', async () => {
    setLibraryStore(memoryLibrary());
    const dex = dexLinksFor([pair()], TOKEN);
    await writeLibrary('eth', TOKEN, 'pro', { savedAt: 1, plan: 'pro', bundle, token: { network: 'eth', address: TOKEN, dex } });
    const shelf = await readLibrary('eth', TOKEN);
    expect(shelf.pro?.token).toEqual({ network: 'eth', address: TOKEN, dex });
  });

  it('never returns an entry saved for a different token', async () => {
    const store = memoryLibrary();
    setLibraryStore(store);
    const other = '0x0000000000000000000000000000000000000001';
    await store.set(`eth:${TOKEN.toLowerCase()}:pro`, JSON.stringify({ savedAt: 1, plan: 'pro', bundle, token: { network: 'eth', address: other } }));
    expect(await readLibrary('eth', TOKEN)).toEqual({});
  });

  it('still reads entries saved before tokens were recorded', async () => {
    setLibraryStore(memoryLibrary());
    await writeLibrary('eth', TOKEN, 'pro', { savedAt: 1, plan: 'pro', bundle });
    expect((await readLibrary('eth', TOKEN)).pro?.bundle).toEqual(bundle);
  });
});
