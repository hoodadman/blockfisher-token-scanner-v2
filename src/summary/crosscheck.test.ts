import { describe, expect, it } from 'vitest';
import { crossCheckLine } from './crosscheck';

describe('crossCheckLine', () => {
  it('says nothing when our own read did not run', () => {
    expect(crossCheckLine(null)).toBeNull();
    expect(crossCheckLine([])).toBeNull();
  });

  it('leads with a mismatch, since that changed the result', () => {
    expect(
      crossCheckLine([
        { signal: 'mintable', outcome: 'agree', goPlus: false, onChain: false },
        { signal: 'canFreeze', outcome: 'disagree', goPlus: false, onChain: true },
      ]),
    ).toBe(
      'We also read the blockchain ourselves. 1 answer didn’t match our security data, so we used the blockchain’s, because it shows the token as it is right now.',
    );
  });

  it('reports matches and the gaps it filled', () => {
    expect(
      crossCheckLine([
        { signal: 'mintable', outcome: 'agree', goPlus: false, onChain: false },
        { signal: 'canFreeze', outcome: 'agree', goPlus: true, onChain: true },
        { signal: 'canPause', outcome: 'filled', onChain: false },
      ]),
    ).toBe('Checked twice: we read the blockchain ourselves and 2 answers matched our security data. It also filled in 1 answer the security data was missing.');
    expect(crossCheckLine([{ signal: 'canPause', outcome: 'filled', onChain: false }])).toBe(
      'Our security data was missing 1 answer, so we read it straight from the blockchain.',
    );
  });
});
