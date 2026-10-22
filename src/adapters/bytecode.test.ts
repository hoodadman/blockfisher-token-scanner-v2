import { describe, expect, it } from 'vitest';
import { scanBytecode, signalsFromBytecode } from './bytecode';

// A dispatcher fragment: PUSH4 <selector> EQ, as solc writes it.
const dispatch = (...selectors: string[]) => selectors.map((selector) => `63${selector}14`).join('');
// solc metadata: a CBOR map (a2 ...) followed by its two-byte length. 0xff inside it isn't code.
const metadata = 'a264697066735822ff' + '00'.repeat(32) + '0029';

describe('scanBytecode', () => {
  it('collects selectors from PUSH4 and skips bytes inside other pushes', () => {
    // PUSH32 whose data happens to contain a mint selector and an 0xff byte.
    const constant = `7f${'40c10f19ff'.padEnd(64, '0')}`;
    const scan = scanBytecode(`0x6080${dispatch('8456cb59')}${constant}00`);
    expect([...scan.selectors]).toEqual(['8456cb59']);
    expect(scan.selfDestruct).toBe(false);
  });

  it('finds self-destruct in code but not in the metadata blob', () => {
    expect(scanBytecode(`0x6080${metadata}`).selfDestruct).toBe(false);
    expect(scanBytecode(`0x6080ff00${metadata}`).selfDestruct).toBe(true);
  });
});

describe('signalsFromBytecode', () => {
  it('reports owner powers it finds, and only ever as "yes"', () => {
    const code = `0x${dispatch('40c10f19', 'f9f92be4', '0cc835a3', 'f3bdc228')}`;
    expect(signalsFromBytecode(code, false)).toEqual({
      mintable: true,
      hasBlacklist: true,
      canFreeze: true,
      feesChangeable: true,
      canTakeTokens: true,
    });
    expect(signalsFromBytecode(`0x${dispatch('a9059cbb')}`, undefined)).toEqual({});
  });

  it('ignores owner powers once the owner has given up control, but still flags self-destruct', () => {
    expect(signalsFromBytecode(`0x${dispatch('40c10f19')}ff00`, true)).toEqual({ suspiciousFunctions: true });
  });
});
