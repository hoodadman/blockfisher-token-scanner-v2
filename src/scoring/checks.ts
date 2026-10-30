import { tooltipFor } from './glossary';
import type { CheckDefinition, Tier, TokenSignals } from './types';

// Weights, thresholds and wording for every check. The public scoring docs should match this file.

type Rule = readonly [threshold: number, tier: Tier];

const HOUR = 3_600_000;

function atLeast(value: number | undefined, rules: readonly Rule[]) {
  if (value === undefined) return undefined;
  return rules.find(([min]) => value >= min)?.[1] ?? null;
}

function below(value: number | undefined, rules: readonly Rule[]) {
  if (value === undefined) return undefined;
  return rules.find(([max]) => value < max)?.[1] ?? null;
}

function whenTrue(flag: boolean | undefined, tier: Tier) {
  if (flag === undefined) return undefined;
  return flag ? tier : null;
}

function whenFalse(flag: boolean | undefined, tier: Tier) {
  return whenTrue(flag === undefined ? undefined : !flag, tier);
}

function sumDefined(...values: Array<number | undefined>) {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
}

function highestFee(s: TokenSignals) {
  const fees = [s.buyFeePct, s.sellFeePct, s.transferFeePct].filter((f): f is number => f !== undefined);
  return fees.length ? Math.max(...fees) : undefined;
}

function ageInHours(s: TokenSignals, now: number) {
  return s.launchedAt === undefined ? undefined : (now - s.launchedAt) / HOUR;
}

const percent = (value: number) => `${Number(value.toFixed(1))}%`;

const dollars = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

function describeFee(s: TokenSignals) {
  const top = highestFee(s) ?? 0;
  if (s.transferFeePct === top) return `${percent(top)} on every transfer`;
  if (s.buyFeePct === top && s.sellFeePct === top) return `${percent(top)} when you buy or sell`;
  return `${percent(top)} when you ${s.sellFeePct === top ? 'sell' : 'buy'}`;
}

function describeAge(s: TokenSignals, now: number) {
  const hours = ageInHours(s, now) ?? 0;
  if (hours < 1) return 'less than an hour';
  if (hours < 48) {
    const whole = Math.floor(hours);
    return `${whole} ${whole === 1 ? 'hour' : 'hours'}`;
  }
  return `${Math.floor(hours / 24)} days`;
}

