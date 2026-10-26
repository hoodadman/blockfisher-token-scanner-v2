import { describe, expect, it } from 'vitest';
import type { TwitterBundle } from '../api/twitter';
import { ULTRA_PREFERRED_MS, choose, type LibraryEntry } from './library';
import { PLANS, atProDepth } from './plans';

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const bundle: TwitterBundle = { tweets: [], mentions: [], mentionedPeople: [] };
const saved = (hoursAgo: number, plan: 'pro' | 'ultra'): LibraryEntry => ({ savedAt: NOW - hoursAgo * HOUR, plan, bundle });
const DAY_S = 24 * 3600;

describe('choose: Free', () => {
  it('prefers a saved Ultra result to a Pro one, at any age', () => {
    const ultra = saved(24 * 30, 'ultra');
    expect(choose(PLANS.free, { pro: saved(24 * 25, 'pro'), ultra }, 0, NOW)).toEqual({ use: ultra, from: 'ultra' });
  });

  it('takes the Pro result when it is more than a week newer than the Ultra one', () => {
    const pro = saved(1, 'pro');
    const ultra = { ...saved(1, 'ultra'), savedAt: pro.savedAt - ULTRA_PREFERRED_MS - 1 };
    expect(choose(PLANS.free, { pro, ultra }, 0, NOW)).toEqual({ use: pro, from: 'pro' });
  });

  it('fetches only when nothing is saved', () => {
    expect(choose(PLANS.free, {}, 0, NOW)).toEqual({ fetch: true });
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

  it('at Pro depth (deep scans used up) it uses the Pro result rather than reading on', () => {
    const pro = saved(1, 'pro');
    expect(choose(atProDepth(PLANS.ultra), { pro }, DAY_S, NOW)).toEqual({ use: pro, from: 'pro' });
  });
});
