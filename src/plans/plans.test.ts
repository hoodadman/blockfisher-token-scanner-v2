import { describe, expect, it } from 'vitest';
import { PLANS, SCANS_PER_HOUR, planFrom, xCostOf } from './plans';

describe('planFrom', () => {
  it('reads a plan id and treats anything else as Pro, so older callers keep working', () => {
    expect(planFrom('free').id).toBe('free');
    expect(planFrom('ultra').id).toBe('ultra');
    expect(planFrom(undefined).id).toBe('pro');
    expect(planFrom('gold').id).toBe('pro');
  });
});

describe('the three plans', () => {
  it('caps fresh Community + Foundation checks a month: Free 4 and Pro 30 at Pro depth, Ultra 30 at Ultra depth', () => {
    expect(PLANS.free).toMatchObject({ freshPerMonth: 4, depth: 'pro', rechecks: 0, extraSecurity: false });
    expect(PLANS.free.x).toEqual(PLANS.pro.x);
    expect(PLANS.pro).toMatchObject({ freshPerMonth: 30, depth: 'pro' });
    expect(PLANS.ultra).toMatchObject({ freshPerMonth: 30, depth: 'ultra', extraSecurity: true });
    expect(SCANS_PER_HOUR).toBe(60);
  });

  it('Ultra reads more of X, at a higher worst-case cost', () => {
    expect(PLANS.ultra.x.mentions).toBeGreaterThan(PLANS.pro.x.mentions);
    expect(xCostOf(PLANS.pro.x)).toBeCloseTo(0.29, 2);
    expect(xCostOf(PLANS.ultra.x)).toBeCloseTo(0.715, 3);
  });
});
