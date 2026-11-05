import { describe, expect, it } from 'vitest';
import type { TwitterBundle } from '../api/twitter';
import { ULTRA_PREFERRED_MS, choose, type LibraryEntry } from './library';
import { PLANS } from './plans';

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const bundle: TwitterBundle = { tweets: [], mentions: [], mentionedPeople: [] };
const saved = (hoursAgo: number, plan: 'pro' | 'ultra'): LibraryEntry => ({ savedAt: NOW - hoursAgo * HOUR, plan, bundle });
const DAY_S = 24 * 3600;

describe('choose: fresh checks used up', () => {
  it('prefers a saved Ultra result to a Pro one, at any age, on every plan', () => {
    const ultra = saved(24 * 30, 'ultra');
    for (const plan of [PLANS.free, PLANS.pro, PLANS.ultra]) {
      expect(choose(plan, { pro: saved(24 * 25, 'pro'), ultra }, DAY_S, NOW, true)).toEqual({ use: ultra, from: 'ultra' });
    }
  });

  it('takes the Pro result when it is more than a week newer than the Ultra one', () => {
    const pro = saved(1, 'pro');
    const ultra = { ...saved(1, 'ultra'), savedAt: pro.savedAt - ULTRA_PREFERRED_MS - 1 };
    expect(choose(PLANS.free, { pro, ultra }, DAY_S, NOW, true)).toEqual({ use: pro, from: 'pro' });
  });

  it('never fetches: an old basic check, else no Community', () => {
    const basic = saved(24 * 40, 'pro');
    expect(choose(PLANS.pro, { basic }, DAY_S, NOW, true)).toEqual({ use: basic, from: 'basic' });
    expect(choose(PLANS.ultra, {}, DAY_S, NOW, true)).toEqual({ none: true });
  });

  it('Ultra uses a recent Pro result as it is rather than reading on', () => {
    const pro = saved(1, 'pro');
    expect(choose(PLANS.ultra, { pro }, 6 * 3600, NOW, true)).toEqual({ use: pro, from: 'pro' });
  });
});

describe('choose: Free with checks left', () => {
  it('follows the same rules as Pro', () => {
    const pro = saved(5, 'pro');
    expect(choose(PLANS.free, { pro }, DAY_S, NOW)).toEqual({ use: pro, from: 'pro' });
    expect(choose(PLANS.free, { pro: saved(30, 'pro') }, DAY_S, NOW)).toEqual({ fetch: true });
  });
});

describe('choose: Pro', () => {
  it('uses an Ultra result inside its window before a Pro one', () => {
    const ultra = saved(20, 'ultra');
    expect(choose(PLANS.pro, { pro: saved(1, 'pro'), ultra }, DAY_S, NOW)).toEqual({ use: ultra, from: 'ultra' });
  });

  it('uses a Pro result inside its window, and fetches once both are too old', () => {
    const pro = saved(5, 'pro');
    expect(choose(PLANS.pro, { pro, ultra: saved(30, 'ultra') }, DAY_S, NOW)).toEqual({ use: pro, from: 'pro' });
    expect(choose(PLANS.pro, { pro: saved(13, 'pro') }, 12 * 3600, NOW)).toEqual({ fetch: true });
  });

  it('a re-check always fetches', () => {
    expect(choose(PLANS.pro, { pro: saved(0, 'pro'), ultra: saved(0, 'ultra') }, 0, NOW)).toEqual({ fetch: true });
  });
});

describe('choose: Ultra', () => {
  it('uses a recent Ultra result, else reads on from a recent Pro one', () => {
    const ultra = saved(2, 'ultra');
    const pro = saved(1, 'pro');
    expect(choose(PLANS.ultra, { pro, ultra }, 6 * 3600, NOW)).toEqual({ use: ultra, from: 'ultra' });
    expect(choose(PLANS.ultra, { pro, ultra: saved(7, 'ultra') }, 6 * 3600, NOW)).toEqual({ expand: pro });
    expect(choose(PLANS.ultra, { pro: saved(7, 'pro') }, 6 * 3600, NOW)).toEqual({ fetch: true });
  });
});
