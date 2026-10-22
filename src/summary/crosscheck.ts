import type { CrossCheckEntry } from '../adapters';

const answers = (count: number) => (count === 1 ? '1 answer' : `${count} answers`);

/** One plain sentence on how our own blockchain read compared with the security data, or null when it didn't run. */
export function crossCheckLine(entries: readonly CrossCheckEntry[] | null): string | null {
  if (!entries || entries.length === 0) return null;
  const count = (outcome: CrossCheckEntry['outcome']) => entries.filter((entry) => entry.outcome === outcome).length;
  const agreed = count('agree');
  const differed = count('disagree');
  const filled = count('filled');

  if (differed > 0) {
    return `We also read the blockchain ourselves. ${answers(differed)} didn’t match our security data, so we used the blockchain’s, because it shows the token as it is right now.`;
  }
  if (agreed > 0) {
    const gap = filled > 0 ? ` It also filled in ${answers(filled)} the security data was missing.` : '';
    return `Checked twice: we read the blockchain ourselves and ${answers(agreed)} matched our security data.${gap}`;
  }
  return `Our security data was missing ${answers(filled)}, so we read ${filled === 1 ? 'it' : 'them'} straight from the blockchain.`;
}
