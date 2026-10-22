import type { TokenSignals } from '../scoring';

/** What the sell probe reported: amounts are in the token's and the chain coin's smallest units. */
export interface SellTest {
  /** 0 = the buy failed, 1 = bought but couldn't sell, 2 = both went through. */
  stage: 0 | 1 | 2;
  buyExpected: bigint;
  buyReceived: bigint;
  sellExpected: bigint;
  sellReceived: bigint;
}

/** Share of the expected amount that didn't arrive, to one decimal place. */
function lossPct(expected: bigint, received: bigint): number | undefined {
  if (expected <= 0n) return undefined;
  const lostBps = ((expected - received) * 10_000n) / expected;
  return Math.max(0, Math.min(100, Number(lostBps) / 100));
}

/**
 * A failed buy says nothing: trading may simply not be open yet, or the token may
 * not trade on the pool we tried. A buy that works followed by a sell that fails
 * is the honeypot pattern.
 */
export function signalsFromSellTest(test: SellTest): Partial<TokenSignals> {
  if (test.stage === 0) return {};
  if (test.stage === 1) return { honeypotRisk: 100 };
  const signals: Partial<TokenSignals> = { honeypotRisk: 0 };
  const buy = lossPct(test.buyExpected, test.buyReceived);
  const sell = lossPct(test.sellExpected, test.sellReceived);
  if (buy !== undefined) signals.buyFeePct = buy;
  if (sell !== undefined) signals.sellFeePct = sell;
  return signals;
}
