import {
  buildSignals,
  coingeckoContractUrl,
  exchangeIdsFromCoinGecko,
  goPlusChainId,
  tokenFromDexScreener,
  tokenFromGoPlus,
  twitterHandleFromDexScreener,
  websitesFromDexScreener,
  type CoinGeckoCoin,
  type DexScreenerPair,
  type GoPlusEvmToken,
  type GoPlusResponse,
  type GoPlusSolanaToken,
  type InsightXDexMetrics,
  type InsightXNetwork,
} from '../adapters';
import { scoreCommunity, type CommunityReport } from '../community';
import { scoreFoundation, type FoundationReport } from '../foundation';
import type { TokenSignals } from '../scoring';
import { apiHosts } from './hosts';
import { SHARE_HEADER, savedAt, shareSeconds } from './share';
import { communityFromBundle, fetchTwitterBundle, TwitterError } from './twitter';

export interface Chain {
  name: string;
  dexScreenerId: string;
  network: InsightXNetwork;
}

const EVM_CHAINS: readonly Chain[] = [
  { name: 'Ethereum', dexScreenerId: 'ethereum', network: 'eth' },
  { name: 'Base', dexScreenerId: 'base', network: 'base' },
  { name: 'BNB Chain', dexScreenerId: 'bsc', network: 'bsc' },
];

const SOLANA_CHAINS: readonly Chain[] = [{ name: 'Solana', dexScreenerId: 'solana', network: 'sol' }];

export const SUPPORTED_CHAINS: readonly Chain[] = [...EVM_CHAINS, ...SOLANA_CHAINS];

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const DEXSCREENER = 'https://api.dexscreener.com';
const GOPLUS = 'https://api.gopluslabs.io';
/** Our own server forwards this to InsightX and adds the API key (see vite.config.ts). */
/** Long waits make the whole scan feel broken; a slow source is reported as not checked instead. */
const TIMEOUT_MS = 12_000;

function chainsFor(address: string, network?: InsightXNetwork): readonly Chain[] {
  if (network) {
    const chain = SUPPORTED_CHAINS.find((item) => item.network === network);
    const family = network === 'sol' ? SOLANA_ADDRESS : EVM_ADDRESS;
    return chain && family.test(address) ? [chain] : [];
  }
  if (EVM_ADDRESS.test(address)) return EVM_CHAINS;
  if (SOLANA_ADDRESS.test(address)) return SOLANA_CHAINS;
  return [];
}

export const isTokenAddress = (input: string): boolean => chainsFor(input.trim()).length > 0;

export type LookupFailure = 'invalid' | 'not-found' | 'unavailable';

export class LookupError extends Error {
  readonly reason: LookupFailure;
  /** The chains we looked on. */
  readonly searched: readonly Chain[];

  constructor(reason: LookupFailure, searched: readonly Chain[] = []) {
    super(`Token lookup failed: ${reason}`);
    this.name = 'LookupError';
    this.reason = reason;
    this.searched = searched;
  }
}

export interface SourceFailure {
  source: 'scan' | 'holders' | 'community';
  /** HTTP status, when the API answered with an error. */
  status?: number;
}

export interface TokenLookup {
  address: string;
  chain: Chain;
  name?: string;
  symbol?: string;
  twitter?: string;
  signals: TokenSignals;
  community?: CommunityReport;
  foundation: FoundationReport;
  /** Requests that failed. Their checks show up under "Couldn’t check". */
  failures: SourceFailure[];
  /** When shared answers were fetched (ms), when they came from our server's store. */
  checked: { community?: number; holders?: number };
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal, share?: { seconds: number; at?: number }): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    headers: { accept: '*/*', ...(share ? { [SHARE_HEADER]: String(share.seconds) } : {}) },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new HttpError(response.status);
  if (share) share.at = savedAt(response);
  return (await response.json()) as T;
}

const deepestPool = (pairs: readonly DexScreenerPair[]) => Math.max(0, ...pairs.map((pair) => pair.liquidity?.usd ?? 0));

function goPlusUrl(chain: Chain, address: string): string {
  return chain.network === 'sol'
    ? `${GOPLUS}/api/v1/solana/token_security?contract_addresses=${address}`
    : `${GOPLUS}/api/v1/token_security/${goPlusChainId(chain.network)}?contract_addresses=${address}`;
}

async function fetchGoPlus(chain: Chain, address: string, signal?: AbortSignal) {
  const body = await getJson<GoPlusResponse<GoPlusEvmToken | GoPlusSolanaToken>>(goPlusUrl(chain, address), signal);
  if (body.code !== 1) throw new HttpError(body.code ?? 500);
  const token = tokenFromGoPlus(body.result, address);
  if (!token) throw new HttpError(404);
  return token;
}

