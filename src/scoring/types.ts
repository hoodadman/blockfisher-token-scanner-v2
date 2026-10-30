export type ChainFamily = 'evm' | 'solana';

/**
 * Everything the score is built from, independent of which API supplied it.
 * Leave a field undefined when the data isn't available: the check is then
 * reported as "couldn't check" rather than treated as a pass.
 * Percentages are 0–100.
 */
export interface TokenSignals {
  chain: ChainFamily;

  // Contract security
  /** 0 = no sign of a honeypot, 100 = confirmed honeypot. */
  honeypotRisk?: number;
  canTakeTokens?: boolean;
  knownScamCreator?: boolean;
  tradingPaused?: boolean;
  canPause?: boolean;
  buyFeePct?: number;
  sellFeePct?: number;
  transferFeePct?: number;
  feesChangeable?: boolean;
  mintable?: boolean;
  canFreeze?: boolean;
  hasBlacklist?: boolean;
  hasWhitelist?: boolean;
  codeVerified?: boolean;
  upgradeable?: boolean;
  hiddenControl?: boolean;
  sellLimited?: boolean;
  cannotSellAll?: boolean;
  antiWhale?: boolean;
  tradingCooldown?: boolean;
  externalCall?: boolean;
  suspiciousFunctions?: boolean;
  liquidityLockedPct?: number;
  ownershipRenounced?: boolean;
  metadataMutable?: boolean;

  // Market
  liquidityUsd?: number;
  /** Milliseconds since the Unix epoch. */
  launchedAt?: number;
  hasWebsiteOrSocials?: boolean;

  // Holder analysis (experimental)
  clusterPct?: number;
  bundlersPct?: number;
  snipersPct?: number;
  devPct?: number;
  insidersPct?: number;
  top10Pct?: number;
}

export type Severity = 'critical' | 'warning' | 'minor';
export type Category = 'security' | 'market' | 'holders';
export type RiskBand = 'low' | 'medium' | 'high';

/** Weight and wording for one outcome of a check. `{value}` is replaced with the measured value. */
export interface Tier {
  severity: Severity;
  points: number;
  title: string;
  summary: string;
  details: string;
}

export interface CheckDefinition {
  id: string;
  /** Neutral name, shown in the "couldn't check" list. */
  name: string;
  /** Shown in the "checks passed" list. */
  passLabel: string;
  category: Category;
  experimental?: boolean;
  /** Defaults to every chain. */
  appliesTo?: readonly ChainFamily[];
  /** The tier that applies, null when the check passes, or undefined when the data is missing. */
  evaluate: (signals: TokenSignals, now: number) => Tier | null | undefined;
  measure?: (signals: TokenSignals, now: number) => string;
  /** Counted as an issue when the data is missing, instead of being skipped. */
  ifUnknown?: Tier | ((signals: TokenSignals) => Tier);
}

export interface Issue {
  id: string;
  category: Category;
  experimental: boolean;
  severity: Severity;
  points: number;
  title: string;
  summary: string;
  details: string;
}

export interface CheckSummary {
  id: string;
  label: string;
  experimental: boolean;
  about?: string;
}

export interface TrustReport {
  /** 0–100, or null when too few checks had data to give a score. */
  score: number | null;
  band: RiskBand | null;
  /** Most severe first. */
  issues: Issue[];
  passed: CheckSummary[];
  notChecked: CheckSummary[];
  /** Core (non-experimental) checks that had data, out of those that apply to the chain. */
  coverage: { checked: number; total: number };
}
