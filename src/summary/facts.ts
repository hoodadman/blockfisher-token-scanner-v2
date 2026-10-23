import type { CommunityReport } from '../community';
import type { FoundationReport } from '../foundation';
import { groupSecurity } from '../scoring';
import type { TrustReport } from '../scoring';
import type { SummaryFacts } from './types';

export function summaryFacts(input: {
  name?: string;
  overall: number | null;
  security: TrustReport;
  community?: CommunityReport;
  foundation: FoundationReport;
}): SummaryFacts {
  return {
    name: input.name,
    overall: input.overall,
    security: {
      score: input.security.score,
      groups: groupSecurity(input.security).map((group) => ({
        label: group.label,
        status: group.status,
        summary: group.summary,
      })),
    },
    community: {
      score: input.community?.score ?? null,
      handle: input.community?.official?.handle,
      followers: input.community?.official?.followers,
      replies: input.community?.official?.averageReplies,
      otherPosts: input.community?.mentions.total ?? input.community?.mentions.counted,
    },
    foundation: {
      score: input.foundation.score,
      facts: input.foundation.facts.map((fact) => ({
        label: fact.label,
        summary: fact.summary,
        status: fact.status,
      })),
    },
  };
}
