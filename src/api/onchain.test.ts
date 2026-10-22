import { afterEach, describe, expect, it, vi } from 'vitest';
import { readOnChain, runSellTest } from './onchain';
import { PROBE_SELECTOR, SELL_PROBE_CODE } from './sellProbe';

const TOKEN = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const word = (hex: string) => `0x${hex.padStart(64, '0')}`;

/** Answers JSON-RPC calls by method; `owner()` and `getOwner()` are told apart by their call data. */
function node(answer: (method: string, params: unknown[]) => unknown) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    return Response.json({ jsonrpc: '2.0', id: 1, ...(answer(method, params) as object) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readOnChain', () => {
  it('reads code, owner and proxy slots on an EVM chain through our server', async () => {
    const fetchMock = node((method, params) => {
      if (method === 'eth_getCode') return { result: '0x6080' };
      if (method === 'eth_call') return { result: word('1111111111111111111111111111111111111111') };
      if (method === 'eth_getStorageAt' && params[1] === '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc') {
        return { result: word('43506849d7c04f9138d1a2050bbf3a0c054402dd') };
      }
      return { result: word('') };
    });

    const read = await readOnChain('base', TOKEN);

    expect(read).toEqual({
      kind: 'evm',
      contract: {
        code: '0x6080',
        owner: '0x1111111111111111111111111111111111111111',
        proxySlots: [word('43506849d7c04f9138d1a2050bbf3a0c054402dd')],
        implementationCode: '0x6080',
      },
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/rpc/base');
    // The implementation's code is fetched too, so the scan reads the functions the proxy really runs.
    const codeReads = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter((call) => call.method === 'eth_getCode');
    expect(codeReads.map((call) => call.params[0])).toEqual([TOKEN, '0x43506849d7c04f9138d1a2050bbf3a0c054402dd']);
  });

  it('falls back to getOwner() when owner() reverts, and leaves the owner unknown if both do', async () => {
    node((method, params) => {
      if (method === 'eth_getCode') return { result: '0x6080' };
      if (method === 'eth_call') {
        const data = (params[0] as { data: string }).data;
        return data === '0x893d20e8' ? { result: word('2222222222222222222222222222222222222222') } : { error: { message: 'execution reverted' } };
      }
      return { result: '0x' };
    });
    expect(await readOnChain('bsc', TOKEN)).toMatchObject({ contract: { owner: '0x2222222222222222222222222222222222222222', proxySlots: [] } });

    node((method) => (method === 'eth_call' ? { error: { message: 'execution reverted' } } : { result: '0x6080' }));
    const read = await readOnChain('eth', TOKEN);
    expect(read.kind === 'evm' && read.contract.owner).toBeUndefined();
  });

  it('reads a Solana mint as parsed JSON', async () => {
    const mint = { program: 'spl-token', parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null } } };
    node((method) => (method === 'getAccountInfo' ? { result: { value: { data: mint } } } : { error: {} }));
    expect(await readOnChain('sol', SOL)).toEqual({ kind: 'solana', mint });
  });

  it('rejects when the node is down or the mint does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(readOnChain('eth', TOKEN)).rejects.toThrow('HTTP 503');

    node(() => ({ result: { value: null } }));
    await expect(readOnChain('sol', SOL)).rejects.toThrow('account not found');
  });
});

describe('runSellTest', () => {
  it('runs the probe in a simulation with our code and a funded buyer, and decodes what came back', async () => {
    const fetchMock = node(() => ({ result: `0x${[2, 1000, 950, 95, 83].map((n) => n.toString(16).padStart(64, '0')).join('')}` }));

    expect(await runSellTest('bsc', TOKEN)).toEqual({ stage: 2, buyExpected: 1000n, buyReceived: 950n, sellExpected: 95n, sellReceived: 83n });

    const call = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(call.method).toBe('eth_call');
    const [tx, block, overrides] = call.params;
    expect(tx.data).toBe(`${PROBE_SELECTOR}${'10ed43c718714eb63d5aa57b78b54704e256024e'.padStart(64, '0')}${TOKEN.slice(2).toLowerCase().padStart(64, '0')}`);
    expect(block).toBe('latest');
    expect(overrides[tx.to].code).toBe(SELL_PROBE_CODE);
    expect(BigInt(overrides[tx.from].balance)).toBeGreaterThan(BigInt(tx.value));
  });

  it('gives no result on Solana, or when the router has no pool for the token', async () => {
    expect(await runSellTest('sol', SOL)).toBeUndefined();
    node(() => ({ error: { message: 'execution reverted' } }));
    expect(await runSellTest('eth', TOKEN)).toBeUndefined();
  });

  it('rejects when the node is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })));
    await expect(runSellTest('base', TOKEN)).rejects.toThrow('HTTP 502');
  });
});
