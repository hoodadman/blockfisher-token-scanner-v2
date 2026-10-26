import { describe, expect, it } from 'vitest';
import { DailyBudget } from './budget';
import { memoryLibrary } from './library';

const DAY = 24 * 60 * 60_000;

describe('DailyBudget', () => {
  it('holds the most a check can cost, gives back what it didn\'t cost, and refuses past the cap', async () => {
    const budget = new DailyBudget(0.1, undefined, () => 0);
    expect(await budget.reserve(0.045)).toBe(true);
    budget.settle(0.045, 0.02);
    expect(await budget.spentToday()).toBeCloseTo(0.02);
    expect(await budget.reserve(0.045)).toBe(true);
    expect(await budget.reserve(0.045)).toBe(false);
  });

  it('starts again each UTC day', async () => {
    let now = 0;
    const budget = new DailyBudget(0.05, undefined, () => now);
    expect(await budget.reserve(0.05)).toBe(true);
    expect(await budget.reserve(0.01)).toBe(false);
    now = DAY;
    expect(await budget.reserve(0.05)).toBe(true);
  });

  it('remembers today\'s spending across a restart', async () => {
    const store = memoryLibrary();
    const first = new DailyBudget(10, () => store, () => 0);
    await first.reserve(9.99);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = new DailyBudget(10, () => store, () => 1_000);
    expect(await second.reserve(0.045)).toBe(false);
  });
});
