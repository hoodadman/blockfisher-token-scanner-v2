import { describe, expect, it } from 'vitest';
import { PLANS, atProDepth, planFrom, xCostOf } from './plans';

describe('planFrom', () => {
  it('reads a plan id and treats anything else as Pro, so older callers keep working', () => {
    expect(planFrom('free').id).toBe('free');
    expect(planFrom('ultra').id).toBe('ultra');
    expect(planFrom(undefined).id).toBe('pro');
    expect(planFrom('gold').id).toBe('pro');
  });
});

describe('the three plans', () => {
  it('only Free reads Community from the library, never pays X and has no Re-check', () => {
    expect(PLANS.free).toMatchObject({ community: 'library', rechecks: 0, paysForX: false });
    expect(PLANS.pro).toMatchObject({ community: 'shared' });
    expect(PLANS.ultra).toMatchObject({ community: 'shared', extraSecurity: true });
  });

  it('Ultra reads more of X, at a higher worst-case cost', () => {
    expect(PLANS.ultra.x.mentions).toBeGreaterThan(PLANS.pro.x.mentions);
    expect(xCostOf(PLANS.pro.x)).toBeCloseTo(0.29, 2);
    expect(xCostOf(PLANS.ultra.x)).toBeCloseTo(0.715, 3);
  });

  it('Ultra past its deep scans keeps its name but runs at Pro depth without extras', () => {
    const fallback = atProDepth(PLANS.ultra);
    expect(fallback).toMatchObject({ id: 'ultra', x: PLANS.pro.x, extraSecurity: false });
    expect(fallback.communityMaxAge).toBeUndefined();
  });
});
