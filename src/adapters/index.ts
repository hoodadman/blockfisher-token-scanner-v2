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

export * from './coingecko';
export * from './dexscreener';
export * from './goplus';
export * from './insightx';
export * from './onchain';

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
}

/** GoPlus decides whether owner-only functions still matter from the owner it saw; use the live owner instead. */
function withLiveOwner(goPlus: GoPlusToken, onChain: OnChainRead | undefined): GoPlusToken {
  if (onChain?.kind !== 'evm' || onChain.contract.owner === undefined) return goPlus;
  return { ...(goPlus as GoPlusEvmToken), owner_address: onChain.contract.owner };
}

/** Pass whichever API responses you have; anything missing shows up as "couldn't check". */
export function buildSignals(network: InsightXNetwork, sources: SignalSources): TokenSignals {
  const goPlus = sources.goPlus && withLiveOwner(sources.goPlus, sources.onChain);
  return {
    chain: chainFromNetwork(network),
    ...(sources.dexScreenerPairs && signalsFromDexScreener(sources.dexScreenerPairs)),
    ...(goPlus && signalsFromGoPlus(goPlusChainId(network), goPlus)),
    ...(sources.onChain && signalsFromOnChain(sources.onChain)),
    ...(sources.insightXDexMetrics && signalsFromInsightXDexMetrics(network, sources.insightXDexMetrics)),
  };
}

/** Where our own read agreed with GoPlus, disagreed, or filled a gap GoPlus left. */
export function crossCheckSources(network: InsightXNetwork, sources: SignalSources): CrossCheckEntry[] {
  if (!sources.onChain) return [];
  const goPlus = sources.goPlus ? signalsFromGoPlus(goPlusChainId(network), sources.goPlus) : {};
  return crossCheck(goPlus, signalsFromOnChain(sources.onChain));
}
