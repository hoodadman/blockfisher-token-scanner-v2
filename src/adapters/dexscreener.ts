import type { TokenSignals } from '../scoring';
import { compact, isNumber } from './util';

interface DexScreenerToken {
  address?: string;
  name?: string;
  symbol?: string;
}

/**
 * The fields we read from each pair returned by
 * GET https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}.
 * DexScreener has no contract-security data, only market data.
 */
export interface DexScreenerPair {
  chainId: string;
  baseToken?: DexScreenerToken;
  quoteToken?: DexScreenerToken;
  liquidity?: { usd?: number | null } | null;
  pairCreatedAt?: number | null;
  info?: {
    websites?: readonly unknown[] | null;
    socials?: readonly DexScreenerSocial[] | null;
  } | null;
}

export interface DexScreenerSocial {
  type?: string;
  platform?: string;
  url?: string;
  handle?: string;
}

export function signalsFromDexScreener(pairs: readonly DexScreenerPair[]): Partial<TokenSignals> {
  if (pairs.length === 0) return {};
  const liquidity = pairs.map((pair) => pair.liquidity?.usd).filter(isNumber);
  const created = pairs.map((pair) => pair.pairCreatedAt).filter(isNumber);

  return compact({
    liquidityUsd: liquidity.length ? Math.max(...liquidity) : undefined,
    launchedAt: created.length ? Math.min(...created) : undefined,
    hasWebsiteOrSocials: pairs.some((pair) => (pair.info?.websites?.length ?? 0) + (pair.info?.socials?.length ?? 0) > 0),
  });
}

/**
 * DexScreener puts a pair's links (X, website, Telegram) on the pair's main token. When our
 * token is the other side, such as USDT in a NEWCOIN/USDT pair, those links belong to
 * NEWCOIN, so they are dropped here. Liquidity and age still count from every pair.
 */
export function ownLinksOnly(pairs: readonly DexScreenerPair[], address: string): DexScreenerPair[] {
  const wanted = address.toLowerCase();
  return pairs.map((pair) => (pair.baseToken?.address?.toLowerCase() === wanted ? pair : { ...pair, info: null }));
}

/** A token can be either side of a pair, so match on its address. */
export function tokenFromDexScreener(pairs: readonly DexScreenerPair[], address: string): { name?: string; symbol?: string } {
  const wanted = address.toLowerCase();
  for (const pair of pairs) {
    const token = [pair.baseToken, pair.quoteToken].find((side) => side?.address?.toLowerCase() === wanted);
    if (token) return { name: token.name, symbol: token.symbol };
  }
  return {};
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** Pulls the first Twitter / X handle from DexScreener social links. */
export function twitterHandleFromDexScreener(pairs: readonly DexScreenerPair[]): string | undefined {
  for (const pair of pairs) {
    for (const social of pair.info?.socials ?? []) {
      const handle = handleFromSocial(social);
      if (handle) return handle;
    }
  }
  return undefined;
}

export function handleFromSocial(social: DexScreenerSocial): string | undefined {
  const kind = (social.type ?? social.platform ?? '').toLowerCase();
  if (kind && kind !== 'twitter' && kind !== 'x') return undefined;
  const fromField = social.handle?.replace(/^@/, '').trim();
  if (fromField && HANDLE.test(fromField)) return fromField;
  return handleFromUrl(social.url);
}

export function websitesFromDexScreener(pairs: readonly DexScreenerPair[]): string[] {
  const urls = new Set<string>();
  for (const pair of pairs) {
    for (const site of pair.info?.websites ?? []) {
      const url = typeof site === 'string' ? site : site && typeof site === 'object' && 'url' in site ? String((site as { url?: unknown }).url ?? '') : '';
      if (url.startsWith('http')) urls.add(url);
    }
  }
  return [...urls];
}

export function handleFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!/^(www\.)?(twitter|x)\.com$/i.test(parsed.hostname)) return undefined;
    const [first, second] = parsed.pathname.split('/').filter(Boolean);
    // A link to a post (x.com/<who>/status/<id>) names whoever wrote it, often a caller
    // promoting the token rather than the project itself.
    if (second?.toLowerCase() === 'status') return undefined;
    if (!first || ['i', 'intent', 'share', 'search', 'home'].includes(first.toLowerCase())) return undefined;
    const handle = first.replace(/^@/, '');
    return HANDLE.test(handle) ? handle : undefined;
  } catch {
    return undefined;
  }
}
