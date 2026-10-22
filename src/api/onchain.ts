import type { EvmContractRead, InsightXNetwork, OnChainRead, SolanaMintAccount } from '../adapters';
import { apiHosts } from './hosts';

const TIMEOUT_MS = 10_000;

// Storage slots where standard upgradeable proxies keep the address of the code they run.
const PROXY_SLOTS = [
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', // EIP-1967 implementation
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', // EIP-1967 beacon
  '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7', // EIP-1822 (UUPS)
  '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3', // OpenZeppelin legacy
];

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
  return {
    code,
    owner: owner ?? (await callForAddress(network, address, GET_OWNER, signal)),
    proxySlots: slots.filter((word) => !isEmptyWord(word)),
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
