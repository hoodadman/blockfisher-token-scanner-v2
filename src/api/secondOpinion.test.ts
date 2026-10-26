import { describe, expect, it } from 'vitest';
import { readHoneypot, readRugCheck, worseOf } from './secondOpinion';

describe('readHoneypot', () => {
  it('turns a failed test sale into a confirmed honeypot', () => {
    const { signals, opinion } = readHoneypot({ honeypotResult: { isHoneypot: true }, simulationResult: { buyTax: 0, sellTax: 99 } });
    expect(signals).toMatchObject({ honeypotRisk: 100, sellFeePct: 99, buyFeePct: 0 });
    expect(opinion.findings[0]).toMatch(/may not be able to sell/);
  });

  it('finds nothing on a clean token', () => {
    const { signals, opinion } = readHoneypot({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 } });
    expect(signals.honeypotRisk).toBeUndefined();
    expect(opinion).toEqual({ source: 'Honeypot.is', ok: true, findings: [] });
  });
});

describe('readRugCheck', () => {
  it('maps the risks we score and lists the serious ones, worst first', () => {
    const { signals, opinion } = readRugCheck({
      lpLockedPct: 16,
      risks: [
        { name: 'Mutable metadata', description: 'The owner can change the metadata', level: 'warn' },
        { name: 'Freeze Authority still enabled', description: 'Tokens can be frozen', level: 'danger' },
        { name: 'Low amount of holders', level: 'info' },
      ],
    });
    expect(signals).toEqual({ metadataMutable: true, canFreeze: true, liquidityLockedPct: 16 });
    expect(opinion.findings).toEqual(['Freeze Authority still enabled: Tokens can be frozen', 'Mutable metadata: The owner can change the metadata']);
  });
});

describe('worseOf', () => {
  it('keeps the worse reading of each field and never clears a problem', () => {
    const merged = worseOf(
      { chain: 'evm', honeypotRisk: 0, sellFeePct: 12, mintable: true, liquidityLockedPct: 90 },
      { honeypotRisk: 100, sellFeePct: 5, mintable: false as unknown as true, liquidityLockedPct: 40 },
    );
    expect(merged).toMatchObject({ honeypotRisk: 100, sellFeePct: 12, mintable: true, liquidityLockedPct: 40 });
  });
});
