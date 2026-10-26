import type { InsightXNetwork } from '../adapters';
import type { TwitterBundle } from '../api/twitter';
import type { Plan, PlanId, Source } from './plans';

/**
 * The scan library: the latest X answers for every token anyone has scanned, kept for
 * good, one at each depth (Pro and Ultra). Every scan that pays for X writes back, and
 * every plan reads what others already paid for before spending anything (see `choose`):
 * results trickle down from Ultra to Pro to Free.
 *
 * Only the server writes it, from answers it fetched itself, so nothing a browser sends
 * can end up in someone else's result. server.mjs passes in a store kept in Postgres
 * (DATABASE_URL) or Redis (REDIS_URL); without either it lives in memory.
 */
export interface LibraryStore {
  kind: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface LibraryEntry {
  /** When the X answers were fetched (ms). */
  savedAt: number;
  /** The plan of the scan that fetched them. */
  plan: PlanId;
  bundle: TwitterBundle;
}

const MEMORY_LIMIT = 5_000;

export function memoryLibrary(): LibraryStore {
  const entries = new Map<string, string>();
  return {
    kind: 'memory',
    async get(key) {
      return entries.get(key);
    },
    async set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > MEMORY_LIMIT) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

let store: LibraryStore = memoryLibrary();

export function setLibraryStore(next: LibraryStore): void {
  store = next;
}

export function libraryKind(): string {
  return store.kind;
}

export function libraryStore(): LibraryStore {
  return store;
}

const keyOf = (network: InsightXNetwork, address: string, depth: Source) => `${network}:${address.toLowerCase()}:${depth}`;

export type Shelf = Partial<Record<Source, LibraryEntry>>;

async function readOne(network: InsightXNetwork, address: string, depth: Source): Promise<LibraryEntry | undefined> {
  try {
    const raw = await store.get(keyOf(network, address, depth));
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as LibraryEntry;
    return typeof entry.savedAt === 'number' && entry.bundle ? entry : undefined;
  } catch (error) {
    console.error('library read failed:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** The saved entries from each source; missing when there is none or the store failed. */
export async function readLibrary(network: InsightXNetwork, address: string): Promise<Shelf> {
  const [pro, ultra, basic] = await Promise.all((['pro', 'ultra', 'basic'] as const).map((source) => readOne(network, address, source)));
  return { ...(pro && { pro }), ...(ultra && { ultra }), ...(basic && { basic }) };
}

/** Saves answers at their depth unless the library already holds newer ones. A store failure never fails a scan. */
export async function writeLibrary(network: InsightXNetwork, address: string, depth: Source, entry: LibraryEntry): Promise<void> {
  try {
    const current = await readOne(network, address, depth);
    if (current && current.savedAt > entry.savedAt) return;
    await store.set(keyOf(network, address, depth), JSON.stringify(entry));
  } catch (error) {
    console.error('library write failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Free prefers an Ultra result to a Pro one (it read more of X), unless the Pro one is
 * this much newer: a week-old deep read says less than yesterday's standard one.
 */
export const ULTRA_PREFERRED_MS = 7 * 24 * 60 * 60_000;

/** What a scan does for Community, given what the library holds. */
export type Choice =
  | { use: LibraryEntry; from: Source }
  | { expand: LibraryEntry }
  | { fetch: true };

/**
 * The trickle-down rules.
 * - Free: the saved Ultra result, else Pro, whatever its age (Ultra unless Pro is a week
 *   newer); else an earlier basic check. Pro and Ultra never use a basic check.
 * - Pro: a saved Ultra or Pro result no older than `maxAgeSeconds`, Ultra first.
 * - Ultra: a saved Ultra result no older than `maxAgeSeconds`; else read on from a Pro
 *   result that young instead of starting again.
 * Otherwise fetch at the plan's own depth. A re-check passes 0 and always fetches.
 */
export function choose(plan: Plan, shelf: Shelf, maxAgeSeconds: number, now = Date.now()): Choice {
  const { pro, ultra } = shelf;
  if (plan.community === 'library') {
    if (ultra && (!pro || pro.savedAt - ultra.savedAt <= ULTRA_PREFERRED_MS)) return { use: ultra, from: 'ultra' };
    if (pro) return { use: pro, from: 'pro' };
    if (shelf.basic) return { use: shelf.basic, from: 'basic' };
    return { fetch: true };
  }
  const young = (entry?: LibraryEntry): entry is LibraryEntry => entry !== undefined && maxAgeSeconds > 0 && now - entry.savedAt <= maxAgeSeconds * 1000;
  if (young(ultra)) return { use: ultra, from: 'ultra' };
  if (young(pro)) return plan.depth === 'ultra' ? { expand: pro } : { use: pro, from: 'pro' };
  return { fetch: true };
}
