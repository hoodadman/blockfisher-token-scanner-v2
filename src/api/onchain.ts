import type { EvmContractRead, InsightXNetwork, OnChainRead, SellTest, SolanaMintAccount } from '../adapters';
import { apiHosts } from './hosts';
import { PROBE_SELECTOR, SELL_PROBE_CODE } from './sellProbe';

const TIMEOUT_MS = 10_000;

// Storage slots where standard upgradeable proxies keep the address of the code they run.
const PROXY_SLOTS = [
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', // EIP-1967 implementation
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', // EIP-1967 beacon
  '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7', // EIP-1822 (UUPS)
  '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3', // OpenZeppelin legacy
];

// Slots that hold an implementation address directly (the beacon slot holds a beacon, not code).
const IMPLEMENTATION_SLOTS = new Set([PROXY_SLOTS[0], PROXY_SLOTS[2], PROXY_SLOTS[3]]);

const OWNER = '0x8da5cb5b'; // owner()
const GET_OWNER = '0x893d20e8'; // getOwner(), common on BNB Chain tokens

export class RpcError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RpcError';
    this.status = status;
  }
}

/** One JSON-RPC call through our server, which holds the node provider's key. */
async function rpc<T>(network: InsightXNetwork, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(`${apiHosts().rpc}/${network}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new RpcError(`HTTP ${response.status}`, response.status);
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new RpcError(body.error.message ?? 'rpc error');
  return body.result as T;
}

const isEmptyWord = (word: string | undefined) => !word || /^0x0*$/.test(word);

/** The last 20 bytes of a 32-byte return value, or undefined when the call has no usable answer. */
function addressFromWord(word: string | undefined): string | undefined {
  if (!word || word.length !== 66) return undefined;
  return `0x${word.slice(26)}`.toLowerCase();
}

async function callForAddress(network: InsightXNetwork, to: string, data: string, signal?: AbortSignal) {
  try {
    return addressFromWord(await rpc<string>(network, 'eth_call', [{ to, data }, 'latest'], signal));
  } catch (error) {
    // A revert just means the contract has no such function.
    if (error instanceof RpcError && error.status === undefined) return undefined;
    throw error;
  }
}

async function readEvmContract(network: InsightXNetwork, address: string, signal?: AbortSignal): Promise<EvmContractRead> {
  const [code, owner, slots] = await Promise.all([
    rpc<string>(network, 'eth_getCode', [address, 'latest'], signal),
    callForAddress(network, address, OWNER, signal),
    Promise.all(PROXY_SLOTS.map((slot) => rpc<string>(network, 'eth_getStorageAt', [address, slot, 'latest'], signal))),
  ]);
  // Behind a proxy the functions that matter live in the implementation, so scan that code instead.
  const implementation = PROXY_SLOTS.map((slot, i) => (IMPLEMENTATION_SLOTS.has(slot) ? addressFromWord(slots[i]) : undefined)).find(
    (found) => found !== undefined && !isEmptyWord(found),
  );
  return {
    code,
    owner: owner ?? (await callForAddress(network, address, GET_OWNER, signal)),
    proxySlots: slots.filter((word) => !isEmptyWord(word)),
    ...(implementation && { implementationCode: await rpc<string>(network, 'eth_getCode', [implementation, 'latest'], signal) }),
  };
}

async function readSolanaMint(address: string, signal?: AbortSignal): Promise<SolanaMintAccount> {
  const result = await rpc<{ value: { data: SolanaMintAccount } | null }>(
    'sol',
    'getAccountInfo',
    [address, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    signal,
  );
  if (!result?.value) throw new RpcError('account not found', 404);
  return result.value.data;
}

/** Reads the token contract directly from the chain. Rejects when the node can't be reached. */
export async function readOnChain(network: InsightXNetwork, address: string, signal?: AbortSignal): Promise<OnChainRead> {
  return network === 'sol'
    ? { kind: 'solana', mint: await readSolanaMint(address, signal) }
    : { kind: 'evm', contract: await readEvmContract(network, address, signal) };
}

// Uniswap V2 style routers with the most token launches on each chain. The probe asks each for its wrapped coin.
const ROUTERS: Partial<Record<InsightXNetwork, string>> = {
  eth: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2
  base: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', // Uniswap V2
  bsc: '0x10ed43c718714eb63d5aa57b78b54704e256024e', // PancakeSwap V2
};

// Made-up addresses that only exist inside the simulation.
const PROBE = '0x00000000000000000000000000000000005e11a5';
const BUYER = '0x00000000000000000000000000000000005e11b0';
const TEST_AMOUNT = '0x2386f26fc10000'; // 0.01 of the chain's coin
const BUYER_BALANCE = '0xde0b6b3a7640000'; // 1 coin, to cover the test amount

const word = (address: string) => address.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/**
 * Simulates buying a little of the token and selling it straight back, without
 * sending anything. Resolves undefined when the test can't run here (Solana, or
 * no pool on the router); rejects when the node can't be reached.
 */
export async function runSellTest(network: InsightXNetwork, address: string, signal?: AbortSignal): Promise<SellTest | undefined> {
  const router = ROUTERS[network];
  if (!router) return undefined;
  let result: string;
  try {
    result = await rpc<string>(
      network,
      'eth_call',
      [
        { from: BUYER, to: PROBE, value: TEST_AMOUNT, gas: '0x2dc6c0', data: `${PROBE_SELECTOR}${word(router)}${word(address)}` },
        'latest',
        { [PROBE]: { code: SELL_PROBE_CODE }, [BUYER]: { balance: BUYER_BALANCE } },
      ],
      signal,
    );
  } catch (error) {
    // The whole probe reverts when the router has no pool for this token.
    if (error instanceof RpcError && error.status === undefined) return undefined;
    throw error;
  }
  const words = result.replace(/^0x/, '').match(/.{64}/g);
  if (!words || words.length < 5) return undefined;
  const [stage, buyExpected, buyReceived, sellExpected, sellReceived] = words.map((value) => BigInt(`0x${value}`));
  return {
    stage: Number(stage) as SellTest['stage'],
    buyExpected,
    buyReceived,
    sellExpected,
    sellReceived,
  };
}
