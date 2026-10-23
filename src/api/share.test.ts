import { describe, expect, it } from 'vitest';
import { savedAt, shareSeconds } from './share';
// @ts-expect-error plain JavaScript module used by server.mjs
import { memoryStore, sharedFetch } from '../../shared-store.mjs';

/** Node's Buffer, which the server store keeps answers in; this project has no Node types. */
declare const Buffer: { from(text: string): { toString(encoding?: string): string } };

const HOUR = 3_600;
const DAY_MS = 24 * HOUR * 1000;

describe('shareSeconds', () => {
  const now = 100 * DAY_MS;
  it('shares community answers for a day, 12 hours for tokens under a week old', () => {
    expect(shareSeconds('community', now - 30 * DAY_MS, false, now)).toBe(24 * HOUR);
    expect(shareSeconds('community', now - 3 * DAY_MS, false, now)).toBe(12 * HOUR);
    expect(shareSeconds('community', undefined, false, now)).toBe(24 * HOUR);
  });

  it('shares holder answers for an hour, 10 minutes for tokens under a day old', () => {
    expect(shareSeconds('holders', now - 2 * DAY_MS, false, now)).toBe(HOUR);
    expect(shareSeconds('holders', now - 60_000, false, now)).toBe(600);
  });

  it('asks for fresh answers on a re-check', () => {
    expect(shareSeconds('community', now - 30 * DAY_MS, true, now)).toBe(0);
  });

  it('reads when the answer was fetched', () => {
    expect(savedAt(new Response('{}', { headers: { 'x-saved-at': '1234' } }))).toBe(1234);
    expect(savedAt(new Response('{}'))).toBeUndefined();
  });
});

describe('sharedFetch', () => {
  const answer = (status = 200) => async () => ({ status, type: 'application/json', body: Buffer.from('{"n":1}') });

  it('shares a young enough answer and fetches again once it is too old for the caller', async () => {
    let now = 0;
    const store = memoryStore(() => now);
    let calls = 0;
    const fetchFresh = async () => {
      calls += 1;
      return answer()();
    };
    const first = await sharedFetch(store, 'k', 3_600, 86_400, fetchFresh, () => now);
    expect(first).toMatchObject({ shared: false, savedAt: 0 });
    now = 30 * 60_000;
    const second = await sharedFetch(store, 'k', 3_600, 86_400, fetchFresh, () => now);
    expect(second).toMatchObject({ shared: true, savedAt: 0 });
    expect(second.body.toString()).toBe('{"n":1}');
    // A newer token only accepts answers up to 10 minutes old.
    expect(await sharedFetch(store, 'k', 600, 86_400, fetchFresh, () => now)).toMatchObject({ shared: false });
    expect(calls).toBe(2);
  });

  it('always fetches on a re-check, and never keeps failed answers', async () => {
    const store = memoryStore(() => 0);
    await sharedFetch(store, 'k', 0, 86_400, answer(), () => 0);
    expect(await sharedFetch(store, 'k', 0, 86_400, answer(), () => 0)).toMatchObject({ shared: false });
    await sharedFetch(store, 'bad', 3_600, 86_400, answer(429), () => 0);
    expect(await store.get('bad')).toBeUndefined();
  });

  it('forgets answers once they have been kept their full time', async () => {
    let now = 0;
    const store = memoryStore(() => now);
    await store.set('k', 'v', 60);
    now = 59_000;
    expect(await store.get('k')).toBe('v');
    now = 60_000;
    expect(await store.get('k')).toBeUndefined();
  });
});
