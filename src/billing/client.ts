import type { AccountView } from './accounts';
import type { Scanner, ScannerId, TokenTier } from './catalog';

/**
 * The website's side of billing: the access key it keeps, and the calls to
 * /api/billing/* and /api/account/* (src/server/billing.ts).
 */
const KEY = 'blockfisher-key';

export function savedKey(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveKey(key: string | undefined): void {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch {
    // Private windows may refuse; the key still works until the page is closed.
  }
}

export function authHeaders(key = savedKey()): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}

interface Reply {
  ok?: boolean;
  text?: string;
}

async function call<T extends Reply>(path: string, body?: unknown): Promise<T & { status: number }> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as T;
  return { ...json, status: response.status };
}

export interface BillingConfig {
  checkout: boolean;
  scanners: Scanner[];
  tiers: Record<TokenTier, number>;
}

export async function billingConfig(): Promise<BillingConfig | undefined> {
  try {
    const reply = await call<Reply & BillingConfig>('/api/billing/config');
    return reply.ok ? reply : undefined;
  } catch {
    return undefined;
  }
}

export async function currentAccount(): Promise<AccountView | undefined> {
  if (!savedKey()) return undefined;
  const reply = await call<Reply & { account?: AccountView }>('/api/account');
  if (reply.status === 401) saveKey(undefined);
  return reply.account;
}

/**
 * Stripe's checkout and portal refuse to load inside a frame, and the website shows this
 * scanner in an iframe, so they open in the whole tab. If the browser won't let the frame
 * move the tab, they open in a new one, and as a last resort in the frame itself.
 */
export function openStripe(url: string, win: Window = window): void {
  if (win.top && win.top !== win) {
    try {
      win.top.location.href = url;
      return;
    } catch {
      const tab = win.open(url, '_blank');
      if (tab) {
        tab.opener = null;
        return;
      }
    }
  }
  win.location.assign(url);
}

/** Sends the browser to Stripe's checkout, or returns why it can't. */
export async function startCheckout(scanners: ScannerId[], tier: TokenTier, email: string): Promise<string | undefined> {
  const reply = await call<Reply & { url?: string }>('/api/billing/checkout', { scanners, tier, email });
  if (reply.url) {
    openStripe(reply.url);
    return undefined;
  }
  return reply.text ?? 'Checkout is not answering. Try again in a minute.';
}

type SignedIn = Reply & { key?: string; account?: AccountView };

async function keep(reply: SignedIn): Promise<AccountView | string> {
  if (reply.key && reply.account) {
    saveKey(reply.key);
    return reply.account;
  }
  return reply.text ?? 'Signing in didn’t work. Try again.';
}

export async function claimCheckout(sessionId: string): Promise<AccountView | string> {
  return keep(await call<SignedIn>('/api/billing/claim', { sessionId }));
}

export async function redeemSignIn(token: string): Promise<AccountView | string> {
  return keep(await call<SignedIn>('/api/account/redeem', { token }));
}

export async function askForSignIn(email: string): Promise<string> {
  return (await call<Reply>('/api/account/signin', { email })).text ?? 'Try again in a minute.';
}

export async function openPortal(): Promise<string | undefined> {
  const reply = await call<Reply & { url?: string }>('/api/account/portal', {});
  if (reply.url) {
    openStripe(reply.url);
    return undefined;
  }
  return reply.text;
}

export async function signOut(): Promise<void> {
  await call('/api/account/signout', {}).catch(() => undefined);
  saveKey(undefined);
}
