import type { CoinGeckoCoin, DexScreenerPair, DexScreenerSocial } from '../adapters';
import type { Prefetched } from '../api/lookup';

/**
 * The extension sends DexScreener pairs and CoinGecko tickers it fetched in the user's
 * browser. Keep only the fields the scanner reads, with the right types, so a crafted
 * body can't feed it anything else.
 */

const MAX_PAIRS = 30;
const MAX_TICKERS = 200;
const MAX_LINKS = 10;

const text = (value: unknown, max = 300): string | undefined => (typeof value === 'string' && value.length <= max ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);

function token(value: unknown) {
  const raw = record(value);
  return raw ? { address: text(raw.address, 64), name: text(raw.name, 120), symbol: text(raw.symbol, 40) } : undefined;
}

function social(value: unknown): DexScreenerSocial | undefined {
  const raw = record(value);
  return raw ? { type: text(raw.type, 40), platform: text(raw.platform, 40), url: text(raw.url), handle: text(raw.handle, 60) } : undefined;
}

function pair(value: unknown): DexScreenerPair | undefined {
  const raw = record(value);
  const chainId = text(raw?.chainId, 40);
  if (!raw || !chainId) return undefined;
  const info = record(raw.info);
  return {
    chainId,
    baseToken: token(raw.baseToken),
    quoteToken: token(raw.quoteToken),
    liquidity: { usd: number(record(raw.liquidity)?.usd) },
    pairCreatedAt: number(raw.pairCreatedAt),
    info: info
      ? {
          websites: list(info.websites, MAX_LINKS).map((site) => (typeof site === 'string' ? text(site) : { url: text(record(site)?.url) })).filter(Boolean),
          socials: list(info.socials, MAX_LINKS).map(social).filter((item): item is DexScreenerSocial => Boolean(item)),
        }
      : undefined,
  };
}

function coingecko(value: unknown): CoinGeckoCoin | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  return {
    tickers: list(raw.tickers, MAX_TICKERS).map((ticker) => {
      const market = record(record(ticker)?.market);
      return { market: { name: text(market?.name, 120), identifier: text(market?.identifier, 120) } };
    }),
  };
}

export function parsePrefetched(body: unknown): Prefetched {
  const raw = record(body) ?? {};
  const pairs = list(raw.pairs, MAX_PAIRS)
    .map(pair)
    .filter((item): item is DexScreenerPair => Boolean(item));
  return { pairs: pairs.length > 0 ? pairs : undefined, coingecko: coingecko(raw.coingecko) };
}
