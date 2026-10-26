import type { DexScreenerPair } from '../adapters';
import type { PlanId } from '../plans/plans';
import { LookupError, chainsFor, type Chain } from './lookup';
import type { ScanReport } from './scan';

/**
 * The website's scan: the browser finds the token on DexScreener (which rate-limits our
 * server's shared address), then our server runs the scan for the chosen plan, the same
 * way it does for the extension. Plans, the library and the limits all live on the server.
 */
const DEXSCREENER = 'https://api.dexscreener.com';

const deepestPool = (pairs: readonly DexScreenerPair[]) => Math.max(0, ...pairs.map((pair) => pair.liquidity?.usd ?? 0));

async function findListing(address: string, signal?: AbortSignal): Promise<{ chain: Chain; pairs: DexScreenerPair[] }> {
  const chains = chainsFor(address);
  if (chains.length === 0) throw new LookupError('invalid');
  const listings = await Promise.allSettled(
    chains.map(async (chain) => {
      const response = await fetch(`${DEXSCREENER}/token-pairs/v1/${chain.dexScreenerId}/${address}`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as DexScreenerPair[];
    }),
  );
  signal?.throwIfAborted();
  const found = chains.flatMap((chain, i) => {
    const listing = listings[i];
    return listing.status === 'fulfilled' && Array.isArray(listing.value) && listing.value.length > 0 ? [{ chain, pairs: listing.value }] : [];
  });
  if (found.length === 0) {
    throw new LookupError(listings.some((listing) => listing.status === 'rejected') ? 'unavailable' : 'not-found', chains);
  }
  return found.reduce((best, next) => (deepestPool(next.pairs) > deepestPool(best.pairs) ? next : best));
}

/** A scan the server turned down (a limit, or Re-check on Free), with its message. */
export class ScanRefused extends Error {}

export async function scanOnServer(address: string, plan: PlanId, refresh = false, signal?: AbortSignal): Promise<ScanReport> {
  const { chain, pairs } = await findListing(address.trim(), signal);
  const response = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: address.trim(), network: chain.network, pairs, plan, refresh }),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; text?: string; report?: ScanReport };
  if (!response.ok || !body.ok || !body.report) {
    if (response.status === 422) throw new LookupError('not-found', [chain]);
    throw new ScanRefused(body.text ?? 'The scan failed. Try again in a minute.');
  }
  return body.report;
}
