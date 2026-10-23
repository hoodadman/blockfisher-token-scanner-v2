import { apiHosts } from '../api/hosts';
import type { PillarBrief, SummaryFacts } from './types';
import { localBrief } from './local';

const BRIEF_TIMEOUT_MS = 10_000;

export async function fetchBrief(facts: SummaryFacts, signal?: AbortSignal): Promise<PillarBrief> {
  const fallback = localBrief(facts);
  try {
    const response = await fetch(apiHosts().summarise, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(facts),
      // The written brief is optional; the local one is used if the model is slow.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(BRIEF_TIMEOUT_MS)]) : AbortSignal.timeout(BRIEF_TIMEOUT_MS),
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as Partial<PillarBrief>;
    if (!body.security || !body.community || !body.foundation) return fallback;
    return { security: body.security, community: body.community, foundation: body.foundation };
  } catch {
    return fallback;
  }
}
