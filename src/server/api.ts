/**
 * The JSON endpoints the Chrome extension calls. server.mjs loads the build of this file
 * (dist-server/api.js) and hands it each request body; this file never touches the socket.
 */
import type { InsightXNetwork } from '../adapters';
import { setApiHosts, type ApiHosts } from '../api/hosts';
import { DISCORD_CODE, TELEGRAM_NAME, parseTelegramPage, type ChatCounts } from '../api/chats';
import { identify, parseCandidates, type IdentifiedToken } from '../api/identify';
import { LookupError, isTokenAddress, type LookupOptions, type Prefetched } from '../api/lookup';
import { scanErrorText, scanReport, scanText, type ScanReport } from '../api/scan';
import { parsePrefetched } from './prefetched';
import { DailyBudget } from '../plans/budget';
import { libraryKind, libraryStore, setLibraryStore, type LibraryStore } from '../plans/library';
import { PLANS, PLAN_IDS, atProDepth, planFrom, type Plan, type PlanId } from '../plans/plans';
import { planOf } from '../billing/accounts';
import { accountsFor } from './billing';

export {
  billingHealth,
  configureBilling,
  handleAccount,
  handleBillingConfig,
  handleCheckout,
  handleClaim,
  handlePortal,
  handleRedeem,
  handleSignIn,
  handleSignOut,
  handleWebhook,
} from './billing';

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
const running = new Map<string, Promise<ApiReply>>();
const identities = new TtlCache<IdentifiedToken[]>(IDENTIFY_CACHE_MS);
// Cached answers don't count: the limit protects the paid APIs behind a fresh scan.
const scanLimit = new RateLimiter(30, 10 * 60_000);
// A re-check skips every shared answer, so it costs the most; each plan allows a few.
const refreshLimits = new Map<PlanId, RateLimiter>();
const DAY_MS = 24 * 60 * 60_000;
// Free: basic checks a day. Ultra: deep scans a day. Per client, until accounts exist.
const dailyLimits = new Map<PlanId, RateLimiter>();
const identifyLimit = new RateLimiter(120, 10 * 60_000);

function limiter(limits: Map<PlanId, RateLimiter>, plan: Plan, max: number, windowMs: number): RateLimiter {
  let found = limits.get(plan.id);
  if (!found) {
    found = new RateLimiter(max, windowMs);
    limits.set(plan.id, found);
  }
  return found;
}

/** Default shared daily cap, in dollars, on Free's basic community checks (FREE_COMMUNITY_BUDGET). */
export const FREE_COMMUNITY_BUDGET = 10;
let freeBudget = new DailyBudget(FREE_COMMUNITY_BUDGET, libraryStore);

/**
 * 'open' (the mock Scanner Pro): each request says its plan and gets it.
 * 'off': every request runs as Free, whatever it asks for.
 * 'billing': each request runs on the plan its account pays for (see server/billing.ts);
 * without an account key, Free. A request may ask for a lower plan than it pays for.
 */
export type PaidPlans = 'open' | 'off' | 'billing';
let paidPlans: PaidPlans = 'open';

export function configure(
  hosts: ApiHosts,
  options: { library?: LibraryStore; paidPlans?: PaidPlans; freeBudget?: number } = {},
): void {
  setApiHosts(hosts);
  if (options.library) setLibraryStore(options.library);
  if (options.paidPlans) paidPlans = options.paidPlans;
  if (options.freeBudget !== undefined && options.freeBudget !== freeBudget.dollars) {
    freeBudget = new DailyBudget(options.freeBudget, libraryStore);
  }
}

/** Dollars spent today on Free's basic community checks, and the cap; for /api/health. */
export async function freeBudgetToday(): Promise<{ spent: number; cap: number }> {
  return { spent: Math.round((await freeBudget.spentToday()) * 1000) / 1000, cap: freeBudget.dollars };
}

export function libraryStoreKind(): string {
  return libraryKind();
}

