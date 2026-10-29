import type { Quote, ScannerId } from './catalog';
import { hmacSha256Hex, sameText } from './crypto';

/**
 * The few Stripe calls billing needs, over Stripe's REST API (no SDK). Prices are sent
 * with each checkout (price_data), so nothing has to be set up in the Stripe dashboard
 * except the webhook: Stripe shows each line with its own name and discount.
 *
 * STRIPE_SECRET_KEY: the account's secret key (sk_test_... while testing).
 * STRIPE_WEBHOOK_SECRET: the signing secret of the webhook pointed at /api/billing/webhook.
 */
const API = 'https://api.stripe.com/v1';

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret?: string;
}

/** Stripe's form encoding: nested objects and arrays as a[b][0]=c. */
export function formEncode(value: unknown, prefix = '', out = new URLSearchParams()): URLSearchParams {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => formEncode(item, `${prefix}[${index}]`, out));
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) formEncode(item, prefix ? `${prefix}[${key}]` : key, out);
  } else {
    out.append(prefix, String(value));
  }
  return out;
}

async function call<T>(config: StripeConfig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? formEncode(body).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!response.ok) throw new StripeError(json.error?.message ?? `Stripe answered ${response.status}`, response.status);
  return json as T;
}

/** What we keep on the Stripe subscription, so its events say what was bought. */
export interface PackageMetadata {
  scanners: string;
  tier: string;
}

export function packageMetadata(quote: Quote): PackageMetadata {
  return { scanners: quote.lines.map((line) => line.scanner).join(','), tier: quote.tier };
}

export function scannersFrom(metadata: { scanners?: string } | undefined): ScannerId[] {
  return String(metadata?.scanners ?? '')
    .split(',')
    .filter(Boolean) as ScannerId[];
}

export interface CheckoutSession {
  id: string;
  url?: string;
  status?: string;
  payment_status?: string;
  customer?: string;
  subscription?: string;
  customer_details?: { email?: string };
  customer_email?: string;
  metadata?: Partial<PackageMetadata>;
}

export function createCheckout(
  config: StripeConfig,
  quote: Quote,
  options: { successUrl: string; cancelUrl: string; email?: string; customer?: string },
): Promise<CheckoutSession> {
  const metadata = packageMetadata(quote);
  return call<CheckoutSession>(config, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    ...(options.customer ? { customer: options.customer } : options.email ? { customer_email: options.email } : {}),
    line_items: quote.lines.map((line) => ({
      quantity: 1,
      price_data: {
        currency: 'gbp',
        unit_amount: Math.round(line.price * 100),
        recurring: { interval: 'month' },
        product_data: { name: line.discountPercent > 0 ? `${line.name} (${line.discountPercent}% package discount)` : line.name },
      },
    })),
    metadata,
    subscription_data: { metadata },
    allow_promotion_codes: false,
  });
}

export function getCheckout(config: StripeConfig, id: string): Promise<CheckoutSession> {
  return call<CheckoutSession>(config, 'GET', `/checkout/sessions/${encodeURIComponent(id)}`);
}

/** Stripe's own page for changing card, viewing invoices or cancelling. */
export function createPortal(config: StripeConfig, customer: string, returnUrl: string): Promise<{ url: string }> {
  return call<{ url: string }>(config, 'POST', '/billing_portal/sessions', { customer, return_url: returnUrl });
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/** Webhooks older than this are refused, so a captured one can't be replayed later. */
const TOLERANCE_SECONDS = 5 * 60;

/** Checks the Stripe-Signature header against the raw body and returns the event. */
export async function verifyWebhook(rawBody: string, header: string | undefined, secret: string, now = Date.now()): Promise<StripeEvent> {
  const parts = String(header ?? '').split(',').map((part) => part.split('=') as [string, string]);
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isFinite(timestamp) || signatures.length === 0) throw new StripeError('Missing signature', 400);
  if (Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) throw new StripeError('Signature too old', 400);
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  const matches = signatures.some((signature) => sameText(signature, expected));
  if (!matches) throw new StripeError('Bad signature', 400);
  return JSON.parse(rawBody) as StripeEvent;
}

/** Builds a valid Stripe-Signature header; for tests. */
export async function signWebhook(rawBody: string, secret: string, now = Date.now()): Promise<string> {
  const timestamp = Math.floor(now / 1000);
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;
}
