export type ScoreTone = 'green' | 'yellow' | 'orange' | 'red' | 'none';

export function averageScore(scores: readonly (number | null | undefined)[]): number | null {
  const known = scores.filter((value): value is number => typeof value === 'number');
  if (known.length === 0) return null;
  return Math.round(known.reduce((sum, value) => sum + value, 0) / known.length);
}

/**
 * The overall mark. Security leads: with no Security score there is no overall, and the
 * overall never sits in a safer band than Security (a honeypot can't average up to "medium").
 */
export function overallScore(
  security: number | null | undefined,
  others: readonly (number | null | undefined)[],
): number | null {
  if (security === null || security === undefined) return null;
  const average = averageScore([security, ...others]) as number;
  const ceiling = security < 40 ? 39 : security < 80 ? 79 : 100;
  return Math.min(average, ceiling);
}

/** Each score is coloured on its own, not from the overall mark. */
export function toneFor(score: number | null | undefined): ScoreTone {
  if (score === null || score === undefined) return 'none';
  if (score >= 90) return 'green';
  if (score >= 60) return 'yellow';
  if (score >= 30) return 'orange';
  return 'red';
}
