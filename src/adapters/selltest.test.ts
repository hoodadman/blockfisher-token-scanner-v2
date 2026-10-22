import { describe, expect, it } from 'vitest';
import { buildSignals, crossCheckSources, signalsFromSellTest, type SellTest } from '.';

const test = (stage: SellTest['stage'], buy: [bigint, bigint], sell: [bigint, bigint]): SellTest => ({
  stage,
  buyExpected: buy[0],
  buyReceived: buy[1],
  sellExpected: sell[0],
  sellReceived: sell[1],
});

describe('signalsFromSellTest', () => {
  it('measures the real buy and sell tax from what came back', () => {
    expect(signalsFromSellTest(test(2, [10_000n, 9_500n], [9_500n, 8_360n]))).toEqual({ honeypotRisk: 0, buyFeePct: 5, sellFeePct: 12 });
  });

  it('calls a token a honeypot when the buy worked and the sell did not', () => {
    expect(signalsFromSellTest(test(1, [10_000n, 10_000n], [10_000n, 0n]))).toEqual({ honeypotRisk: 100 });
  });

  it('says nothing when even the buy failed, since trading may just not be open', () => {
    expect(signalsFromSellTest(test(0, [10_000n, 0n], [0n, 0n]))).toEqual({});
  });
});

describe('buildSignals with a sell test', () => {
  it('keeps the worse answer, so the test adds caution but never clears a GoPlus flag', () => {
    const passed = test(2, [10_000n, 10_000n], [10_000n, 8_800n]);
    expect(buildSignals('eth', { goPlus: { is_honeypot: '1', sell_tax: '0.02' }, sellTest: passed })).toMatchObject({
      honeypotRisk: 100,
      sellFeePct: 12,
      buyFeePct: 0,
    });
  });

  it('fills the sell test when GoPlus has nothing, and counts close fees as agreeing', () => {
    const passed = test(2, [10_000n, 9_950n], [10_000n, 10_000n]);
    expect(buildSignals('base', { sellTest: passed })).toMatchObject({ honeypotRisk: 0, buyFeePct: 0.5, sellFeePct: 0 });
    expect(crossCheckSources('base', { goPlus: { buy_tax: '0.01', is_honeypot: '0' }, sellTest: passed })).toEqual([
      { signal: 'honeypotRisk', outcome: 'agree', goPlus: 0, onChain: 0 },
      { signal: 'buyFeePct', outcome: 'agree', goPlus: 1, onChain: 0.5 },
      { signal: 'sellFeePct', outcome: 'filled', goPlus: undefined, onChain: 0 },
    ]);
  });
});
