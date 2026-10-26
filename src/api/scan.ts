import type { InsightXNetwork } from '../adapters';
import type { CommunityReport } from '../community';
import type { FoundationReport } from '../foundation';
import { averageScore, groupSecurity, scoreToken, type GroupedCheck, type TrustReport } from '../scoring';
import { localBrief } from '../summary/local';
import { fetchBrief } from '../summary/fetch';
import { summaryFacts } from '../summary/facts';
import type { PillarBrief } from '../summary/types';
import { LookupError, isTokenAddress, lookupToken, type LookupOptions, type Prefetched, type SourceFailure } from './lookup';
import type { SecondOpinion } from './secondOpinion';
import { PLANS, type PlanId } from '../plans/plans';
import { withApiHosts, type ApiHosts } from './hosts';

export interface ScanResult {
  ok: boolean;
  text: string;
}

/** Everything a client needs to draw the score card. Sent as JSON by the server. */
export interface ScanReport {
  address: string;
  chain: { name: string; network: InsightXNetwork };
  name?: string;
  symbol?: string;
  twitter?: string;
  overall: number | null;
  security: TrustReport;
  securityGroups: GroupedCheck[];
  community?: CommunityReport;
  foundation: FoundationReport;
  brief: PillarBrief;
  /** False when the language model did not answer and the built-in brief was used. */
  briefFromModel: boolean;
  failures: SourceFailure[];
  /**
   * When the shared parts were fetched (ms since 1970). Community and holder answers are
   * shared between everyone who scans the token for a while (see share.ts); missing when
   * this scan fetched them itself without our server.
   */
  checked: { community?: number; holders?: number };
  /** The scanner version that ran (plans.ts). */
  plan: PlanId;
  /** Where Community came from: fetched (fresh or shared), the library, or skipped. */
  communitySource: 'fetched' | 'library' | 'skipped';
  /** Ultra's second-opinion security checks. */
  secondOpinion?: SecondOpinion;
  /** Plain-language notes about this result, for the card. */
  notes: string[];
}

const DAY_MS = 24 * 60 * 60_000;

/** What a user should know about where this result came from. */
export function planNotes(report: Pick<ScanReport, 'plan' | 'communitySource' | 'checked'>, now = Date.now()): string[] {
  const notes: string[] = [];
  if (report.communitySource === 'skipped') {
    notes.push('Community wasn’t checked: nobody has scanned this token yet and today’s 5 free new tokens are used up. Pro checks it straight away.');
  }
  const at = report.checked.community;
  if (report.communitySource === 'library' && at !== undefined) {
    const days = Math.floor((now - at) / DAY_MS);
    if (days >= 3) notes.push(`Community is from a saved scan ${days} days old. Pro checks it again.`);
  }
  return notes;
}

function mark(score: number | null): string {
  return score === null ? 'unavailable' : String(score);
}

/** Throws LookupError when the token can't be found. */
export async function scanReport(
  address: string,
  network?: InsightXNetwork,
  signal?: AbortSignal,
  prefetched?: Prefetched,
  fresh = false,
  options: LookupOptions = {},
): Promise<ScanReport> {
  const lookup = await lookupToken(address, signal, network, prefetched, fresh, options);
  const security = scoreToken(lookup.signals);
  const community = lookup.community?.score ?? null;
  const foundation = lookup.foundation.score;
  const overall = averageScore([security.score, community, foundation]);
  const facts = summaryFacts({
    name: lookup.name,
    overall,
    security,
    community: lookup.community,
    foundation: lookup.foundation,
  });
  const fallback = localBrief(facts);
  const brief = await fetchBrief(facts, signal);
  return {
    address: lookup.address,
    chain: { name: lookup.chain.name, network: lookup.chain.network },
    name: lookup.name,
    symbol: lookup.symbol,
    twitter: lookup.twitter,
    overall,
    security,
    securityGroups: groupSecurity(security),
    community: lookup.community,
    foundation: lookup.foundation,
    brief,
    briefFromModel:
      brief.security !== fallback.security ||
      brief.community !== fallback.community ||
      brief.foundation !== fallback.foundation,
    failures: lookup.failures,
    checked: lookup.checked,
    plan: (options.plan ?? PLANS.pro).id,
    communitySource: lookup.communitySource,
    secondOpinion: lookup.secondOpinion,
    notes: planNotes({ plan: (options.plan ?? PLANS.pro).id, communitySource: lookup.communitySource, checked: lookup.checked }),
  };
}

export function scanText(report: ScanReport): string {
  const title = report.name ?? 'Unnamed token';
  const symbol = report.symbol && report.symbol !== report.name ? ` (${report.symbol})` : '';
  const lines = [
    `${title}${symbol} on ${report.chain.name}`,
    report.address,
    `Overall ${mark(report.overall)}. Security ${mark(report.security.score)}. Community ${mark(report.community?.score ?? null)}. Foundation ${mark(report.foundation.score)}.`,
    '',
    `Security: ${report.brief.security}`,
    `Community: ${report.brief.community}`,
    `Foundation: ${report.brief.foundation}`,
  ];
  if (report.failures.length > 0) {
    lines.push('', `Some checks did not run: ${report.failures.map((failure) => failure.source).join(', ')}.`);
  }
  if (report.secondOpinion?.ok && report.secondOpinion.findings.length > 0) {
    lines.push('', `${report.secondOpinion.source}: ${report.secondOpinion.findings.join(' ')}`);
  }
  if (report.notes.length > 0) lines.push('', ...report.notes);
  if (!report.briefFromModel) {
    lines.push('', 'Built-in summary. The language model did not answer.');
  }
  return lines.join('\n');
}

export function scanErrorText(error: unknown): string {
  if (error instanceof LookupError && error.reason === 'invalid') {
    return 'That does not look like a token address. Paste the full contract address.';
  }
  if (error instanceof LookupError && error.reason === 'not-found') {
    const chains = new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(error.searched.map((chain) => chain.name));
    return `No token found on ${chains}. Check the address.`;
  }
  if (error instanceof LookupError && error.reason === 'unavailable') {
    return 'The market data service did not respond. Try again in a minute.';
  }
  return 'The scan failed before it could score this token.';
}

export async function runScan(input: string, hosts: ApiHosts): Promise<ScanResult> {
  return withApiHosts(hosts, async () => {
    const address = input.trim();
    if (!isTokenAddress(address)) {
      return { ok: false, text: scanErrorText(new LookupError('invalid')) };
    }
    try {
      return { ok: true, text: scanText(await scanReport(address)) };
    } catch (error) {
      return { ok: false, text: scanErrorText(error) };
    }
  });
}
