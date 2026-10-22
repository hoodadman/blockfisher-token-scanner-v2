import type { DexScreenerPair, InsightXNetwork } from '../adapters';
import { apiHosts } from './hosts';

/**
 * Turns what the extension found on a page into tokens we can scan.
 * A candidate is a contract (or pair) address, or a CoinGecko coin id taken from a coingecko.com URL.
 */
export type Candidate =
  | {
      address: string;
      /** Set when the page told us the chain and we support it. */
      network?: InsightXNetwork;
      /** DexScreener's chain id from the page URL, for chains we may not support (arbitrum, ...). */
      chainId?: string;
    }
  | { coingeckoId: string };

export type IdentifyStatus = 'token' | 'unsupported-chain' | 'not-a-contract' | 'not-found';

export interface IdentifiedToken {
  /** The address or CoinGecko id we were sent. */
  input: string;
  status: IdentifyStatus;
  address?: string;
  network?: InsightXNetwork;
  chainName?: string;
  name?: string;
  symbol?: string;
  liquidityUsd?: number;
  /** Plain-language reason, for anything that isn't a scannable token. */
  message?: string;
}

export const MAX_CANDIDATES = 5;

const DEXSCREENER = 'https://api.dexscreener.com';
const TIMEOUT_MS = 15_000;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CHAIN_ID = /^[a-z0-9-]{2,32}$/;
const COINGECKO_ID = /^[a-z0-9-]{1,100}$/;

const NETWORK_BY_DEXSCREENER: Record<string, InsightXNetwork> = {
  ethereum: 'eth',
  base: 'base',
  bsc: 'bsc',
  solana: 'sol',
};

const DEXSCREENER_BY_NETWORK: Record<InsightXNetwork, string> = {
  eth: 'ethereum',
  base: 'base',
  bsc: 'bsc',
  sol: 'solana',
};

const CHAIN_NAME: Record<InsightXNetwork, string> = {
  eth: 'Ethereum',
  base: 'Base',
  bsc: 'BNB Chain',
  sol: 'Solana',
};

/** CoinGecko platform ids, in the order we prefer when a coin lives on several chains. */
const NETWORK_BY_COINGECKO: ReadonlyArray<[string, InsightXNetwork]> = [
  ['ethereum', 'eth'],
  ['solana', 'sol'],
  ['base', 'base'],
  ['binance-smart-chain', 'bsc'],
];

interface CoinGeckoCoinDetail {
  name?: string;
  symbol?: string;
  platforms?: Record<string, string | null> | null;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new HttpError(response.status);
  return (await response.json()) as T;
}

const prettyChain = (chainId: string) =>
  chainId
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** Checks the shape of a request body and drops anything we can't use. */
export function parseCandidates(body: unknown): Candidate[] | null {
  const list = (body as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CANDIDATES) return null;
  const out: Candidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const raw = item as Record<string, unknown>;
    if (typeof raw.coingeckoId === 'string' && COINGECKO_ID.test(raw.coingeckoId)) {
      out.push({ coingeckoId: raw.coingeckoId });
      continue;
    }
    if (typeof raw.address !== 'string') return null;
    const address = raw.address.trim();
    if (!EVM_ADDRESS.test(address) && !SOLANA_ADDRESS.test(address)) return null;
    const network = typeof raw.network === 'string' && raw.network in CHAIN_NAME ? (raw.network as InsightXNetwork) : undefined;
    const chainId = typeof raw.chainId === 'string' && CHAIN_ID.test(raw.chainId) ? raw.chainId : undefined;
    out.push({ address, network, chainId });
  }
  return out;
}

function matchingSide(pair: DexScreenerPair, address: string) {
  const wanted = address.toLowerCase();
  return [pair.baseToken, pair.quoteToken].find((side) => side?.address?.toLowerCase() === wanted);
}