/**
 * Market data the caller already fetched. The Chrome extension fetches DexScreener and
 * CoinGecko from the user's browser, because both rate-limit shared server addresses.
 */
export interface Prefetched {
  /** DexScreener pairs for the token on `network`. */
  pairs?: DexScreenerPair[];
  coingecko?: CoinGeckoCoin;
}

/**
 * Finds the token on DexScreener, then runs GoPlus security checks on the chain
 * where it trades most (or on `network`, when the caller already knows the chain).
 * Holder analysis still comes from InsightX when the key is set.
 */
export async function lookupToken(
  input: string,
  signal?: AbortSignal,
  network?: InsightXNetwork,
  prefetched: Prefetched = {},
  /** A re-check: don't use shared answers. */
  fresh = false,
): Promise<TokenLookup> {
  const address = input.trim();
  const chains = chainsFor(address, network);
  if (chains.length === 0) throw new LookupError('invalid');

  const wanted = address.toLowerCase();
  const givenFor = (chain: Chain) =>
    network
      ? prefetched.pairs?.filter(
          (pair) =>
            pair.chainId === chain.dexScreenerId &&
            (pair.baseToken?.address?.toLowerCase() === wanted || pair.quoteToken?.address?.toLowerCase() === wanted),
        )
      : undefined;
  const listings = await Promise.allSettled(
    chains.map((chain) => {
      const given = givenFor(chain);
      return given?.length
        ? Promise.resolve(given)
        : getJson<DexScreenerPair[]>(`${DEXSCREENER}/token-pairs/v1/${chain.dexScreenerId}/${address}`, signal);
    }),
  );
  signal?.throwIfAborted();

  const found = chains.flatMap((chain, i) => {
    const listing = listings[i];
    return listing.status === 'fulfilled' && Array.isArray(listing.value) && listing.value.length > 0
      ? [{ chain, pairs: listing.value }]
      : [];
  });
  if (found.length === 0) {
    throw new LookupError(listings.some((listing) => listing.status === 'rejected') ? 'unavailable' : 'not-found', chains);
  }
  const { chain, pairs } = found.reduce((best, next) => (deepestPool(next.pairs) > deepestPool(best.pairs) ? next : best));
  const identity = tokenFromDexScreener(pairs, address);
  const twitter = twitterHandleFromDexScreener(pairs);
  const launchedAt = buildSignals(chain.network, { dexScreenerPairs: pairs }).launchedAt;
  const holderShare: { seconds: number; at?: number } = { seconds: shareSeconds('holders', launchedAt, fresh) };

  // GoPlus runs on every scan: security is what changes fastest when a token is rugged.
  const [scan, holders, twitterBundle, gecko] = await Promise.allSettled([
    fetchGoPlus(chain, address, signal),
    getJson<InsightXDexMetrics>(`${apiHosts().insightx}/dex-metrics/v1/${chain.network}/${address}`, signal, holderShare),
    fetchTwitterBundle({ handle: twitter, name: identity.name, symbol: identity.symbol }, signal, shareSeconds('community', launchedAt, fresh)),
    prefetched.coingecko ? Promise.resolve(prefetched.coingecko) : getJson<CoinGeckoCoin>(coingeckoContractUrl(chain.network, address), signal),
  ]);
  signal?.throwIfAborted();

  const failures: SourceFailure[] = [];
  if (scan.status === 'rejected') failures.push(failureFrom('scan', scan.reason));
  if (holders.status === 'rejected') failures.push(failureFrom('holders', holders.reason));
  if (twitterBundle.status === 'rejected') failures.push(failureFrom('community', twitterBundle.reason));

  const signals = buildSignals(chain.network, {
    dexScreenerPairs: pairs,
    goPlus: scan.status === 'fulfilled' ? scan.value : undefined,
    insightXDexMetrics: holders.status === 'fulfilled' ? holders.value : undefined,
  });
  const bundle = twitterBundle.status === 'fulfilled' ? twitterBundle.value : undefined;

  return {
    address,
    chain,
    ...identity,
    twitter,
    signals,
    community: bundle ? communityFromBundle(bundle) : scoreCommunity({}),
    foundation: scoreFoundation({
      launchedAt: signals.launchedAt,
      websites: websitesFromDexScreener(pairs),
      bio: bundle?.profile?.bio,
      urls: bundle?.profile?.urls,
      mentionedPeople: bundle?.mentionedPeople,
      exchangeHints: gecko.status === 'fulfilled' ? exchangeIdsFromCoinGecko(gecko.value) : [],
    }),
    failures,
    checked: {
      community: bundle?.checkedAt,
      holders: holders.status === 'fulfilled' ? holderShare.at : undefined,
    },
  };
}

function failureFrom(source: SourceFailure['source'], reason: unknown): SourceFailure {
  if (reason instanceof HttpError || reason instanceof TwitterError) return { source, status: reason.status };
  return { source };
}
