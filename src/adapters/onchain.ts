import type { TokenSignals } from '../scoring';
import { signalsFromBytecode } from './bytecode';
import { compact } from './util';

// Our own reads of the blockchain, used as a second opinion next to GoPlus.
// Everything here is read straight from chain state, so a value we can't read
// stays undefined instead of being guessed.

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

/** A Token-2022 extension as the Solana RPC returns it with `jsonParsed`. */
export interface SolanaMintExtension {
  extension: string;
  state?: Record<string, unknown>;
}

export interface SolanaTransferFee {
  epoch?: number;
  transferFeeBasisPoints?: number;
}

/** `getAccountInfo` with `jsonParsed` encoding for a token mint. */
export interface SolanaMintAccount {
  program?: string;
  parsed?: {
    type?: string;
    info?: {
      mintAuthority?: string | null;
      freezeAuthority?: string | null;
      extensions?: readonly SolanaMintExtension[];
    };
  };
}

/** Raw answers from `owner()`, `getOwner()` and the standard proxy storage slots. */
export interface EvmContractRead {
  /** Bytecode at the address; "0x" when nothing is deployed there. */
  code: string;
  /** Owner address, or undefined when the contract has no readable owner function. */
  owner?: string;
  /** Non-empty values of the standard proxy slots (EIP-1967, EIP-1822, OpenZeppelin legacy). */
  proxySlots: readonly string[];
  /** Code the proxy currently runs, when one of those slots points at it. */
  implementationCode?: string;
}

export type OnChainRead = { kind: 'solana'; mint: SolanaMintAccount } | { kind: 'evm'; contract: EvmContractRead };

const isSet = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

function extension(mint: SolanaMintAccount, name: string): SolanaMintExtension | undefined {
  return mint.parsed?.info?.extensions?.find((item) => item.extension === name);
}

function feeBasisPoints(state: Record<string, unknown> | undefined): number {
  const fees = [state?.olderTransferFee, state?.newerTransferFee] as Array<SolanaTransferFee | undefined>;
  return Math.max(0, ...fees.map((fee) => fee?.transferFeeBasisPoints ?? 0));
}

export function ownerGaveUp(address: string | undefined): boolean | undefined {
  if (address === undefined) return undefined;
  const normalised = address.toLowerCase();
  return normalised === '' || normalised === ZERO || normalised === DEAD;
}

function signalsFromSolanaMint(mint: SolanaMintAccount): Partial<TokenSignals> {
  const info = mint.parsed?.info;
  if (mint.parsed?.type !== 'mint' || !info) return {};

  // Classic SPL mints can't carry Token-2022 extensions, so their absence is a real "no".
  const known = mint.program === 'spl-token' || mint.program === 'spl-token-2022';
  const fee = extension(mint, 'transferFeeConfig');
  const delegate = extension(mint, 'permanentDelegate');
  const hook = extension(mint, 'transferHook');
  const pausable = extension(mint, 'pausableConfig');
  const defaultState = extension(mint, 'defaultAccountState');
  const metadata = extension(mint, 'tokenMetadata');
  const ifKnown = <T>(value: T) => (known ? value : undefined);

  return compact({
    mintable: isSet(info.mintAuthority),
    canFreeze: isSet(info.freezeAuthority) || defaultState?.state?.accountState === 'frozen',
    canTakeTokens: ifKnown(isSet(delegate?.state?.delegate)),
    honeypotRisk: known ? (extension(mint, 'nonTransferable') ? 100 : 0) : undefined,
    transferFeePct: ifKnown(feeBasisPoints(fee?.state) / 100),
    feesChangeable: ifKnown(isSet(fee?.state?.transferFeeConfigAuthority)),
    externalCall: ifKnown(isSet(hook?.state?.programId) || isSet(hook?.state?.authority)),
    canPause: ifKnown(isSet(pausable?.state?.authority)),
    tradingPaused: ifKnown(pausable?.state?.paused === true),
    // Classic mints keep metadata in a separate Metaplex account, which we don't read yet.
    metadataMutable: metadata ? isSet(metadata.state?.updateAuthority) : undefined,
  });
}

function signalsFromEvmContract(contract: EvmContractRead): Partial<TokenSignals> {
  if (contract.code === '0x' || contract.code === '') return {};
  // A filled proxy slot proves the code can be swapped. Empty slots don't prove it can't:
  // custom proxies store the address elsewhere, so we only ever report "yes" here.
  const ownershipRenounced = ownerGaveUp(contract.owner);
  return compact({
    ...signalsFromBytecode(contract.implementationCode ?? contract.code, ownershipRenounced),
    upgradeable: contract.proxySlots.length > 0 ? true : undefined,
    ownershipRenounced,
  });
}

export function signalsFromOnChain(read: OnChainRead): Partial<TokenSignals> {
  return read.kind === 'solana' ? signalsFromSolanaMint(read.mint) : signalsFromEvmContract(read.contract);
}

export type CrossCheckOutcome = 'agree' | 'disagree' | 'filled';

export interface CrossCheckEntry {
  signal: keyof TokenSignals;
  outcome: CrossCheckOutcome;
  goPlus?: TokenSignals[keyof TokenSignals];
  onChain: TokenSignals[keyof TokenSignals];
}

/** Measured fees wobble with rounding, so numbers within a percentage point count as the same answer. */
function same(a: unknown, b: unknown): boolean {
  return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1 : a === b;
}

/**
 * Compares what GoPlus said with what we read ourselves. "filled" means GoPlus
 * had no answer and our read supplied one.
 */
export function crossCheck(goPlus: Partial<TokenSignals>, onChain: Partial<TokenSignals>): CrossCheckEntry[] {
  return (Object.keys(onChain) as Array<keyof TokenSignals>).map((signal) => {
    const ours = onChain[signal];
    const theirs = goPlus[signal];
    const outcome: CrossCheckOutcome = theirs === undefined ? 'filled' : same(theirs, ours) ? 'agree' : 'disagree';
    return { signal, outcome, goPlus: theirs, onChain: ours };
  });
}
