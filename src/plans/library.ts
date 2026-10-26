import type { InsightXNetwork } from '../adapters';
import type { TwitterBundle } from '../api/twitter';
import type { PlanId } from './plans';

/**
 * The scan library: the latest X answers for every token anyone has scanned, kept for
 * good. Free scans read Community from here, whatever its age; every Pro and Ultra scan
 * writes its answers back, so paying users keep the library fresh for everyone.
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

const keyOf = (network: InsightXNetwork, address: string) => `${network}:${address.toLowerCase()}`;

/** The saved entry, or undefined when there is none or the store failed. */
export async function readLibrary(network: InsightXNetwork, address: string): Promise<LibraryEntry | undefined> {
  try {
    const raw = await store.get(keyOf(network, address));
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as LibraryEntry;
    return typeof entry.savedAt === 'number' && entry.bundle ? entry : undefined;
  } catch (error) {
    console.error('library read failed:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** Saves answers unless the library already holds newer ones. A store failure never fails a scan. */
export async function writeLibrary(network: InsightXNetwork, address: string, entry: LibraryEntry): Promise<void> {
  try {
    const current = await readLibrary(network, address);
    if (current && current.savedAt > entry.savedAt) return;
    await store.set(keyOf(network, address), JSON.stringify(entry));
  } catch (error) {
    console.error('library write failed:', error instanceof Error ? error.message : error);
  }
}
