import type { TokenSignals } from '../scoring';

// A scan of the contract's compiled code for functions that give someone power
// over holders. Names can be changed or hidden, so a hit adds caution but a miss
// proves nothing: this scan only ever reports "yes".

type Power = 'mintable' | 'canPause' | 'hasBlacklist' | 'feesChangeable' | 'canTakeTokens';

/** First four bytes of keccak256 of each function signature. */
const SELECTORS: Record<Power, readonly string[]> = {
  mintable: [
    '40c10f19', // mint(address,uint256)
    'a0712d68', // mint(uint256)
    '449a52f8', // mintTo(address,uint256)
    'cc872b66', // issue(uint256)
  ],
  canPause: [
    '8456cb59', // pause()
    '16c38b3c', // setPaused(bool)
  ],
  hasBlacklist: [
    'f9f92be4', // blacklist(address)
    '0ecb93c0', // addBlackList(address)
    '44337ea1', // addToBlacklist(address)
    '153b0d1e', // setBlacklist(address,bool)
    'd01dd6d2', // setBlacklisted(address,bool)
    '455a4396', // blacklistAddress(address,bool)
    '9c0db5f3', // setBots(address[],bool)
    '342aa8b5', // setBot(address,bool)
    'd34628cc', // addBots(address[])
  ],
  feesChangeable: [
    '69fe0e2d', // setFee(uint256)
    '0b78f9c0', // setFees(uint256,uint256)
    'c4081a4c', // setTaxFee(uint256)
    '0cc835a3', // setBuyFee(uint256)
    '8b4cee08', // setSellFee(uint256)
    '2e5bb6ff', // setTax(uint256)
    'c647b20e', // setTaxes(uint256,uint256)
    '6db79437', // updateFees(uint256,uint256)
    'dc1052e2', // setBuyTax(uint256)
    '8cd09d50', // setSellTax(uint256)
    '8095d564', // updateBuyFees(uint256,uint256,uint256)
    'c17b5b8c', // updateSellFees(uint256,uint256,uint256)
    '061c82d0', // setTaxFeePercent(uint256)
  ],
  canTakeTokens: [
    'f3bdc228', // destroyBlackFunds(address)
  ],
};

const PUSH1 = 0x60;
const PUSH4 = 0x63;
const PUSH32 = 0x7f;
const SELFDESTRUCT = 0xff;

export interface CodeScan {
  selectors: ReadonlySet<string>;
  selfDestruct: boolean;
}

/**
 * Solidity appends a CBOR metadata blob whose last two bytes give its length.
 * It isn't code, and its bytes would otherwise read as random opcodes.
 */
function withoutMetadata(hex: string): string {
  if (hex.length < 4) return hex;
  const length = parseInt(hex.slice(-4), 16);
  const start = hex.length - 4 - length * 2;
  // CBOR maps from solc start with 0xa1 to 0xa3 (one to three entries).
  return start >= 0 && /^a[1-3]/.test(hex.slice(start, start + 2)) ? hex.slice(0, start) : hex;
}

/** Walks the opcodes, skipping push data so bytes inside constants aren't read as instructions. */
export function scanBytecode(code: string): CodeScan {
  const hex = withoutMetadata((code.startsWith('0x') ? code.slice(2) : code).toLowerCase());
  const selectors = new Set<string>();
  let selfDestruct = false;
  for (let i = 0; i < hex.length; i += 2) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    if (op === SELFDESTRUCT) selfDestruct = true;
    if (op >= PUSH1 && op <= PUSH32) {
      const size = op - PUSH1 + 1;
      if (op === PUSH4) selectors.add(hex.slice(i + 2, i + 10).toLowerCase());
      i += size * 2;
    }
  }
  return { selectors, selfDestruct };
}

/**
 * Owner powers found in the code. Skipped once the owner has given up control,
 * since nobody can call those functions any more.
 */
export function signalsFromBytecode(code: string, ownershipRenounced: boolean | undefined): Partial<TokenSignals> {
  const scan = scanBytecode(code);
  const signals: Partial<TokenSignals> = {};
  if (scan.selfDestruct) signals.suspiciousFunctions = true;
  if (ownershipRenounced === true) return signals;
  for (const [power, selectors] of Object.entries(SELECTORS) as Array<[Power, readonly string[]]>) {
    if (selectors.some((selector) => scan.selectors.has(selector))) signals[power] = true;
  }
  if (signals.hasBlacklist) signals.canFreeze = true;
  return signals;
}
