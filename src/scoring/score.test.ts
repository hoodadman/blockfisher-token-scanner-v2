import { describe, expect, it } from 'vitest';
import { scoreToken } from './score';
import type { TokenSignals, TrustReport } from './types';

const NOW = Date.UTC(2026, 9, 3);
const DAY = 86_400_000;

const cleanEvm: TokenSignals = {
  chain: 'evm',
  honeypotRisk: 0,
  canTakeTokens: false,
  knownScamCreator: false,
  canPause: false,
  buyFeePct: 0,
  sellFeePct: 0,
  transferFeePct: 0,
  feesChangeable: false,
  mintable: false,
  canFreeze: false,
  hasBlacklist: false,
  hasWhitelist: false,
  codeVerified: true,
  upgradeable: false,
  hiddenControl: false,
  sellLimited: false,
  cannotSellAll: false,
  antiWhale: false,
  tradingCooldown: false,
  externalCall: false,
  suspiciousFunctions: false,
  liquidityLockedPct: 100,
  ownershipRenounced: true,
  liquidityUsd: 1_000_000,
  launchedAt: NOW - 365 * DAY,
  hasWebsiteOrSocials: true,
  clusterPct: 0,
  top10Pct: 10,
};

const cleanSolana: TokenSignals = {
  chain: 'solana',
  honeypotRisk: 0,
  canTakeTokens: false,
  tradingPaused: false,
  canPause: false,
  transferFeePct: 0,
  feesChangeable: false,
  mintable: false,
  canFreeze: false,
  liquidityLockedPct: 100,
  metadataMutable: false,
  liquidityUsd: 1_000_000,
  launchedAt: NOW - 365 * DAY,
  hasWebsiteOrSocials: true,
  clusterPct: 0,
  bundlersPct: 0,
  snipersPct: 0,
  devPct: 0,
  insidersPct: 0,
  top10Pct: 10,
};

const score = (signals: TokenSignals, includeExperimental = true) =>
  scoreToken(signals, { now: NOW, includeExperimental });

const issueIds = (report: TrustReport) => report.issues.map((issue) => issue.id);

