import { PLANS } from '../plans/plans';

/**
 * What can be bought, and what a package costs. Each scanner is its own monthly product;
 * the discount grows with each extra scanner in one package (10%, 20%, 30%...). The
 * portfolio scanner is priced on its own and never counts towards the package.
 *
 * Only launched scanners can be bought. A scanner launches once it is built, tested in
 * house and tested by the public; until then checkout shows it as "Coming later".
 */
export type ScannerId = 'token' | 'wallet' | 'defi' | 'chain';

/** The token scanner is the only one with tiers; the others are one price each for now. */
export type TokenTier = 'pro' | 'ultra';

export interface Scanner {
  id: ScannerId;
  name: string;
  launched: boolean;
  /** Pounds a month at full price. The token scanner's comes from its tier. */
  monthlyPrice: number;
}

/** Each later scanner's planned price. */
export const SCANNER_PRICE = 9.99;

export const SCANNERS: readonly Scanner[] = [
  { id: 'token', name: 'Token scanner', launched: true, monthlyPrice: PLANS.pro.monthlyPrice },
  { id: 'wallet', name: 'Wallet scanner', launched: false, monthlyPrice: SCANNER_PRICE },
  { id: 'defi', name: 'DeFi app scanner', launched: false, monthlyPrice: SCANNER_PRICE },
  { id: 'chain', name: 'Blockchain scanner', launched: false, monthlyPrice: SCANNER_PRICE },
];

export const SCANNER_IDS: readonly ScannerId[] = SCANNERS.map((scanner) => scanner.id);

export function scannerOf(id: ScannerId): Scanner {
  return SCANNERS.find((scanner) => scanner.id === id)!;
}

/** The discount on the nth scanner in a package (0 for the first): 10% more for each one. */
export function bundleDiscount(position: number): number {
  return Math.min(0.1 * position, 0.9);
}

export interface QuoteLine {
  scanner: ScannerId;
  name: string;
  /** Pounds a month before the discount. */
  fullPrice: number;
  /** Whole percent off, 0 for the first scanner. */
  discountPercent: number;
  /** Pounds a month the buyer pays for this scanner. */
  price: number;
}

export interface Quote {
  lines: QuoteLine[];
  /** Pounds a month for the whole package. */
  total: number;
  /** What the package would cost with no discount. */
  fullTotal: number;
  tier: TokenTier;
}

export interface Selection {
  scanners: readonly ScannerId[];
  /** Which token scanner plan, when the token scanner is ticked. Pro unless set. */
  tier?: TokenTier;
}

const pence = (pounds: number) => Math.round(pounds * 100);

/**
 * Prices a package. The dearest scanner is charged in full and the discounts go on the
 * rest in price order, so 2 scanners at £9.99 are £9.99 + £8.99 = £18.98, 3 are £26.97
 * and 4 are £33.96. Each line is rounded to the penny on its own, as Stripe charges it.
 */
export function quote(selection: Selection): Quote {
  const tier: TokenTier = selection.tier === 'ultra' ? 'ultra' : 'pro';
  const unique = SCANNER_IDS.filter((id) => selection.scanners.includes(id));
  const priced = unique
    .map((id) => {
      const scanner = scannerOf(id);
      const fullPrice = id === 'token' ? PLANS[tier].monthlyPrice : scanner.monthlyPrice;
      return { scanner: id, name: id === 'token' ? `${scanner.name} ${PLANS[tier].name}` : scanner.name, fullPrice };
    })
    .sort((a, b) => b.fullPrice - a.fullPrice);
  const lines = priced.map((line, position) => {
    const discount = bundleDiscount(position);
    return {
      ...line,
      discountPercent: Math.round(discount * 100),
      price: pence(line.fullPrice * (1 - discount)) / 100,
    };
  });
  return {
    lines,
    total: lines.reduce((sum, line) => sum + pence(line.price), 0) / 100,
    fullTotal: lines.reduce((sum, line) => sum + pence(line.fullPrice), 0) / 100,
    tier,
  };
}

/** Reads a checkout request: launched scanners only, at least one. */
export function parseSelection(body: unknown): Selection | undefined {
  const raw = (body ?? {}) as { scanners?: unknown; tier?: unknown };
  if (!Array.isArray(raw.scanners)) return undefined;
  const scanners = SCANNER_IDS.filter((id) => (raw.scanners as unknown[]).includes(id));
  if (scanners.length === 0 || scanners.some((id) => !scannerOf(id).launched)) return undefined;
  return { scanners, tier: raw.tier === 'ultra' ? 'ultra' : 'pro' };
}

export const poundsText = (amount: number) => `£${amount.toFixed(2)}`;
