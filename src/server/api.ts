/**
 * The JSON endpoints the Chrome extension calls. server.mjs loads the build of this file
 * (dist-server/api.js) and hands it each request body; this file never touches the socket.
 */
import type { InsightXNetwork } from '../adapters';
import { setApiHosts, type ApiHosts } from '../api/hosts';
import { identify, parseCandidates, type IdentifiedToken } from '../api/identify';
import { LookupError, isTokenAddress } from '../api/lookup';
import { scanErrorText, scanReport, scanText, type ScanReport } from '../api/scan';

export interface ApiReply {
  status: number;
  body: unknown;
}

const NETWORKS: readonly InsightXNetwork[] = ['eth', 'base', 'bsc', 'sol'];

export const SCAN_CACHE_MS = 10 * 60_000;
export const IDENTIFY_CACHE_MS = 10 * 60_000;
const CACHE_LIMIT = 500;

/** A small time-limited cache. Trending tokens get scanned by many people at once. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly limit = CACHE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** Counts requests per client in a fixed window. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resets: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns seconds to wait, or 0 when the request may go ahead. */
  take(client: string): number {
    const now = this.now();
    if (this.windows.size > 10_000) {
      for (const [key, window] of this.windows) if (window.resets <= now) this.windows.delete(key);
    }
    const window = this.windows.get(client);
    if (!window || window.resets <= now) {
      this.windows.set(client, { count: 1, resets: now + this.windowMs });
      return 0;
    }
    if (window.count >= this.max) return Math.ceil((window.resets - now) / 1000);
    window.count += 1;
    return 0;
  }
}

const scans = new TtlCache<ScanReport>(SCAN_CACHE_MS);
const identities = new TtlCache<IdentifiedToken[]>(IDENTIFY_CACHE_MS);
// Cached answers don't count: the limit protects the paid APIs behind a fresh scan.
const scanLimit = new RateLimiter(30, 10 * 60_000);
const identifyLimit = new RateLimiter(120, 10 * 60_000);

export function configure(hosts: ApiHosts): void {
  setApiHosts(hosts);
}

const tooMany = (seconds: number): ApiReply => ({
  status: 429,
  body: { ok: false, text: `Too many scans at once. Try again in ${Math.max(1, Math.ceil(seconds / 60))} minute(s).` },
});

export async function handleScan(body: unknown, client: string): Promise<ApiReply> {
  const raw = (body ?? {}) as { address?: unknown; network?: unknown };
  const address = typeof raw.address === 'string' ? raw.address.trim() : '';
  const network = typeof raw.network === 'string' && (NETWORKS as readonly string[]).includes(raw.network) ? (raw.network as InsightXNetwork) : undefined;
  if (!address) return { status: 400, body: { ok: false, text: 'Send a contract address to scan.' } };
  if (!isTokenAddress(address)) return { status: 422, body: { ok: false, text: scanErrorText(new LookupError('invalid')) } };

  const key = `${network ?? 'any'}:${address.toLowerCase()}`;
  const cached = scans.get(key);
  if (cached) return { status: 200, body: { ok: true, text: scanText(cached), report: cached } };

  const wait = scanLimit.take(client);
  if (wait > 0) return tooMany(wait);
  try {
    const report = await scanReport(address, network);
    scans.set(key, report);
    return { status: 200, body: { ok: true, text: scanText(report), report } };
  } catch (error) {
    const status = error instanceof LookupError ? (error.reason === 'unavailable' ? 502 : 422) : 500;
    return { status, body: { ok: false, text: scanErrorText(error) } };
  }
}

export async function handleIdentify(body: unknown, client: string): Promise<ApiReply> {
  const candidates = parseCandidates(body);
  if (!candidates) {
    return { status: 400, body: { ok: false, text: 'Send up to 5 candidates, each an address or a CoinGecko id.' } };
  }
  const key = JSON.stringify(candidates);
  const cached = identities.get(key);
  if (cached) return { status: 200, body: { ok: true, tokens: cached } };

  const wait = identifyLimit.take(client);
  if (wait > 0) return tooMany(wait);
  try {
    const tokens = await identify(candidates);
    identities.set(key, tokens);
    return { status: 200, body: { ok: true, tokens } };
  } catch {
    return { status: 502, body: { ok: false, text: 'The market data service did not respond. Try again in a minute.' } };
  }
}
