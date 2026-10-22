import type { TokenSignals } from '../scoring';
import { signalsFromDexScreener, type DexScreenerPair } from './dexscreener';
import { signalsFromGoPlus, type GoPlusChainId, type GoPlusEvmToken, type GoPlusToken } from './goplus';
import {
  chainFromNetwork,
  signalsFromInsightXDexMetrics,
  type InsightXDexMetrics,
  type InsightXNetwork,
} from './insightx';
import { crossCheck, signalsFromOnChain, type CrossCheckEntry, type OnChainRead } from './onchain';
import { signalsFromSellTest, type SellTest } from './selltest';

export * from './coingecko';
export * from './dexscreener';
export * from './goplus';
export * from './insightx';
export * from './bytecode';
export * from './onchain';
export * from './selltest';

const GOPLUS_CHAIN: Record<InsightXNetwork, GoPlusChainId> = {
  eth: '1',
  base: '8453',
  bsc: '56',
  sol: 'solana',
};

export const goPlusChainId = (network: InsightXNetwork): GoPlusChainId => GOPLUS_CHAIN[network];

export interface SignalSources {
  dexScreenerPairs?: readonly DexScreenerPair[];
  goPlus?: GoPlusToken;
  insightXDexMetrics?: InsightXDexMetrics;
  /** Our own read of the contract. It overrules GoPlus where they overlap, since it is live chain state. */
  onChain?: OnChainRead;
  /** Our own simulated buy and sell. It can only make the result worse, never clear what GoPlus flagged. */
  sellTest?: SellTest;
}

const SELL_TEST_SIGNALS = ['honeypotRisk', 'buyFeePct', 'sellFeePct'] as const;

/** Keeps the higher of two risk numbers, so the sell test only ever adds caution. */
function worseOf(signals: TokenSignals, test: Partial<TokenSignals>): TokenSignals {
  const merged = { ...signals };
  for (const key of SELL_TEST_SIGNALS) {
    const ours = test[key];
    if (ours === undefined) continue;
    const theirs = merged[key];
    merged[key] = theirs === undefined ? ours : Math.max(theirs, ours);
  }
  return merged;
}

/** GoPlus decides whether owner-only functions still matter from the owner it saw; use the live owner instead. */
function withLiveOwner(goPlus: GoPlusToken, onChain: OnChainRead | undefined): GoPlusToken {
  if (onChain?.kind !== 'evm' || onChain.contract.owner === undefined) return goPlus;
  return { ...(goPlus as GoPlusEvmToken), owner_address: onChain.contract.owner };
}

/** Pass whichever API responses you have; anything missing shows up as "couldn't check". */
export function buildSignals(network: InsightXNetwork, sources: SignalSources): TokenSignals {
  const goPlus = sources.goPlus && withLiveOwner(sources.goPlus, sources.onChain);
  const signals: TokenSignals = {
    chain: chainFromNetwork(network),
    ...(sources.dexScreenerPairs && signalsFromDexScreener(sources.dexScreenerPairs)),
    ...(goPlus && signalsFromGoPlus(goPlusChainId(network), goPlus)),
    ...(sources.onChain && signalsFromOnChain(sources.onChain)),
    ...(sources.insightXDexMetrics && signalsFromInsightXDexMetrics(network, sources.insightXDexMetrics)),
  };
  return sources.sellTest ? worseOf(signals, signalsFromSellTest(sources.sellTest)) : signals;
}

/** Where our own read agreed with GoPlus, disagreed, or filled a gap GoPlus left. */
export function crossCheckSources(network: InsightXNetwork, sources: SignalSources): CrossCheckEntry[] {
  const goPlus = sources.goPlus ? signalsFromGoPlus(goPlusChainId(network), sources.goPlus) : {};
  return crossCheck(goPlus, {
    ...(sources.onChain && signalsFromOnChain(sources.onChain)),
    ...(sources.sellTest && signalsFromSellTest(sources.sellTest)),
  });
}