describe('scoreToken', () => {
  it('gives 100 when every check passes', () => {
    for (const signals of [cleanEvm, cleanSolana]) {
      const report = score(signals);
      expect(report.score).toBe(100);
      expect(report.band).toBe('low');
      expect(report.issues).toEqual([]);
      expect(report.notChecked).toEqual([]);
    }
  });

  it('subtracts points for minor issues', () => {
    const report = score({ ...cleanEvm, ownershipRenounced: false, sellFeePct: 6 });
    // 5 for the fee, then 3 × 0.6 for ownership.
    expect(report.score).toBe(93);
    expect(report.band).toBe('low');
  });

  it('keeps any token with a warning out of the low-risk band', () => {
    const report = score({ ...cleanEvm, canPause: true });
    expect(report.issues[0].points).toBe(15);
    expect(report.score).toBe(79);
    expect(report.band).toBe('medium');
  });

  it('puts any token with a critical issue in the high-risk band', () => {
    const report = score({ ...cleanEvm, knownScamCreator: true });
    expect(report.issues[0].points).toBe(60);
    expect(report.score).toBe(39);
    expect(report.band).toBe('high');
  });

  it('scores a confirmed honeypot as 0', () => {
    expect(score({ ...cleanEvm, honeypotRisk: 100 }).score).toBe(0);
  });

  it('counts a missing sell test as a warning rather than a pass', () => {
    const report = score({ ...cleanEvm, honeypotRisk: undefined });
    expect(report.issues.map((issue) => [issue.id, issue.severity])).toEqual([['honeypot', 'warning']]);
    expect(report.score).toBe(70);
  });

  it('lists other missing data as not checked, without changing the score', () => {
    const report = score({ ...cleanEvm, upgradeable: undefined });
    expect(report.notChecked.map((check) => check.id)).toEqual(['upgradeable']);
    expect(report.score).toBe(100);
  });

  it('attaches a plain-English explanation to every passed or skipped check', () => {
    const report = score({ ...cleanEvm, upgradeable: undefined });
    expect(report.passed.every((item) => item.about)).toBe(true);
    expect(report.notChecked[0]?.about).toMatch(/swap the rules/);
  });

  it('withholds the score when fewer than half the core checks have data', () => {
    const report = score({ chain: 'solana', liquidityUsd: 80_000, launchedAt: NOW - 30 * DAY, hasWebsiteOrSocials: true });
    expect(report.score).toBeNull();
    expect(report.band).toBeNull();
    expect(report.coverage).toEqual({ checked: 3, total: 12 });
  });

  it('grades fees at 5%, 10% and 30%', () => {
    const severityFor = (fee: number) => score({ ...cleanEvm, sellFeePct: fee }).issues[0]?.severity ?? null;
    expect([4.9, 5, 10, 30].map(severityFor)).toEqual([null, 'minor', 'warning', 'critical']);
  });

  it('fills the measured value into the wording', () => {
    expect(score({ ...cleanEvm, sellFeePct: 12 }).issues[0].summary).toBe('The token charges 12% when you sell.');
    expect(score({ ...cleanSolana, launchedAt: NOW - 3 * 3_600_000 }).issues[0].summary).toBe('It started trading 3 hours ago.');
  });

  it('only runs the checks that apply to the token’s chain', () => {
    const report = score(cleanEvm);
    const ran = [...report.passed, ...report.notChecked].map((check) => check.id);
    expect(ran).not.toContain('metadataMutable');
    expect(ran).not.toContain('bundlers');
    expect(ran).toContain('publicCode');
  });

  it('can leave the experimental holder checks out', () => {
    const risky = { ...cleanSolana, bundlersPct: 40 };
    expect(issueIds(score(risky))).toEqual(['bundlers']);
    expect(score(risky, false).score).toBe(100);
  });

  it('counts each extra warning or minor issue for less than the one before', () => {
    // An issuer that can mint, blacklist, pause and upgrade, like a large stablecoin.
    const report = score({ ...cleanEvm, mintable: true, hasBlacklist: true, canPause: true, upgradeable: true, ownershipRenounced: false });
    expect(report.issues.map((issue) => issue.points)).toEqual([25, 25, 15, 15, 3]);
    // 25 + 25 × 0.6 + 15 × 0.4 + 15 × 0.25 + 3 × 0.25, instead of 83 in full.
    expect(report.score).toBe(50);
    expect(report.band).toBe('medium');
  });

  it('still counts critical issues in full alongside smaller ones', () => {
    const report = score({ ...cleanEvm, canTakeTokens: true, mintable: true, hasBlacklist: true });
    // 60 + 25 + 25 × 0.6, then capped at 39 by the critical issue.
    expect(report.score).toBe(0);
    expect(score({ ...cleanEvm, canTakeTokens: true }).score).toBe(39);
  });

  it('keeps a token under a day old out of the low-risk band', () => {
    const report = score({ ...cleanSolana, launchedAt: NOW - 3 * 3_600_000 });
    expect(issueIds(report)).toEqual(['tokenAge']);
    expect(report.score).toBe(79);
    expect(report.band).toBe('medium');
  });

  it('flags an unknown pool size at any age', () => {
    const fresh = score({ ...cleanSolana, liquidityUsd: undefined, launchedAt: NOW - 3 * 3_600_000 });
    expect(issueIds(fresh)).toEqual(['liquidity', 'tokenAge']);
    // 20 + 20 × 0.6
    expect(fresh.score).toBe(68);
    // A launchpad token 10 days old with no pool size used to score 100.
    const older = score({ ...cleanSolana, liquidityUsd: undefined, launchedAt: NOW - 10 * DAY });
    expect(issueIds(older)).toEqual(['liquidity']);
    expect(older.issues[0].title).toBe('Trading pool size unknown');
    expect(older.score).toBe(79);
  });

  it('flags an unknown start date as a minor issue', () => {
    const report = score({ ...cleanSolana, launchedAt: undefined });
    expect(report.issues.map((issue) => [issue.id, issue.severity])).toEqual([['tokenAge', 'minor']]);
    expect(report.score).toBe(95);
    // With neither the pool size nor the age known, it can't score 100 either.
    expect(score({ ...cleanSolana, liquidityUsd: undefined, launchedAt: undefined }).score).toBe(77);
  });

  it('says plainly when a Solana sell test can’t run', () => {
    const report = score({ ...cleanSolana, honeypotRisk: undefined });
    expect(report.issues[0]).toMatchObject({ id: 'honeypot', severity: 'warning', title: 'We can’t test selling on Solana yet' });
    expect(report.passed.map((item) => item.id)).not.toContain('honeypot');
    expect(report.score).toBe(70);
    expect(score({ ...cleanEvm, honeypotRisk: undefined }).issues[0].title).toBe('Sell test couldn’t run');
  });

  it('lists issues from most to least severe', () => {
    const report = score({ ...cleanEvm, ownershipRenounced: false, mintable: true, honeypotRisk: 100 });
    expect(report.issues.map((issue) => issue.severity)).toEqual(['critical', 'warning', 'minor']);
  });
});
