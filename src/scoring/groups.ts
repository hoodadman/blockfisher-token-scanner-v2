import type { CheckSummary, Issue, Severity, TrustReport } from './types';

export type GroupStatus = 'issue' | 'pass' | 'unknown';

export interface SecurityGroupDef {
  id: string;
  label: string;
  passLabel: string;
  about: string;
  checks: readonly string[];
}

/** Ten labels that cover every underlying check. */
export const SECURITY_GROUPS: readonly SecurityGroupDef[] = [
  {
    id: 'selling',
    label: 'Can you sell',
    passLabel: 'You should be able to sell',
    about:
      'You should be able to sell what you buy. A honeypot blocks selling. Other rules can force a leftover balance, cap how much you sell, or add a cooldown. Risk: your money can be stuck while the price falls.',
    checks: ['honeypot', 'sellLimits', 'antiWhale', 'tradingCooldown'],
  },
  {
    id: 'seize',
    label: 'Taking your tokens',
    passLabel: 'They can’t take tokens from your wallet',
    about:
      'The creator should not be able to change your balance, blacklist your wallet, or give their own wallets special selling rights. Risk: they can take tokens, lock you in, or sell while you cannot.',
    checks: ['canTakeTokens', 'canFreeze', 'hasBlacklist', 'hasWhitelist'],
  },
  {
    id: 'history',
    label: 'Creator’s past',
    passLabel: 'No known scam history',
    about:
      'We check whether the creator’s wallet is linked to other scam tokens. Risk: a wallet tied to earlier traps, especially if it can still mint, pause, or block selling, is a serious warning.',
    checks: ['knownScamCreator'],
  },
  {
    id: 'pause',
    label: 'Stopping trades',
    passLabel: 'They can’t switch off trading',
    about:
      'The creator can freeze all transfers, so buying, selling, or sending becomes impossible. Risk: your tokens can be stuck until they switch trading back on.',
    checks: ['pause'],
  },
  {
    id: 'fees',
    label: 'Extra fees',
    passLabel: 'Fees look ordinary',
    about:
      'A buy or sell tax takes a cut of each trade. The creator may also be able to change that rate later. Risk: a high or raised sell fee can trap you or wipe most of the exit.',
    checks: ['fees', 'feesChangeable'],
  },
  {
    id: 'mint',
    label: 'Making more tokens',
    passLabel: 'They can’t print more',
    about:
      'Mintable means the creator can increase the supply. Risk: new tokens dumped into the pool make yours worth less.',
    checks: ['mintable'],
  },
  {
    id: 'code',
    label: 'The code',
    passLabel: 'The code looks locked down',
    about:
      'The code should be public, not a proxy the creator can rewrite, and without a hidden owner or outside calls that run during a transfer. Risk: hidden or changeable code can become a trap after you buy.',
    checks: ['publicCode', 'upgradeable', 'hiddenControl', 'externalCall', 'suspiciousFunctions'],
  },
  {
    id: 'pool',
    label: 'Trading pot',
    passLabel: 'The trading pot looks healthy',
    about:
      'We look at how much money is in the shared pot used for trading, and whether it is locked. Risk: an unlocked or tiny pot can be emptied or make selling crash the price.',
    checks: ['liquidityLock', 'liquidity'],
  },
  {
    id: 'control',
    label: 'Who’s in charge',
    passLabel: 'The creator has given up extra powers',
    about:
      'We check whether the creator has given up owner status, or can still change the name and picture. Risk: an owner can still pause trading, mint, or change fees; a changeable name can impersonate another token.',
    checks: ['ownership', 'metadataMutable'],
  },
  {
    id: 'holders',
    label: 'Who holds it',
    passLabel: 'Ownership looks spread out',
    about:
      'We look at how new it is, whether it has a public page, how much the creator still holds, and whether a few wallets own most of the tokens. Risk: a small group, or a large creator balance, can dump the price.',
    checks: ['tokenAge', 'socials', 'clusters', 'bundlers', 'snipers', 'devHoldings', 'topHolders'],
  },
];

export interface GroupedCheck {
  id: string;
  label: string;
  status: GroupStatus;
  summary: string;
  details: string;
  severity?: Severity;
  experimental: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, minor: 2 };

export function groupSecurity(report: TrustReport): GroupedCheck[] {
  const issues = new Map(report.issues.map((issue) => [issue.id, issue]));
  const passed = new Map(report.passed.map((item) => [item.id, item]));
  const unknown = new Map(report.notChecked.map((item) => [item.id, item]));

  const rows: GroupedCheck[] = [];
  for (const group of SECURITY_GROUPS) {
    const foundIssues = group.checks.map((id) => issues.get(id)).filter((item): item is Issue => Boolean(item));
    const foundPassed = group.checks.map((id) => passed.get(id)).filter((item): item is CheckSummary => Boolean(item));
    const foundUnknown = group.checks.map((id) => unknown.get(id)).filter((item): item is CheckSummary => Boolean(item));
    if (foundIssues.length + foundPassed.length + foundUnknown.length === 0) continue;

    const worst = [...foundIssues].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
    if (worst) {
      rows.push({
        id: group.id,
        label: group.label,
        status: 'issue',
        summary: worst.summary,
        details: [worst.details, foundPassed.length ? `${foundPassed.length} related check${foundPassed.length === 1 ? '' : 's'} still looked fine.` : '']
          .filter(Boolean)
          .join(' '),
        severity: worst.severity,
        experimental: worst.experimental || foundIssues.some((issue) => issue.experimental),
      });
      continue;
    }
    // A group only passes when every check in it ran. A half-checked group must not read as safe.
    if (foundPassed.length && foundUnknown.length) {
      rows.push({
        id: group.id,
        label: group.label,
        status: 'unknown',
        summary: `We checked ${foundPassed.length} of ${foundPassed.length + foundUnknown.length} things here; ${foundUnknown
          .map((item) => item.label.toLowerCase())
          .join(', ')} couldn’t be checked.`,
        details: group.about,
        experimental: foundUnknown.every((item) => item.experimental),
      });
      continue;
    }
    if (foundPassed.length) {
      rows.push({
        id: group.id,
        label: group.passLabel,
        status: 'pass',
        summary: '',
        details: group.about,
        experimental: foundPassed.some((item) => item.experimental) && foundPassed.every((item) => item.experimental),
      });
      continue;
    }
    rows.push({
      id: group.id,
      label: group.label,
      status: 'unknown',
      summary: 'We didn’t have the data for this.',
      details: group.about,
      experimental: foundUnknown.some((item) => item.experimental),
    });
  }
  return rows;
}
