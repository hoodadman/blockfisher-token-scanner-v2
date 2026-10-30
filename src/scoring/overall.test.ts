import { describe, expect, it } from 'vitest';
import { averageScore, overallScore, toneFor } from './overall';

describe('averageScore', () => {
  it('averages the pillars we have and ignores missing ones', () => {
    expect(averageScore([75, 98, 40])).toBe(71);
    expect(averageScore([75, null, 40])).toBe(58);
    expect(averageScore([null, undefined])).toBeNull();
  });
});

describe('overallScore', () => {
  it('gives no overall when Security has no score', () => {
    expect(overallScore(null, [80, 75])).toBeNull();
    expect(overallScore(undefined, [80, 75])).toBeNull();
  });

  it('never puts the overall in a safer band than Security', () => {
    // A honeypot (Security 0) used to average to 55, "medium risk".
    expect(overallScore(0, [85, 80])).toBe(39);
    expect(overallScore(70, [100, 100])).toBe(79);
    expect(overallScore(95, [100, 90])).toBe(95);
  });

  it('can still fall below Security', () => {
    expect(overallScore(90, [20, 10])).toBe(40);
    expect(overallScore(30, [10, null])).toBe(20);
  });
});

describe('toneFor', () => {
  it('colours each score on its own 0–29 / 30–59 / 60–89 / 90–100 scale', () => {
    expect(toneFor(90)).toBe('green');
    expect(toneFor(89)).toBe('yellow');
    expect(toneFor(60)).toBe('yellow');
    expect(toneFor(59)).toBe('orange');
    expect(toneFor(30)).toBe('orange');
    expect(toneFor(29)).toBe('red');
    expect(toneFor(null)).toBe('none');
  });
});
