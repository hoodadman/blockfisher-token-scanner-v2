/**
 * The three scanner versions, in one place. Everything that differs between Free, Pro and
 * Ultra is read from here: where the community result comes from, how much of X is read,
 * which extra security checks run, and the limits. Nothing else in the code checks a plan
 * by name.
 *
 * Which plan a scan runs on is decided in server/api.ts: the account's paid plan with
 * PAID_PLANS=billing (see src/billing/), else the plan the caller asks for (the mock
 * "Scanner Pro"). See PAID_PLANS in docs/extension-api.md.
 */
export type PlanId = 'free' | 'pro' | 'ultra';

export const PLAN_IDS: readonly PlanId[] = ['free', 'pro', 'ultra'];

/** How deep a community check reads X: 'ultra' reads more than 'pro'. */
export type Depth = 'pro' | 'ultra';

/** Where a saved community result came from: a full check at either depth, or Free's basic one. */
export type Source = Depth | 'basic';

/** How much of X a fresh community check reads. Each post costs $0.005, each account $0.010. */
export interface XDepth {
  /** Recent posts mentioning the token, with their authors. */
  mentions: number;
  /** The token's own latest posts. */
  ownPosts: number;
  /** Accounts named in the token's bio that we look up. */
  bioPeople: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Mock price in pounds a month; 0 for Free. */
  monthlyPrice: number;
  /** One line for the plan picker. */
  tagline: string;
  /** What the plan gives, for the plan picker. */
  features: readonly string[];
  /**
   * Fresh Community + Foundation checks (new X reads) a member gets each calendar month
   * (UTC). Serving a saved or shared result doesn't use one. Once they are used up, scans
   * show the newest saved result of any age instead (library.ts `choose`). Security is
   * never capped: it runs fresh on every scan. Counted per account, kept in the library's
   * store (server/api.ts).
   */
  freshPerMonth: number;
  /** Oldest shared community answer accepted, in seconds; undefined uses share.ts. */
  communityMaxAge?: number;
  /** Oldest shared holder answer accepted, in seconds; undefined uses share.ts. */
  holdersMaxAge?: number;
  x: XDepth;
  /** Which of the two depths `x` is; results are saved in the library under it. */
  depth: Depth;
  /** Second-opinion security checks (Honeypot.is on EVM, RugCheck on Solana). */
  extraSecurity: boolean;
  /** Re-checks allowed per client in 10 minutes; 0 means no Re-check. */
  rechecks: number;
}

/** Scans any one account (or, without one, any one client) may run an hour, on every plan. */
export const SCANS_PER_HOUR = 60;

/** Pro's X depth, worked out in PR #7: 99% of community scores within 2 points of 50 posts. */
const STANDARD_X: XDepth = { mentions: 10, ownPosts: 15, bioPeople: 5 };

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyPrice: 0,
    tagline: 'Live security checks on every scan.',
    features: [
      'Security checks run fresh on every scan',
      'Liquidity and market data are live',
      '4 fresh community checks a month, at Pro depth',
      'After that, community from the latest saved scan, with its date',
    ],
    freshPerMonth: 4,
    x: STANDARD_X,
    depth: 'pro',
    extraSecurity: false,
    rechecks: 0,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyPrice: 9.99,
    tagline: 'Up-to-date community checks and Re-check.',
    features: [
      'Everything in Free',
      '30 fresh community checks a month',
      'Community never more than a day old (12 hours for new tokens) while you have checks left',
      'Re-check any token for a fresh result',
    ],
    freshPerMonth: 30,
    x: STANDARD_X,
    depth: 'pro',
    extraSecurity: false,
    rechecks: 5,
  },
  ultra: {
    id: 'ultra',
    name: 'Ultra',
    monthlyPrice: 24.99,
    tagline: 'The deepest scan, with a second opinion on security.',
    features: [
      'Everything in Pro',
      'Three times more of X read for the community score',
      'Second-opinion security checks (Honeypot.is, RugCheck)',
      '30 fresh deep community checks a month',
      'Community at most 6 hours old, holders at most 10 minutes',
    ],
    freshPerMonth: 30,
    communityMaxAge: 6 * 60 * 60,
    holdersMaxAge: 10 * 60,
    x: { mentions: 30, ownPosts: 30, bioPeople: 10 },
    depth: 'ultra',
    extraSecurity: true,
    rechecks: 10,
  },
};

/** Unknown or missing values are Pro, so callers that predate plans (the extension) keep working. */
export function planFrom(value: unknown): Plan {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value) ? PLANS[value as PlanId] : PLANS.pro;
}

/** Worst-case X cost of one fresh community check, in dollars (every post by a new author). */
export function xCostOf(depth: XDepth): number {
  const POST = 0.005;
  const USER = 0.01;
  const COUNT = 0.005;
  return depth.mentions * (POST + USER) + depth.ownPosts * POST + USER + depth.bioPeople * USER + COUNT;
}
