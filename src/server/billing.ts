/**
 * The billing and account endpoints. server.mjs routes /api/billing/* and /api/account/*
 * here (from the build of api.ts, which re-exports these) and passes the access key from
 * the Authorization header. Like api.ts, this file never touches the socket.
 */
import { Accounts, memoryAccounts, viewOf, type AccountStore } from '../billing/accounts';
import { SCANNERS, parseSelection, quote } from '../billing/catalog';
import { mailerFrom, type Mailer } from '../billing/email';
import { StripeError, createCheckout, createPortal, getCheckout, scannersFrom, verifyWebhook, type CheckoutSession, type StripeConfig } from '../billing/stripe';
import { PLANS } from '../plans/plans';
import type { ApiReply } from './api';

let accounts = new Accounts(memoryAccounts());
let stripe: StripeConfig | undefined;
let mailer: Mailer = mailerFrom({});
/** Where the scanner's own page is served, for Stripe's return links and sign-in links. */
let publicUrl = 'http://localhost:5181';
let checkoutOpen = false;

export interface BillingOptions {
  accounts?: AccountStore;
  stripe?: StripeConfig;
  mailer?: Mailer;
  publicUrl?: string;
  /** True only when PAID_PLANS=billing: scans then run on the plan the account paid for. */
  enabled?: boolean;
}

export function configureBilling(options: BillingOptions): void {
  if (options.accounts) accounts = new Accounts(options.accounts);
  if (options.stripe) stripe = options.stripe;
  if (options.mailer) mailer = options.mailer;
  if (options.publicUrl) publicUrl = options.publicUrl.replace(/\/$/, '');
  checkoutOpen = Boolean(options.enabled && stripe?.secretKey);
}

export function accountsFor(): Accounts {
  return accounts;
}

/** For /api/health: is billing set up, and will accounts survive a restart? */
export function billingHealth() {
  return { checkout: checkoutOpen, stripeKey: Boolean(stripe?.secretKey), webhookSecret: Boolean(stripe?.webhookSecret), accounts: accounts.kind, mail: mailer.kind };
}

const reply = (status: number, body: Record<string, unknown>): ApiReply => ({ status, body: { ok: status < 400, ...body } });
const notOpen = () => reply(503, { text: 'Paid plans are not open yet.' });

/** GET /api/billing/config: what the checkout can sell. */
export function handleBillingConfig(): ApiReply {
  return reply(200, {
    checkout: checkoutOpen,
    scanners: SCANNERS,
    tiers: { pro: PLANS.pro.monthlyPrice, ultra: PLANS.ultra.monthlyPrice },
  });
}

/** POST /api/billing/checkout {scanners, tier, email?}: a Stripe Checkout page for the package. */
export async function handleCheckout(body: unknown, key: string | undefined): Promise<ApiReply> {
  if (!checkoutOpen || !stripe) return notOpen();
  const selection = parseSelection(body);
  if (!selection) return reply(400, { text: 'Tick at least one scanner that is on sale.' });
  const account = await accounts.byKey(key);
  if (account && viewOf(account).paying) {
    return reply(409, { text: 'You already have a plan. Use Manage billing to change or cancel it.' });
  }
  const email = typeof (body as { email?: unknown })?.email === 'string' ? (body as { email: string }).email.trim() : undefined;
  try {
    const session = await createCheckout(stripe, quote(selection), {
      successUrl: `${publicUrl}/?checkout=done&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${publicUrl}/?checkout=cancelled`,
      customer: account?.customer,
      email: account?.email ?? (email && email.includes('@') ? email : undefined),
    });
    return reply(200, { url: session.url });
  } catch (error) {
    console.error('checkout failed', error);
    return reply(502, { text: 'Checkout is not answering. Try again in a minute.' });
  }
}

async function recordCheckout(session: CheckoutSession): Promise<void> {
  const account = await accounts.applyPackage({
    email: session.customer_details?.email ?? session.customer_email,
    customer: session.customer,
    subscription: session.subscription,
    status: 'active',
    scanners: scannersFrom(session.metadata),
    tier: session.metadata?.tier === 'ultra' ? 'ultra' : 'pro',
  });
  if (account) await accounts.linkCheckout(session.id, account);
}

