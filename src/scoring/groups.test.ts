import { describe, expect, it } from 'vitest';
import { CHECKS } from './checks';
import { groupSecurity, SECURITY_GROUPS } from './groups';
import { scoreToken } from './score';
import type { TokenSignals } from './types';

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

describe('SECURITY_GROUPS', () => {
  it('covers every check in ten labels', () => {
    expect(SECURITY_GROUPS).toHaveLength(10);
    const grouped = new Set(SECURITY_GROUPS.flatMap((group) => group.checks));
    expect([...CHECKS.map((check) => check.id)].sort()).toEqual([...grouped].sort());
  });
});

describe('groupSecurity', () => {
  it('collapses a clean token into at most ten pass rows', () => {
    const groups = groupSecurity(scoreToken(cleanEvm, { now: NOW }));
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.length).toBeLessThanOrEqual(10);
    expect(groups.every((group) => group.status === 'pass')).toBe(true);
  });

  it('keeps the worst finding when a group has more than one check', () => {
    const groups = groupSecurity(scoreToken({ ...cleanEvm, liquidityLockedPct: 0, liquidityUsd: 80 }, { now: NOW }));
    const pool = groups.find((group) => group.id === 'pool');
    expect(pool?.status).toBe('issue');
    expect(pool?.severity).toBe('warning');
  });

  it('does not pass a group when some of its checks didn’t run', () => {
    // GoPlus answered everything except "owner can change balance".
    const groups = groupSecurity(scoreToken({ ...cleanEvm, canTakeTokens: undefined }, { now: NOW }));
    const seize = groups.find((group) => group.id === 'seize');
    expect(seize?.status).toBe('unknown');
    expect(seize?.label).toBe('Taking your tokens');
    expect(seize?.summary).toBe('We checked 2 of 3 things here; owner can change balance couldn’t be checked.');
  });
});