function fromPairs(address: string, pairs: readonly DexScreenerPair[], preferredChain?: string): IdentifiedToken | null {
  const mine = pairs.filter((pair) => matchingSide(pair, address));
  if (mine.length === 0) return null;

  const byChain = new Map<string, DexScreenerPair[]>();
  for (const pair of mine) byChain.set(pair.chainId, [...(byChain.get(pair.chainId) ?? []), pair]);
  const depth = (list: readonly DexScreenerPair[]) => Math.max(0, ...list.map((pair) => pair.liquidity?.usd ?? 0));
  const chainId =
    preferredChain && byChain.has(preferredChain)
      ? preferredChain
      : [...byChain.entries()].reduce((best, next) => (depth(next[1]) > depth(best[1]) ? next : best))[0];
  const chainPairs = byChain.get(chainId) ?? [];
  const side = matchingSide(chainPairs[0], address);
  const network = NETWORK_BY_DEXSCREENER[chainId];
  const liquidity = depth(chainPairs);
  const base = {
    input: address,
    address: side?.address ?? address,
    name: side?.name,
    symbol: side?.symbol,
    liquidityUsd: liquidity > 0 ? liquidity : undefined,
  };
  if (!network) {
    return {
      ...base,
      status: 'unsupported-chain',
      chainName: prettyChain(chainId),
      message: `We can't check tokens on ${prettyChain(chainId)} yet.`,
    };
  }
  return { ...base, status: 'token', network, chainName: CHAIN_NAME[network] };
}

async function identifyPairAddress(address: string, chainId: string, signal?: AbortSignal): Promise<IdentifiedToken | null> {
  try {
    const body = await getJson<{ pairs?: DexScreenerPair[] | null }>(`${DEXSCREENER}/latest/dex/pairs/${chainId}/${address}`, signal);
    const pair = body.pairs?.[0];
    const token = pair?.baseToken?.address;
    if (!pair || !token) return null;
    const found = fromPairs(token, [pair], chainId);
    return found ? { ...found, input: address } : null;
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
}

async function identifyAddresses(
  candidates: ReadonlyArray<{ address: string; network?: InsightXNetwork; chainId?: string }>,
  signal?: AbortSignal,
): Promise<IdentifiedToken[]> {
  if (candidates.length === 0) return [];
  const joined = candidates.map((item) => item.address).join(',');
  const body = await getJson<{ pairs?: DexScreenerPair[] | null }>(`${DEXSCREENER}/latest/dex/tokens/${joined}`, signal);
  const pairs = body.pairs ?? [];

  return Promise.all(
    candidates.map(async (candidate) => {
      const preferred = candidate.network ? DEXSCREENER_BY_NETWORK[candidate.network] : candidate.chainId;
      const asToken = fromPairs(candidate.address, pairs, preferred);
      if (asToken) return asToken;
      // DexScreener URLs usually carry the pair address, not the token.
      const asPair = preferred ? await identifyPairAddress(candidate.address, preferred, signal) : null;
      if (asPair) return asPair;
      return {
        input: candidate.address,
        status: 'not-found' as const,
        message: 'This address does not trade anywhere we can see. It may be a wallet rather than a token.',
      };
    }),
  );
}

async function identifyCoinGecko(id: string, signal?: AbortSignal): Promise<IdentifiedToken[]> {
  let coin: CoinGeckoCoinDetail;
  try {
    coin = await getJson<CoinGeckoCoinDetail>(
      `${apiHosts().coingecko}/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`,
      signal,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return [{ input: id, status: 'not-found', message: 'CoinGecko does not list this coin.' }];
    }
    throw error;
  }
  const platforms = Object.entries(coin.platforms ?? {}).filter(
    (entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === 'string' && entry[1].length > 0,
  );
  const base = { input: id, name: coin.name, symbol: coin.symbol?.toUpperCase() };
  const label = coin.name ?? id;

  if (platforms.length === 0) {
    return [
      {
        ...base,
        status: 'not-a-contract',
        message: `${label} is a coin with its own blockchain, not a token contract, so there is nothing to check.`,
      },
    ];
  }
  const supported = NETWORK_BY_COINGECKO.flatMap(([platform, network]) => {
    const address = platforms.find(([key]) => key === platform)?.[1];
    return address ? [{ ...base, status: 'token' as const, address, network, chainName: CHAIN_NAME[network] }] : [];
  });
  if (supported.length > 0) return supported;
  const chainName = prettyChain(platforms[0][0]);
  return [{ ...base, status: 'unsupported-chain', chainName, message: `We can't check tokens on ${chainName} yet.` }];
}

/** Throws on network failure so the server can answer 502. */
export async function identify(candidates: readonly Candidate[], signal?: AbortSignal): Promise<IdentifiedToken[]> {
  const addresses = candidates.filter((item): item is Extract<Candidate, { address: string }> => 'address' in item);
  const coins = candidates.filter((item): item is Extract<Candidate, { coingeckoId: string }> => 'coingeckoId' in item);
  const [fromAddresses, ...fromCoins] = await Promise.all([
    identifyAddresses(addresses, signal),
    ...coins.map((coin) => identifyCoinGecko(coin.coingeckoId, signal)),
  ]);
  return [...fromAddresses, ...fromCoins.flat()];
}
