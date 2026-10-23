/**
 * Paid answers (X, InsightX) are shared between everyone who scans the same token. Our
 * server's proxies keep each answer (see server.mjs and shared-store.mjs); each request
 * says how old an answer it will accept, in seconds, and gets back when that answer was
 * fetched. New tokens change fastest, so they accept only fresher answers.
 */
export const SHARE_HEADER = 'x-share-seconds';
export const SAVED_AT_HEADER = 'x-saved-at';

export type SharedPart = 'community' | 'holders';

const HOUR = 3_600;
const DAY = 24 * HOUR;

/** How old a shared answer may be. 0 asks for a fresh one (a re-check). */
export function shareSeconds(part: SharedPart, launchedAt: number | undefined, fresh = false, now = Date.now()): number {
  if (fresh) return 0;
  const ageMs = launchedAt === undefined ? Infinity : now - launchedAt;
  if (part === 'community') return ageMs < 7 * DAY * 1000 ? 12 * HOUR : DAY;
  return ageMs < DAY * 1000 ? 10 * 60 : HOUR;
}

/** When the answer was fetched, from the proxy's reply; undefined when nothing said. */
export function savedAt(response: Response): number | undefined {
  const value = Number(response.headers.get(SAVED_AT_HEADER));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