export const CHECKS: readonly CheckDefinition[] = [
  // ---------------------------------------------------------------- Security
  {
    id: 'honeypot',
    name: 'Honeypot',
    passLabel: 'Passed the sell test',
    category: 'security',
    evaluate: (s) =>
      atLeast(s.honeypotRisk, [
        [90, {
          severity: 'critical',
          points: 100,
          title: 'Likely can’t be sold',
          summary: 'Tests suggest you could buy this token but not sell it.',
          details: tooltipFor('honeypot'),
        }],
        [50, {
          severity: 'warning',
          points: 30,
          title: 'Selling may be blocked',
          summary: 'Our sell test found signs that selling could be restricted.',
          details: tooltipFor('honeypot'),
        }],
      ]),
    ifUnknown: (s) => ({
      severity: 'warning',
      points: 30,
      title: s.chain === 'solana' ? 'We can’t test selling on Solana yet' : 'Sell test couldn’t run',
      summary: 'We couldn’t confirm that this token can be sold.',
      details: tooltipFor('honeypot'),
    }),
  },
  {
    id: 'canTakeTokens',
    name: 'Owner can change balance',
    passLabel: 'Creator can’t take your tokens',
    category: 'security',
    evaluate: (s) =>
      whenTrue(s.canTakeTokens, {
        severity: 'critical',
        points: 60,
        title: 'Creator can take your tokens',
        summary: 'The creator can remove or change the tokens in your wallet.',
        details: tooltipFor('canTakeTokens'),
      }),
  },
  {
    id: 'knownScamCreator',
    name: 'Creator address',
    passLabel: 'Creator has no known scams',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.knownScamCreator, {
        severity: 'critical',
        points: 60,
        title: 'Creator linked to scams',
        summary: 'Whoever made this token has made scam tokens before.',
        details: tooltipFor('knownScamCreator'),
      }),
  },
  {
    id: 'pause',
    name: 'Transfer pausable',
    passLabel: 'Trading can’t be paused',
    category: 'security',
    evaluate: (s) => {
      if (s.tradingPaused) {
        return {
          severity: 'critical',
          points: 60,
          title: 'Trading is switched off',
          summary: 'Nobody can buy, sell or send this token right now.',
          details: tooltipFor('pause'),
        };
      }
      return whenTrue(s.canPause, {
        severity: 'warning',
        points: 15,
        title: 'Trading can be paused',
        summary: 'The creator can switch off trading at any time.',
        details: tooltipFor('pause'),
      });
    },
  },
  {
    id: 'fees',
    name: 'Buy and sell tax',
    passLabel: 'Low or no trading fees',
    category: 'security',
    measure: describeFee,
    evaluate: (s) =>
      atLeast(highestFee(s), [
        [30, {
          severity: 'critical',
          points: 60,
          title: 'Very high fees',
          summary: 'The token charges {value}.',
          details: tooltipFor('fees'),
        }],
        [10, {
          severity: 'warning',
          points: 20,
          title: 'High fees',
          summary: 'The token charges {value}.',
          details: tooltipFor('fees'),
        }],
        [5, {
          severity: 'minor',
          points: 5,
          title: 'Trading fees',
          summary: 'The token charges {value}.',
          details: tooltipFor('fees'),
        }],
      ]),
  },
  {
    id: 'mintable',
    name: 'Mintable',
    passLabel: 'No more tokens can be made',
    category: 'security',
    evaluate: (s) =>
      whenTrue(s.mintable, {
        severity: 'warning',
        points: 25,
        title: 'Creator can make more tokens',
        summary: 'New tokens can be created at any time, making yours worth less.',
        details: tooltipFor('mintable'),
      }),
  },
  {
    id: 'canFreeze',
    name: 'Has blacklist',
    passLabel: 'Wallets can’t be frozen',
    category: 'security',
    appliesTo: ['solana'],
    evaluate: (s) =>
      whenTrue(s.canFreeze, {
        severity: 'warning',
        points: 25,
        title: 'Creator can freeze wallets',
        summary: 'The creator can lock tokens in a wallet so they can’t be sold.',
        details: tooltipFor('canFreeze'),
      }),
  },
  {
    id: 'hasBlacklist',
    name: 'Has blacklist',
    passLabel: 'No blacklist',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.hasBlacklist, {
        severity: 'warning',
        points: 25,
        title: 'Creator can blacklist wallets',
        summary: 'The creator can lock a wallet out of buying, selling, or sending.',
        details: tooltipFor('hasBlacklist'),
      }),
  },
  {
    id: 'hasWhitelist',
    name: 'Has whitelist',
    passLabel: 'No whitelist',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.hasWhitelist, {
        severity: 'warning',
        points: 15,
        title: 'Some wallets skip the rules',
        summary: 'Chosen wallets can trade when others cannot.',
        details: tooltipFor('hasWhitelist'),
      }),
  },
  {
    id: 'feesChangeable',
    name: 'Tax modifiable',
    passLabel: 'Fees can’t be changed',
    category: 'security',
    evaluate: (s) =>
      whenTrue(s.feesChangeable, {
        severity: 'warning',
        points: 20,
        title: 'Fees can be raised',
        summary: 'The creator can change the trading fees whenever they like.',
        details: tooltipFor('feesChangeable'),
      }),
  },
  {
    id: 'publicCode',
    name: 'Open source',
    passLabel: 'Code is public',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenFalse(s.codeVerified, {
        severity: 'warning',
        points: 25,
        title: 'Code isn’t public',
        summary: 'The token’s code hasn’t been published, so nobody can check it.',
        details: tooltipFor('publicCode'),
      }),
  },
  {
    id: 'upgradeable',
    name: 'Proxy contract',
    passLabel: 'Code can’t be replaced',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.upgradeable, {
        severity: 'warning',
        points: 15,
        title: 'Code can be replaced',
        summary: 'The creator can swap the token’s code for new code.',
        details: tooltipFor('upgradeable'),
      }),
  },
  {
    id: 'hiddenControl',
    name: 'Hidden owner',
    passLabel: 'No hidden control',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.hiddenControl, {
        severity: 'warning',
        points: 25,
        title: 'Hidden control',
        summary: 'The code hides the real owner or lets them take control back.',
        details: tooltipFor('hiddenControl'),
      }),
  },
  {
    id: 'externalCall',
    name: 'External call',
    passLabel: 'No risky outside calls',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.externalCall, {
        severity: 'warning',
        points: 15,
        title: 'Transfer runs outside code',
        summary: 'A transfer can run code that is not part of the token.',
        details: tooltipFor('externalCall'),
      }),
  },
  {
    id: 'suspiciousFunctions',
    name: 'Has suspicious functions',
    passLabel: 'No suspicious functions',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.suspiciousFunctions, {
        severity: 'warning',
        points: 20,
        title: 'Suspicious functions',
        summary: 'The contract has extra powers that honest tokens usually do not need.',
        details: tooltipFor('suspiciousFunctions'),
      }),
  },
  {
    id: 'sellLimits',
    name: 'Can’t sell all',
    passLabel: 'No limits on selling',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.cannotSellAll ?? s.sellLimited, {
        severity: 'warning',
        points: 20,
        title: 'Selling can be limited',
        summary: 'You might not be allowed to sell all your tokens when you want.',
        details: tooltipFor('sellLimits'),
      }),
  },
  {
    id: 'antiWhale',
    name: 'Is anti-whale',
    passLabel: 'No anti-whale limits',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.antiWhale, {
        severity: 'warning',
        points: 15,
        title: 'Selling or holding can be capped',
        summary: 'The creator can limit how much you buy, sell, or hold.',
        details: tooltipFor('antiWhale'),
      }),
  },
  {
    id: 'tradingCooldown',
    name: 'Trading cooldown',
    passLabel: 'No trading cooldown',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenTrue(s.tradingCooldown, {
        severity: 'warning',
        points: 15,
        title: 'Trades can be delayed',
        summary: 'The creator can force a wait between transfers.',
        details: tooltipFor('tradingCooldown'),
      }),
  },
  {
    id: 'liquidityLock',
    name: 'Locked trading pool',
    passLabel: 'Trading pool is locked',
    category: 'security',
    measure: (s) => percent(s.liquidityLockedPct ?? 0),
    evaluate: (s) =>
      below(s.liquidityLockedPct, [
        [50, {
          severity: 'warning',
          points: 25,
          title: 'Trading pool isn’t locked',
          summary: 'The creator could empty the pool of money that lets people sell.',
          details: tooltipFor('liquidityLock'),
        }],
        [90, {
          severity: 'minor',
          points: 5,
          title: 'Trading pool partly locked',
          summary: 'Only {value} of the trading pool is locked.',
          details: tooltipFor('liquidityLock'),
        }],
      ]),
  },
  {
    id: 'ownership',
    name: 'Ownership renounced',
    passLabel: 'Creator has given up control',
    category: 'security',
    appliesTo: ['evm'],
    evaluate: (s) =>
      whenFalse(s.ownershipRenounced, {
        severity: 'minor',
        points: 3,
        title: 'Creator still has control',
        summary: 'The creator hasn’t given up control of the token’s settings.',
        details: tooltipFor('ownership'),
      }),
  },
  {
    id: 'metadataMutable',
    name: 'Name and logo',
    passLabel: 'Name and logo are fixed',
    category: 'security',
    appliesTo: ['solana'],
    evaluate: (s) =>
      whenTrue(s.metadataMutable, {
        severity: 'minor',
        points: 3,
        title: 'Name and logo can change',
        summary: 'The creator can still change the token’s name, symbol and image.',
        details: tooltipFor('metadataMutable'),
      }),
  },

  // ------------------------------------------------------------------ Market
  {
    id: 'liquidity',
    name: 'Trading pool size',
    passLabel: 'Healthy trading pool',
    category: 'market',
    measure: (s) => dollars(s.liquidityUsd ?? 0),
    evaluate: (s) =>
      below(s.liquidityUsd, [
        [10_000, {
          severity: 'warning',
          points: 20,
          title: 'Tiny trading pool',
          summary: 'Only {value} is available for trading, so selling could crash the price.',
          details: tooltipFor('liquidity'),
        }],
        [50_000, {
          severity: 'minor',
          points: 5,
          title: 'Small trading pool',
          summary: 'Only {value} is available for trading.',
          details: tooltipFor('liquidity'),
        }],
      ]),
    // Pools still on a launchpad (such as pump.fun) report no size. At any age, not knowing
    // whether there is money to sell into is a risk in itself.
    ifUnknown: {
      severity: 'warning',
      points: 20,
      title: 'Trading pool size unknown',
      summary: 'We couldn’t see how much is available for trading.',
      details: tooltipFor('liquidity'),
    },
  },
  {
    id: 'tokenAge',
    name: 'Token age',
    passLabel: 'Not brand new',
    category: 'market',
    measure: describeAge,
    evaluate: (s, now) =>
      below(ageInHours(s, now), [
        [24, {
          severity: 'warning',
          points: 20,
          title: 'Brand-new token',
          summary: 'It started trading {value} ago.',
          details: tooltipFor('tokenAge'),
        }],
        [7 * 24, {
          severity: 'minor',
          points: 5,
          title: 'New token',
          summary: 'It started trading {value} ago.',
          details: tooltipFor('tokenAge'),
        }],
      ]),
    ifUnknown: {
      severity: 'minor',
      points: 5,
      title: 'Start date unknown',
      summary: 'We don’t know when it started trading.',
      details: tooltipFor('tokenAge'),
    },
  },
  {
    id: 'socials',
    name: 'Website and social media',
    passLabel: 'Has a website or social media',
    category: 'market',
    evaluate: (s) =>
      whenFalse(s.hasWebsiteOrSocials, {
        severity: 'minor',
        points: 5,
        title: 'No website or social media',
        summary: 'We couldn’t find a website or social accounts for this token.',
        details: tooltipFor('socials'),
      }),
  },

  // ----------------------------------------------------- Holders (experimental)
  {
    id: 'clusters',
    name: 'Linked wallets',
    passLabel: 'No big groups of linked wallets',
    category: 'holders',
    experimental: true,
    measure: (s) => percent(s.clusterPct ?? 0),
    evaluate: (s) =>
      atLeast(s.clusterPct, [
        [50, {
          severity: 'warning',
          points: 30,
          title: 'Linked wallets hold most tokens',
          summary: 'Wallets that seem to belong to the same people hold {value} of all tokens.',
          details: tooltipFor('clusters'),
        }],
        [30, {
          severity: 'warning',
          points: 20,
          title: 'Linked wallets hold a lot',
          summary: 'Wallets that seem to belong to the same people hold {value} of all tokens.',
          details: tooltipFor('clusters'),
        }],
        [15, {
          severity: 'minor',
          points: 5,
          title: 'Some linked wallets',
          summary: 'Wallets that seem to belong to the same people hold {value} of all tokens.',
          details: tooltipFor('clusters'),
        }],
      ]),
  },
  {
    id: 'bundlers',
    name: 'Coordinated buying',
    passLabel: 'Little coordinated buying',
    category: 'holders',
    experimental: true,
    appliesTo: ['solana'],
    measure: (s) => percent(s.bundlersPct ?? 0),
    evaluate: (s) =>
      atLeast(s.bundlersPct, [
        [20, {
          severity: 'warning',
          points: 20,
          title: 'Coordinated buying at launch',
          summary: 'Wallets that bought together at launch hold {value} of all tokens.',
          details: tooltipFor('bundlers'),
        }],
        [5, {
          severity: 'minor',
          points: 5,
          title: 'Some coordinated buying',
          summary: 'Wallets that bought together at launch hold {value} of all tokens.',
          details: tooltipFor('bundlers'),
        }],
      ]),
  },
  {
    id: 'snipers',
    name: 'Launch snipers',
    passLabel: 'Few launch snipers',
    category: 'holders',
    experimental: true,
    appliesTo: ['solana'],
    measure: (s) => percent(s.snipersPct ?? 0),
    evaluate: (s) =>
      atLeast(s.snipersPct, [
        [20, {
          severity: 'warning',
          points: 15,
          title: 'Many launch snipers',
          summary: 'Wallets that bought in the first minute still hold {value} of all tokens.',
          details: tooltipFor('snipers'),
        }],
        [5, {
          severity: 'minor',
          points: 5,
          title: 'Some launch snipers',
          summary: 'Wallets that bought in the first minute still hold {value} of all tokens.',
          details: tooltipFor('snipers'),
        }],
      ]),
  },
  {
    id: 'devHoldings',
    name: 'Creator balance',
    passLabel: 'Creator holds a small share',
    category: 'holders',
    experimental: true,
    appliesTo: ['solana'],
    measure: (s) => percent(sumDefined(s.devPct, s.insidersPct) ?? 0),
    evaluate: (s) =>
      atLeast(sumDefined(s.devPct, s.insidersPct), [
        [15, {
          severity: 'warning',
          points: 20,
          title: 'Creator holds a lot',
          summary: 'The creator and people linked to them hold {value} of all tokens.',
          details: tooltipFor('devHoldings'),
        }],
        [5, {
          severity: 'minor',
          points: 5,
          title: 'Creator holds some tokens',
          summary: 'The creator and people linked to them hold {value} of all tokens.',
          details: tooltipFor('devHoldings'),
        }],
      ]),
  },
  {
    id: 'topHolders',
    name: 'Holder count',
    passLabel: 'Ownership is spread out',
    category: 'holders',
    experimental: true,
    measure: (s) => percent(s.top10Pct ?? 0),
    evaluate: (s) =>
      atLeast(s.top10Pct, [
        [50, {
          severity: 'warning',
          points: 20,
          title: 'A few wallets own most of it',
          summary: 'The 10 biggest wallets own {value} of all tokens.',
          details: tooltipFor('topHolders'),
        }],
        [30, {
          severity: 'minor',
          points: 5,
          title: 'Ownership is concentrated',
          summary: 'The 10 biggest wallets own {value} of all tokens.',
          details: tooltipFor('topHolders'),
        }],
      ]),
  },
];
