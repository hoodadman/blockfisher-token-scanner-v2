import { ABOUT } from './about';
import { CHECKS } from './checks';
import type { CheckDefinition, CheckSummary, Issue, RiskBand, Severity, Tier, TokenSignals, TrustReport } from './types';

/** Lowest score in each band, highest band first. */
export const BANDS: ReadonlyArray<{ band: RiskBand; min: number }> = [
  { band: 'low', min: 80 },
  { band: 'medium', min: 40 },
  { band: 'high', min: 0 },
];

/** The highest the score can be once an issue of this severity is found. */
export const SEVERITY_CAPS: Readonly<Record<Severity, number>> = {
  critical: 39,
  warning: 79,
  minor: 100,
};

/**
 * Share of each warning or minor penalty that counts, biggest first. Several small powers
 * held by one issuer should not add up to the same score as a scam. Critical issues always
 * count in full.
 */
export const STACKING_RATES: readonly number[] = [1, 0.6, 0.4, 0.25];

/** Share of the core checks that need data before a score is shown. */
export const MIN_COVERAGE = 0.5;

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { critical: 0, warning: 1, minor: 2 };

export interface ScoreOptions {
  includeExperimental?: boolean;
  now?: number;
  checks?: readonly CheckDefinition[];
}

export function scoreToken(signals: TokenSignals, options: ScoreOptions = {}): TrustReport {
  const { includeExperimental = true, now = Date.now(), checks = CHECKS } = options;
  const issues: Issue[] = [];
  const passed: CheckSummary[] = [];
  const notChecked: CheckSummary[] = [];
  const coverage = { checked: 0, total: 0 };

  for (const check of checks) {
    const experimental = check.experimental ?? false;
    if (experimental && !includeExperimental) continue;
    if (check.appliesTo && !check.appliesTo.includes(signals.chain)) continue;

    const tier = check.evaluate(signals, now);
    if (!experimental) {
      coverage.total += 1;
      if (tier !== undefined) coverage.checked += 1;
    }

    const about = ABOUT[check.id];
    if (tier === null) {
      passed.push({ id: check.id, label: check.passLabel, experimental, about });
    } else if (tier) {
      issues.push(toIssue(check, tier, check.measure?.(signals, now)));
    } else if (check.ifUnknown) {
      issues.push(toIssue(check, check.ifUnknown));
    } else {
      notChecked.push({ id: check.id, label: check.name, experimental, about });
    }
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.points - a.points);

  if (coverage.total === 0 || coverage.checked / coverage.total < MIN_COVERAGE) {
    return { score: null, band: null, issues, passed, notChecked, coverage };
  }

  const deducted = totalDeduction(issues);
  const cap = Math.min(100, ...issues.map((issue) => SEVERITY_CAPS[issue.severity]));
  const score = Math.max(0, Math.min(cap, Math.round(100 - deducted)));
  const band = BANDS.find(({ min }) => score >= min)?.band ?? 'high';

  return { score, band, issues, passed, notChecked, coverage };
}

/** Expects issues sorted most severe first, then by points. */
export function totalDeduction(issues: readonly Issue[]): number {
  let smaller = 0;
  return issues.reduce((sum, issue) => {
    if (issue.severity === 'critical') return sum + issue.points;
    const rate = STACKING_RATES[Math.min(smaller, STACKING_RATES.length - 1)];
    smaller += 1;
    return sum + issue.points * rate;
  }, 0);
}

function toIssue(check: CheckDefinition, tier: Tier, measured = ''): Issue {
  const fill = (text: string) => text.replaceAll('{value}', measured);
  return {
    id: check.id,
    category: check.category,
    experimental: check.experimental ?? false,
    severity: tier.severity,
    points: tier.points,
    title: fill(tier.title),
    summary: fill(tier.summary),
    details: fill(tier.details),
  };
}