/** Resets the limits and today's budget; for tests. */
export function resetLimits(budget = FREE_COMMUNITY_BUDGET): void {
  refreshLimits.clear();
  dailyLimits.clear();
  freeBudget = new DailyBudget(budget, libraryStore);
}

const tooMany = (seconds: number): ApiReply => ({
  status: 429,
  body: { ok: false, text: `Too many scans at once. Try again in ${Math.max(1, Math.ceil(seconds / 60))} minute(s).` },
});

/** The plan a scan runs on, and who its limits count against. */
async function planForRequest(asked: unknown, client: string, accessKey: string | undefined): Promise<{ plan: Plan; client: string }> {
  if (paidPlans === 'off') return { plan: PLANS.free, client };
  if (paidPlans === 'open') return { plan: planFrom(asked), client };
  const account = await accountsFor().byKey(accessKey);
  const paid = planOf(account);
  const wanted = typeof asked === 'string' && (PLAN_IDS as readonly string[]).includes(asked) ? (asked as PlanId) : paid;
  const plan = PLAN_IDS.indexOf(wanted) < PLAN_IDS.indexOf(paid) ? wanted : paid;
  // Paid limits follow the account, not the address, so they can't be dodged or shared out.
  return { plan: PLANS[plan], client: account && plan !== 'free' ? `account:${account.id}` : client };
}

export async function handleScan(body: unknown, requestClient: string, accessKey?: string): Promise<ApiReply> {
  const raw = (body ?? {}) as { address?: unknown; network?: unknown; refresh?: unknown; plan?: unknown };
  const refresh = raw.refresh === true;
  const address = typeof raw.address === 'string' ? raw.address.trim() : '';
  const network = typeof raw.network === 'string' && (NETWORKS as readonly string[]).includes(raw.network) ? (raw.network as InsightXNetwork) : undefined;
  if (!address) return { status: 400, body: { ok: false, text: 'Send a contract address to scan.' } };
  if (!isTokenAddress(address)) return { status: 422, body: { ok: false, text: scanErrorText(new LookupError('invalid')) } };
  const chosen = await planForRequest(raw.plan, requestClient, accessKey);
  let plan = chosen.plan;
  const client = chosen.client;
  if (refresh && plan.rechecks === 0) {
    return { status: 403, body: { ok: false, text: 'Re-check is part of Scanner Pro. Free scans use the latest saved community check.' } };
  }

  const prefetched = parsePrefetched(body);
  // Results built from data the client sent are only reused for that client.
  const key = `${prefetched.pairs ? `${client}|` : ''}${plan.id}:${network ?? 'any'}:${address.toLowerCase()}`;
  const cached = refresh ? undefined : scans.get(key);
  if (cached) return { status: 200, body: { ok: true, text: scanText(cached), report: cached } };

  // The extension asks again if its first request was dropped; share the scan in progress.
  const pending = running.get(key);
  if (pending) return pending;

  const wait = Math.max(scanLimit.take(client), refresh ? limiter(refreshLimits, plan, plan.rechecks, 10 * 60_000).take(client) : 0);
  if (wait > 0) return tooMany(wait);

  const notes: string[] = [];
  let runKey = key;
  const daily = plan.paidScansPerDay === undefined ? undefined : limiter(dailyLimits, plan, plan.paidScansPerDay, DAY_MS);
  if (plan.id === 'ultra' && daily && daily.take(client) > 0) {
    plan = atProDepth(plan);
    // Kept apart, so other Ultra users never get this shallower result from the cache.
    runKey = `${key}|pro-depth`;
    notes.push(`Today’s ${PLANS.ultra.paidScansPerDay} deep scans are used up, so this one ran at Pro depth.`);
  }
  const options: LookupOptions = { plan, library: true };
  if (plan.whenUnscanned === 'basic' && daily) {
    // Free's basic checks: within the shared daily budget, then the client's own allowance.
    let reserved = 0;
    options.mayCheckBasic = async (maxCost) => {
      if (!(await freeBudget.reserve(maxCost))) return false;
      if (daily.take(client) > 0) {
        freeBudget.settle(maxCost, 0);
        return false;
      }
      reserved = maxCost;
      return true;
    };
    options.spent = (cost) => freeBudget.settle(reserved, cost);
  }
  const work = runScan(runKey, address, network, prefetched, refresh, options, notes).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

async function runScan(
  key: string,
  address: string,
  network: InsightXNetwork | undefined,
  prefetched: Prefetched,
  refresh: boolean,
  options: LookupOptions,
  notes: string[],
): Promise<ApiReply> {
  const started = Date.now();
  try {
    const scanned = await scanReport(address, network, undefined, prefetched, refresh, options);
    const report = notes.length > 0 ? { ...scanned, notes: [...scanned.notes, ...notes] } : scanned;
    scans.set(key, report);
    const failed = report.failures.map((failure) => `${failure.source}${failure.status ? `:${failure.status}` : ''}`).join(',');
    console.log(`scan ${report.plan} ${network ?? 'any'}:${address} ${Date.now() - started}ms community=${report.communitySource}${failed ? ` failed=${failed}` : ''}`);
    return { status: 200, body: { ok: true, text: scanText(report), report } };
  } catch (error) {
    if (!(error instanceof LookupError) || error.reason === 'unavailable') console.error('scan failed', address, `${Date.now() - started}ms`, error);
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
  } catch (error) {
    console.error('identify failed', error);
    return { status: 502, body: { ok: false, text: 'The market data service did not respond. Try again in a minute.' } };
  }
}

// Member counts change slowly and are free, but keep t.me and Discord from seeing a burst.
const SOCIALS_CACHE_MS = 6 * 60 * 60_000;
const telegramCounts = new TtlCache<ChatCounts['telegram'] | null>(SOCIALS_CACHE_MS, 2_000);
const discordCounts = new TtlCache<ChatCounts['discord'] | null>(SOCIALS_CACHE_MS, 2_000);
const socialsLimit = new RateLimiter(120, 10 * 60_000);

async function telegramCount(name: string): Promise<ChatCounts['telegram'] | null> {
  const response = await fetch(`https://t.me/${name}`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(6_000) });
  if (!response.ok) return null;
  const counts = parseTelegramPage(await response.text());
  return counts ? { name, ...counts } : null;
}

