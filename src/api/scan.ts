import { averageScore, scoreToken } from '../scoring';
import { localBrief } from '../summary/local';
import { fetchBrief } from '../summary/fetch';
import { crossCheckLine } from '../summary/crosscheck';
import { summaryFacts } from '../summary/facts';
import { LookupError, isTokenAddress, lookupToken } from './lookup';
import { withApiHosts, type ApiHosts } from './hosts';

export interface ScanResult {
  ok: boolean;
  text: string;
}

function mark(score: number | null): string {
  return score === null ? 'unavailable' : String(score);
}

export async function runScan(input: string, hosts: ApiHosts): Promise<ScanResult> {
  return withApiHosts(hosts, async () => {
    const address = input.trim();
    if (!isTokenAddress(address)) {
      return {
        ok: false,
        text: 'That does not look like a token address. Paste the full contract address.',
      };
    }

    try {
      const lookup = await lookupToken(address);
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
      const brief = await fetchBrief(facts);
      const fromModel =
        brief.security !== fallback.security ||
        brief.community !== fallback.community ||
        brief.foundation !== fallback.foundation;
      const title = lookup.name ?? 'Unnamed token';
      const symbol = lookup.symbol && lookup.symbol !== lookup.name ? ` (${lookup.symbol})` : '';
      const lines = [
        `${title}${symbol} on ${lookup.chain.name}`,
        lookup.address,
        `Overall ${mark(overall)}. Security ${mark(security.score)}. Community ${mark(community)}. Foundation ${mark(foundation)}.`,
        '',
        `Security: ${brief.security}`,
        `Community: ${brief.community}`,
        `Foundation: ${brief.foundation}`,
      ];
      const checkedTwice = crossCheckLine(lookup.crossCheck);
      if (checkedTwice) lines.push('', checkedTwice);
      if (lookup.failures.length > 0) {
        lines.push('', `Some checks did not run: ${lookup.failures.map((failure) => failure.source).join(', ')}.`);
      }
      if (!fromModel) {
        lines.push('', 'Built-in summary. The language model did not answer.');
      }
      return { ok: true, text: lines.join('\n') };
    } catch (error) {
      if (error instanceof LookupError && error.reason === 'not-found') {
        const chains = new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(
          error.searched.map((chain) => chain.name),
        );
        return { ok: false, text: `No token found on ${chains}. Check the address.` };
      }
      if (error instanceof LookupError && error.reason === 'unavailable') {
        return { ok: false, text: 'The market data service did not respond. Try again in a minute.' };
      }
      return { ok: false, text: 'The scan failed before it could score this token.' };
    }
  });
}