/** POST /api/billing/webhook: Stripe's events, signed. The body must be the raw text. */
export async function handleWebhook(rawBody: string, signature: string | undefined): Promise<ApiReply> {
  if (!stripe?.webhookSecret) return notOpen();
  let event;
  try {
    event = await verifyWebhook(rawBody, signature, stripe.webhookSecret);
  } catch (error) {
    return reply(400, { text: error instanceof StripeError ? error.message : 'Bad webhook' });
  }
  const object = event.data.object as Record<string, unknown> & { metadata?: { scanners?: string; tier?: string } };
  if (event.type === 'checkout.session.completed' && object.mode === 'subscription') {
    await recordCheckout(object as unknown as CheckoutSession);
  } else if (event.type.startsWith('customer.subscription.')) {
    await accounts.applyPackage({
      customer: typeof object.customer === 'string' ? object.customer : undefined,
      subscription: typeof object.id === 'string' ? object.id : undefined,
      status: event.type === 'customer.subscription.deleted' ? 'canceled' : String(object.status ?? 'active'),
      scanners: scannersFrom(object.metadata),
      tier: object.metadata?.tier === 'ultra' ? 'ultra' : 'pro',
    });
  }
  return reply(200, { received: true });
}

/**
 * POST /api/billing/claim {sessionId}: the success page swaps its checkout for an access
 * key, once. If the webhook hasn't arrived yet, asks Stripe about the checkout directly.
 */
export async function handleClaim(body: unknown): Promise<ApiReply> {
  const sessionId = String((body as { sessionId?: unknown })?.sessionId ?? '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return reply(400, { text: 'Send the checkout id.' });
  let claimed = await accounts.claimKey(sessionId);
  if (claimed === undefined && stripe) {
    try {
      const session = await getCheckout(stripe, sessionId);
      if (session.status === 'complete') {
        await recordCheckout(session);
        claimed = await accounts.claimKey(sessionId);
      }
    } catch (error) {
      console.error('claim lookup failed', error);
    }
  }
  if (claimed === 'claimed') return reply(409, { text: 'This checkout has already been used to sign in. Sign in with your email instead.' });
  if (!claimed) return reply(404, { text: 'We couldn’t find a finished checkout. If you paid, sign in with your email in a minute.' });
  return reply(200, { key: claimed.key, account: viewOf(claimed.account) });
}

/** POST /api/account/signin {email}: emails a sign-in link. Answers the same whether or not the email has an account. */
export async function handleSignIn(body: unknown): Promise<ApiReply> {
  const email = String((body as { email?: unknown })?.email ?? '').trim();
  if (!email.includes('@') || email.length > 254) return reply(400, { text: 'Enter the email you paid with.' });
  const token = await accounts.startSignIn(email);
  if (token) {
    try {
      await mailer.sendSignIn(email, `${publicUrl}/?signin=${encodeURIComponent(token)}`);
    } catch (error) {
      console.error('sign-in email failed', error);
      return reply(502, { text: 'We couldn’t send the email. Try again in a minute.' });
    }
  }
  return reply(200, { text: 'If that email has a Blockfisher plan, a sign-in link is on its way. It works once, for 30 minutes.' });
}

/** POST /api/account/redeem {token}: swaps the emailed link's token for an access key. */
export async function handleRedeem(body: unknown): Promise<ApiReply> {
  const token = String((body as { token?: unknown })?.token ?? '');
  const signedIn = token ? await accounts.redeemSignIn(token) : undefined;
  if (!signedIn) return reply(400, { text: 'That sign-in link has expired or was already used. Ask for a new one.' });
  return reply(200, { key: signedIn.key, account: viewOf(signedIn.account) });
}

/** GET /api/account: the signed-in account. */
export async function handleAccount(key: string | undefined): Promise<ApiReply> {
  const account = await accounts.byKey(key);
  return account ? reply(200, { account: viewOf(account) }) : reply(401, { text: 'Not signed in.' });
}

/** POST /api/account/portal: Stripe's page to change the card, see invoices or cancel. */
export async function handlePortal(key: string | undefined): Promise<ApiReply> {
  const account = await accounts.byKey(key);
  if (!account) return reply(401, { text: 'Not signed in.' });
  if (!stripe || !account.customer) return notOpen();
  try {
    const portal = await createPortal(stripe, account.customer, `${publicUrl}/`);
    return reply(200, { url: portal.url });
  } catch (error) {
    console.error('portal failed', error);
    return reply(502, { text: 'Billing is not answering. Try again in a minute.' });
  }
}

/** POST /api/account/signout: this browser's key stops working. */
export async function handleSignOut(key: string | undefined): Promise<ApiReply> {
  if (key) await accounts.revokeKey(key);
  return reply(200, {});
}
