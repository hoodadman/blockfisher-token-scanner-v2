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
import { MonthlyAllowance, type AllowanceStatus } from '../plans/allowance';
import { DailyBudget } from '../plans/budget';
import { libraryKind, libraryStore, setLibraryStore, type LibraryStore } from '../plans/library';
import { PLANS, PLAN_IDS, SCANS_PER_HOUR, planFrom, xCostOf, type Plan, type PlanId } from '../plans/plans';
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
export { mailerFrom } from '../billing/email';

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
// Every scan counts, cached or not, on every plan: per account, or per client without one.
let scanLimit = new RateLimiter(SCANS_PER_HOUR, 60 * 60_000);
// A re-check skips every shared answer, so it costs the most; each plan allows a few.
const refreshLimits = new Map<PlanId, RateLimiter>();
// Fresh Community + Foundation checks a month (plans.ts `freshPerMonth`), kept in the library's store.
let allowance = new MonthlyAllowance(libraryStore);
const identifyLimit = new RateLimiter(120, 10 * 60_000);

function limiter(limits: Map<PlanId, RateLimiter>, plan: Plan, max: number, windowMs: number): RateLimiter {
  let found = limits.get(plan.id);
  if (!found) {
    found = new RateLimiter(max, windowMs);
    limits.set(plan.id, found);
  }
  return found;
}

/**
 * Default shared daily cap, in dollars, on what all Free users together spend on fresh
 * community checks (FREE_COMMUNITY_BUDGET). A backstop on top of each user's 4 a month,
 * since Free users without an account are told apart only by their address.
 */
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

/** Dollars spent today on Free's fresh community checks, and the cap; for /api/health. */
export async function freeBudgetToday(): Promise<{ spent: number; cap: number }> {
  return { spent: Math.round((await freeBudget.spentToday()) * 1000) / 1000, cap: freeBudget.dollars };
}

export function libraryStoreKind(): string {
  return libraryKind();
}

/** Resets the limits, the month's counts and today's budget; for tests. */
export function resetLimits(budget = FREE_COMMUNITY_BUDGET): void {
  refreshLimits.clear();
  scanLimit = new RateLimiter(SCANS_PER_HOUR, 60 * 60_000);
  allowance = new MonthlyAllowance(libraryStore);
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
  // Limits follow the account, not the address, so they can't be dodged or shared out.
  // Free without an account has only its address to go on (see docs: Free has no sign-up yet).
  return { plan: PLANS[plan], client: account ? `account:${account.id}` : client };
}

export async function handleScan(body: unknown, requestClient: string, accessKey?: string): Promise<ApiReply> {
  const raw = (body ?? {}) as { address?: unknown; network?: unknown; refresh?: unknown; plan?: unknown };
  const refresh = raw.refresh === true;
  const address = typeof raw.address === 'string' ? raw.address.trim() : '';
  const network = typeof raw.network === 'string' && (NETWORKS as readonly string[]).includes(raw.network) ? (raw.network as InsightXNetwork) : undefined;
  if (!address) return { status: 400, body: { ok: false, text: 'Send a contract address to scan.' } };
  if (!isTokenAddress(address)) return { status: 422, body: { ok: false, text: scanErrorText(new LookupError('invalid')) } };
  const { plan, client } = await planForRequest(raw.plan, requestClient, accessKey);
  if (refresh && plan.rechecks === 0) {
    return { status: 403, body: { ok: false, text: 'Re-check is part of Scanner Pro. Free scans use the latest saved community check.' } };
  }
  if (refresh && (await allowance.status(client, plan.freshPerMonth)).left === 0) {
    return { status: 429, body: { ok: false, text: `Re-check needs a fresh community check, and this month’s ${plan.freshPerMonth} are used up. They reset on the 1st.` } };
  }

  // Every scan counts towards the hourly limit, whether or not it is answered from the cache.
  const wait = Math.max(scanLimit.take(client), refresh ? limiter(refreshLimits, plan, plan.rechecks, 10 * 60_000).take(client) : 0);
  if (wait > 0) return tooMany(wait);

  const prefetched = parsePrefetched(body);
  // Results built from data the client sent are only reused for that client.
  const key = `${prefetched.pairs ? `${client}|` : ''}${plan.id}:${network ?? 'any'}:${address.toLowerCase()}`;
  const cached = refresh ? undefined : scans.get(key);
  if (cached) return withAllowance({ status: 200, body: { ok: true, text: scanText(cached), report: cached } }, client, plan);

  // The extension asks again if its first request was dropped; share the scan in progress.
  // Per client, since one member's month may be used up and another's not.
  const runningKey = `${client}|${key}`;
  const pending = running.get(runningKey);
  if (pending) return pending;

  const options: LookupOptions = { plan, library: true };
  // Free users together also stay within a shared daily budget, held at the worst case.
  const cost = plan.id === 'free' ? xCostOf(plan.x) : 0;
  options.mayFetch = async () => {
    if (cost > 0 && !(await freeBudget.reserve(cost))) return false;
    if (await allowance.take(client, plan.freshPerMonth)) return true;
    if (cost > 0) freeBudget.settle(cost, 0);
    return false;
  };
  options.fetchDone = (read) => {
    if (read) return;
    allowance.giveBack(client);
    if (cost > 0) freeBudget.settle(cost, 0);
  };
  const work = runScan(key, address, network, prefetched, refresh, options)
    .then((reply) => withAllowance(reply, client, plan))
    .finally(() => running.delete(runningKey));
  running.set(runningKey, work);
  return work;
}

/** Adds what's left of the month's fresh community checks to a scan reply. */
async function withAllowance(reply: ApiReply, client: string, plan: Plan): Promise<ApiReply> {
  if (reply.status !== 200) return reply;
  const status: AllowanceStatus = await allowance.status(client, plan.freshPerMonth);
  return { ...reply, body: { ...(reply.body as object), freshChecks: status } };
}

async function runScan(
  key: string,
  address: string,
  network: InsightXNetwork | undefined,
  prefetched: Prefetched,
  refresh: boolean,
  options: LookupOptions,
): Promise<ApiReply> {
  const started = Date.now();
  try {
    const report = await scanReport(address, network, undefined, prefetched, refresh, options);
    // A capped result (a saved one shown because the month's checks are used up) is this
    // member's alone; others on the plan still get a fresh one.
    if (!report.capped) scans.set(key, report);
    const failed = report.failures.map((failure) => `${failure.source}${failure.status ? `:${failure.status}` : ''}`).join(',');
    console.log(`scan ${report.plan} ${network ?? 'any'}:${address} ${Date.now() - started}ms community=${report.communitySource}${report.capped ? ' capped' : ''}${failed ? ` failed=${failed}` : ''}`);
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

