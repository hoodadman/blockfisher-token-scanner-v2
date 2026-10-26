import type { InsightXNetwork } from '../adapters';
import type { TokenSignals } from '../scoring';

/**
 * Ultra's second opinion on security: Honeypot.is simulates a buy and a sell on EVM
 * chains, RugCheck reports on Solana tokens. Both are free to call today. Their findings
 * can only make a result worse, never better: a second check that misses a problem
 * doesn't cancel GoPlus finding one.
 */
export interface SecondOpinion {
  source: 'Honeypot.is' | 'RugCheck';
  /** False when the service didn't answer; its checks then add nothing. */
  ok: boolean;
  /** Plain-language findings, worst first. */
  findings: string[];
}

interface Answer {
  opinion: SecondOpinion;
  signals: Partial<TokenSignals>;
}

const TIMEOUT_MS = 8_000;
const HONEYPOT_CHAIN: Partial<Record<InsightXNetwork, number>> = { eth: 1, bsc: 56, base: 8453 };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

interface HoneypotAnswer {
  simulationSuccess?: boolean;
  honeypotResult?: { isHoneypot?: boolean; honeypotReason?: string };
  simulationResult?: { buyTax?: number; sellTax?: number; transferTax?: number };
  summary?: { flags?: Array<{ description?: string } | string> };
}

const pct = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined);

export function readHoneypot(body: HoneypotAnswer): Answer {
  const findings: string[] = [];
  const signals: Partial<TokenSignals> = {};
  if (body.honeypotResult?.isHoneypot) {
    signals.honeypotRisk = 100;
    findings.push('A test sale failed: you may not be able to sell this token.');
  } else if (body.simulationSuccess === false) {
    findings.push('A test buy and sale could not be run, so selling is unconfirmed.');
  }
  const result = body.simulationResult ?? {};
  const fees = { buyFeePct: pct(result.buyTax), sellFeePct: pct(result.sellTax), transferFeePct: pct(result.transferTax) };
  for (const [field, value] of Object.entries(fees) as Array<[keyof typeof fees, number | undefined]>) {
    if (value !== undefined) signals[field] = value;
  }
  if ((fees.sellFeePct ?? 0) >= 10) findings.push(`Selling costs ${fees.sellFeePct}% in a test sale.`);
  if ((fees.buyFeePct ?? 0) >= 10) findings.push(`Buying costs ${fees.buyFeePct}% in a test buy.`);
  for (const flag of body.summary?.flags ?? []) {
    const text = typeof flag === 'string' ? flag : flag.description;
    if (text) findings.push(text);
  }
  return { opinion: { source: 'Honeypot.is', ok: true, findings }, signals };
}

interface RugCheckAnswer {
  risks?: Array<{ name?: string; description?: string; level?: string }>;
  lpLockedPct?: number;
}

const RUGCHECK_SIGNALS: Array<[RegExp, keyof TokenSignals]> = [
  [/mint authority/i, 'mintable'],
  [/freeze authority/i, 'canFreeze'],
  [/mutable metadata/i, 'metadataMutable'],
];

export function readRugCheck(body: RugCheckAnswer): Answer {
  const signals: Partial<TokenSignals> = {};
  const risks = body.risks ?? [];
  for (const risk of risks) {
    for (const [pattern, field] of RUGCHECK_SIGNALS) {
      if (risk.name && pattern.test(risk.name)) (signals as Record<string, unknown>)[field] = true;
    }
  }
  if (typeof body.lpLockedPct === 'number' && Number.isFinite(body.lpLockedPct)) signals.liquidityLockedPct = body.lpLockedPct;
  const rank = (level?: string) => (level === 'danger' ? 0 : level === 'warn' ? 1 : 2);
  const findings = risks
    .filter((risk) => risk.level === 'danger' || risk.level === 'warn')
    .sort((a, b) => rank(a.level) - rank(b.level))
    .map((risk) => [risk.name, risk.description].filter(Boolean).join(': '))
    .filter(Boolean);
  return { opinion: { source: 'RugCheck', ok: true, findings }, signals };
}

/** Undefined when no second opinion covers the chain. Never throws. */
export async function fetchSecondOpinion(network: InsightXNetwork, address: string, signal?: AbortSignal): Promise<Answer | undefined> {
  if (network === 'sol') {
    try {
      return readRugCheck(await getJson<RugCheckAnswer>(`https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`, signal));
    } catch {
      return { opinion: { source: 'RugCheck', ok: false, findings: [] }, signals: {} };
    }
  }
  const chainId = HONEYPOT_CHAIN[network];
  if (!chainId) return undefined;
  try {
    return readHoneypot(await getJson<HoneypotAnswer>(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${chainId}`, signal));
  } catch {
    return { opinion: { source: 'Honeypot.is', ok: false, findings: [] }, signals: {} };
  }
}

const MAX_FIELDS = ['honeypotRisk', 'buyFeePct', 'sellFeePct', 'transferFeePct'] as const;
const TRUE_FIELDS = ['mintable', 'canFreeze', 'metadataMutable'] as const;

/** Adds a second opinion to the signals; each field keeps the worse of the two readings. */
export function worseOf(signals: TokenSignals, extra: Partial<TokenSignals>): TokenSignals {
  const merged: TokenSignals = { ...signals };
  for (const field of MAX_FIELDS) {
    const value = extra[field];
    if (value !== undefined) merged[field] = Math.max(value, signals[field] ?? value);
  }
  for (const field of TRUE_FIELDS) {
    if (extra[field] === true) merged[field] = true;
  }
  if (extra.liquidityLockedPct !== undefined) {
    merged.liquidityLockedPct = Math.min(extra.liquidityLockedPct, signals.liquidityLockedPct ?? extra.liquidityLockedPct);
  }
  return merged;
}