async function discordCount(code: string): Promise<ChatCounts['discord'] | null> {
  const response = await fetch(`https://discord.com/api/v10/invites/${code}?with_counts=true`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { approximate_member_count?: number; approximate_presence_count?: number };
  return typeof body.approximate_member_count === 'number'
    ? { code, members: body.approximate_member_count, online: body.approximate_presence_count }
    : null;
}

async function cached<T>(cache: TtlCache<T | null>, key: string, load: () => Promise<T | null>): Promise<T | undefined> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit ?? undefined;
  try {
    const value = await load();
    cache.set(key, value);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

/** GET /api/socials?telegram=<name>&discord=<code>: member and online counts, both optional. */
export async function handleSocials(query: URLSearchParams, client: string): Promise<ApiReply> {
  const telegram = query.get('telegram') ?? '';
  const discord = query.get('discord') ?? '';
  const wanted = { telegram: TELEGRAM_NAME.test(telegram) ? telegram : undefined, discord: DISCORD_CODE.test(discord) ? discord : undefined };
  const fresh = (wanted.telegram && telegramCounts.get(wanted.telegram.toLowerCase()) === undefined) || (wanted.discord && discordCounts.get(wanted.discord) === undefined);
  if (fresh) {
    const wait = socialsLimit.take(client);
    if (wait > 0) return tooMany(wait);
  }
  const [tg, dc] = await Promise.all([
    wanted.telegram ? cached(telegramCounts, wanted.telegram.toLowerCase(), () => telegramCount(wanted.telegram!)) : undefined,
    wanted.discord ? cached(discordCounts, wanted.discord, () => discordCount(wanted.discord!)) : undefined,
  ]);
  const body: ChatCounts = {};
  if (tg) body.telegram = tg;
  if (dc) body.discord = dc;
  return { status: 200, body };
}

