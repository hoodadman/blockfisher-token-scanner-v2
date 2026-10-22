import { describe, expect, it } from 'vitest';
import { buildSignals, crossCheck, crossCheckSources, signalsFromOnChain, type SolanaMintAccount } from '.';

const AUTHORITY = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const OWNER = '0x1111111111111111111111111111111111111111';
const IMPLEMENTATION = '0x00000000000000000000000043506849d7c04f9138d1a2050bbf3a0c054402dd';

const classicMint = (info: Record<string, unknown>): SolanaMintAccount => ({
  program: 'spl-token',
  parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null, ...info } },
});

describe('signalsFromOnChain on Solana', () => {
  it('reads mint and freeze authority, and knows a classic mint has no Token-2022 extras', () => {
    expect(signalsFromOnChain({ kind: 'solana', mint: classicMint({ freezeAuthority: AUTHORITY }) })).toEqual({
      mintable: false,
      canFreeze: true,
      canTakeTokens: false,
      honeypotRisk: 0,
      transferFeePct: 0,
      feesChangeable: false,
      externalCall: false,
      canPause: false,
      tradingPaused: false,
    });
  });

  it('flags Token-2022 extensions that let someone take, tax, block or hook transfers', () => {
    const mint: SolanaMintAccount = {
      program: 'spl-token-2022',
      parsed: {
        type: 'mint',
        info: {
          mintAuthority: AUTHORITY,
          freezeAuthority: null,
          extensions: [
            { extension: 'permanentDelegate', state: { delegate: AUTHORITY } },
            {
              extension: 'transferFeeConfig',
              state: {
                transferFeeConfigAuthority: AUTHORITY,
                olderTransferFee: { epoch: 600, transferFeeBasisPoints: 100 },
                newerTransferFee: { epoch: 700, transferFeeBasisPoints: 950 },
              },
            },
            { extension: 'transferHook', state: { authority: null, programId: AUTHORITY } },
            { extension: 'nonTransferable' },
            { extension: 'tokenMetadata', state: { updateAuthority: AUTHORITY } },
          ],
        },
      },
    };
    expect(signalsFromOnChain({ kind: 'solana', mint })).toMatchObject({
      mintable: true,
      canFreeze: false,
      canTakeTokens: true,
      honeypotRisk: 100,
      transferFeePct: 9.5,
      feesChangeable: true,
      externalCall: true,
      metadataMutable: true,
    });
  });

  it('treats a frozen default account state as a freeze power', () => {
    const mint: SolanaMintAccount = {
      program: 'spl-token-2022',
      parsed: { type: 'mint', info: { extensions: [{ extension: 'defaultAccountState', state: { accountState: 'frozen' } }] } },
    };
    expect(signalsFromOnChain({ kind: 'solana', mint }).canFreeze).toBe(true);
  });

  it('says nothing about an account that is not a mint', () => {
    expect(signalsFromOnChain({ kind: 'solana', mint: { program: 'spl-token', parsed: { type: 'account' } } })).toEqual({});
  });
});

describe('signalsFromOnChain on EVM chains', () => {
  it('reports an upgradeable proxy and an owner who gave up control', () => {
    const contract = { code: '0x6080', owner: '0x0000000000000000000000000000000000000000', proxySlots: [IMPLEMENTATION] };
    expect(signalsFromOnChain({ kind: 'evm', contract })).toEqual({ upgradeable: true, ownershipRenounced: true });
  });

  it('never claims a contract is not upgradeable, since custom proxies hide it', () => {
    expect(signalsFromOnChain({ kind: 'evm', contract: { code: '0x6080', owner: OWNER, proxySlots: [] } })).toEqual({
      ownershipRenounced: false,
    });
  });

  it('says nothing when no contract is deployed at the address', () => {
    expect(signalsFromOnChain({ kind: 'evm', contract: { code: '0x', owner: OWNER, proxySlots: [] } })).toEqual({});
  });
});

describe('crossCheck', () => {
  it('marks each of our reads as agreeing, disagreeing or filling a gap', () => {
    expect(crossCheck({ mintable: false, canFreeze: false }, { mintable: false, canFreeze: true, canPause: false })).toEqual([
      { signal: 'mintable', outcome: 'agree', goPlus: false, onChain: false },
      { signal: 'canFreeze', outcome: 'disagree', goPlus: false, onChain: true },
      { signal: 'canPause', outcome: 'filled', goPlus: undefined, onChain: false },
    ]);
  });
});

describe('buildSignals with our own read', () => {
  it('uses the live owner, so owner-only powers count again when GoPlus saw a stale burn address', () => {
    const sources = {
      goPlus: { is_mintable: '1', owner_address: '0x000000000000000000000000000000000000dead', hidden_owner: '0', can_take_back_ownership: '0' },
      onChain: { kind: 'evm' as const, contract: { code: '0x6080', owner: OWNER, proxySlots: [] } },
    };
    expect(buildSignals('eth', { goPlus: sources.goPlus }).mintable).toBe(false);
    expect(buildSignals('eth', sources)).toMatchObject({ mintable: true, ownershipRenounced: false });
    expect(crossCheckSources('eth', sources)).toEqual([
      { signal: 'ownershipRenounced', outcome: 'disagree', goPlus: true, onChain: false },
    ]);
  });

  it('lets a live Solana read overrule GoPlus and fill what GoPlus left out', () => {
    const signals = buildSignals('sol', {
      goPlus: { mintable: { status: '0' } },
      onChain: { kind: 'solana', mint: classicMint({ mintAuthority: AUTHORITY }) },
    });
    expect(signals).toMatchObject({ mintable: true, canFreeze: false, canPause: false });
  });
});
