import { afterEach, describe, expect, it, vi } from 'vitest';
import { Accounts, MAX_KEYS, memoryAccounts, planOf } from './accounts';
import { parseSelection, quote } from './catalog';
import { formEncode, signWebhook, verifyWebhook } from './stripe';
import { configureBilling, handleAccount, handleCheckout, handleClaim, handleRedeem, handleSignIn, handleWebhook } from '../server/billing';
import { configure, handleScan } from '../server/api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('quote', () => {
  it('charges £9.99 for one scanner and grows the discount with each extra one', () => {
    expect(quote({ scanners: ['token'] }).total).toBe(9.99);
    expect(quote({ scanners: ['token', 'wallet'] }).total).toBe(18.98);
    expect(quote({ scanners: ['token', 'wallet', 'defi'] }).total).toBe(26.97);
    expect(quote({ scanners: ['token', 'wallet', 'defi', 'chain'] }).total).toBe(33.96);
    expect(quote({ scanners: ['token', 'wallet', 'defi', 'chain'] }).lines.map((line) => [line.price, line.discountPercent])).toEqual([
      [9.99, 0],
      [8.99, 10],
      [7.99, 20],
      [6.99, 30],
    ]);
  });

  it('charges the dearest scanner in full, so Ultra is never the discounted one', () => {
    const ultra = quote({ scanners: ['wallet', 'token'], tier: 'ultra' });
    expect(ultra.lines[0]).toMatchObject({ scanner: 'token', price: 24.99, discountPercent: 0 });
    expect(ultra.lines[1]).toMatchObject({ scanner: 'wallet', price: 8.99, discountPercent: 10 });
    expect(ultra.total).toBe(33.98);
    expect(ultra.fullTotal).toBe(34.98);
  });

  it('only sells scanners that have launched', () => {
    expect(parseSelection({ scanners: ['token'], tier: 'ultra' })).toEqual({ scanners: ['token'], tier: 'ultra' });
    expect(parseSelection({ scanners: ['token', 'wallet'] })).toBeUndefined();
    expect(parseSelection({ scanners: [] })).toBeUndefined();
    expect(parseSelection({})).toBeUndefined();
  });
});

describe('Stripe helpers', () => {
  it('form-encodes nested values the way Stripe reads them', () => {
    expect(formEncode({ a: 1, line_items: [{ price_data: { currency: 'gbp' } }] }).toString()).toBe('a=1&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=gbp');
  });

  it('accepts a signed webhook and refuses a tampered or stale one', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'x', data: { object: {} } });
    const now = Date.now();
    const header = await signWebhook(body, 'whsec_test', now);
    await expect(verifyWebhook(body, header, 'whsec_test', now)).resolves.toMatchObject({ id: 'evt_1' });
    await expect(verifyWebhook(`${body} `, header, 'whsec_test', now)).rejects.toThrow('Bad signature');
    await expect(verifyWebhook(body, header, 'whsec_other', now)).rejects.toThrow('Bad signature');
    await expect(verifyWebhook(body, header, 'whsec_test', now + 10 * 60_000)).rejects.toThrow('too old');
    await expect(verifyWebhook(body, undefined, 'whsec_test', now)).rejects.toThrow('Missing');
  });
});

describe('Accounts', () => {
  const paid = { email: 'Sam@Example.com', customer: 'cus_1', subscription: 'sub_1', status: 'active', scanners: ['token' as const], tier: 'ultra' as const };

  it('makes an account from a checkout and gives one key per checkout', async () => {
    const accounts = new Accounts(memoryAccounts());
    const account = (await accounts.applyPackage(paid))!;
    expect(account.email).toBe('sam@example.com');
    await accounts.linkCheckout('cs_1', account);
    const claimed = await accounts.claimKey('cs_1');
    expect(claimed).not.toBe('claimed');
    const key = (claimed as { key: string }).key;
    expect(key).toMatch(/^bf_/);
    expect(planOf(await accounts.byKey(key))).toBe('ultra');
    expect(await accounts.claimKey('cs_1')).toBe('claimed');
    expect(await accounts.byKey('bf_wrong')).toBeUndefined();
  });

  it('drops to Free when the subscription ends, and keeps what was bought when an event leaves it out', async () => {
    const accounts = new Accounts(memoryAccounts());
    await accounts.applyPackage(paid);
    await accounts.applyPackage({ customer: 'cus_1', status: 'past_due', scanners: [], tier: 'pro' });
    expect(planOf(await accounts.byCustomer('cus_1'))).toBe('ultra');
    await accounts.applyPackage({ customer: 'cus_1', status: 'canceled', scanners: [], tier: 'pro' });
    expect(planOf(await accounts.byCustomer('cus_1'))).toBe('free');
  });

  it('signs in by a one-time link that expires', async () => {
    let now = 0;
    const accounts = new Accounts(memoryAccounts(), () => now);
    await accounts.applyPackage(paid);
    expect(await accounts.startSignIn('nobody@example.com')).toBeUndefined();
    const token = (await accounts.startSignIn('sam@example.com'))!;
    const signedIn = await accounts.redeemSignIn(token);
    expect(planOf(await accounts.byKey(signedIn!.key))).toBe('ultra');
    expect(await accounts.redeemSignIn(token)).toBeUndefined();
    const late = (await accounts.startSignIn('sam@example.com'))!;
    now = 31 * 60_000;
    expect(await accounts.redeemSignIn(late)).toBeUndefined();
  });

  it('keeps at most MAX_KEYS keys and revokes on sign-out', async () => {
    const accounts = new Accounts(memoryAccounts());
    const account = (await accounts.applyPackage(paid))!;
    const first = await accounts.issueKey(account);
    for (let i = 0; i < MAX_KEYS; i += 1) await accounts.issueKey((await accounts.byId(account.id))!);
    expect(await accounts.byKey(first)).toBeUndefined();
    const last = await accounts.issueKey((await accounts.byId(account.id))!);
    await accounts.revokeKey(last);
    expect(await accounts.byKey(last)).toBeUndefined();
  });
});

describe('billing endpoints', () => {
  const secret = 'whsec_test';

  function setUp() {
    const sent: string[] = [];
    configureBilling({
      accounts: memoryAccounts(),
      stripe: { secretKey: 'sk_test_x', webhookSecret: secret },
      mailer: { kind: 'test', sendSignIn: async (_to, link) => void sent.push(link) },
      publicUrl: 'https://scanner.example',
      enabled: true,
    });
    return sent;
  }

  async function completeCheckout(sessionId = 'cs_test_1') {
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, mode: 'subscription', payment_status: 'paid', customer: 'cus_9', subscription: 'sub_9', customer_details: { email: 'pat@example.com' }, metadata: { scanners: 'token', tier: 'pro' } } },
    });
    return handleWebhook(body, await signWebhook(body, secret));
  }

  it('sends each scanner to Stripe at its package price', async () => {
    setUp();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/1' })));
    vi.stubGlobal('fetch', fetchMock);
    const reply = await handleCheckout({ scanners: ['token'], tier: 'ultra', email: 'pat@example.com' }, undefined);
    expect(reply).toMatchObject({ status: 200, body: { url: 'https://checkout.stripe.com/c/1' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get('line_items[0][price_data][unit_amount]')).toBe('2499');
    expect(sent.get('line_items[0][price_data][currency]')).toBe('gbp');
    expect(sent.get('subscription_data[metadata][tier]')).toBe('ultra');
    expect(sent.get('customer_email')).toBe('pat@example.com');
    expect((await handleCheckout({ scanners: ['wallet'] }, undefined)).status).toBe(400);
  });

  it('turns a paid checkout into a key once, and the key runs scans on the paid plan', async () => {
    setUp();
    expect((await completeCheckout()).status).toBe(200);
    const claimed = await handleClaim({ sessionId: 'cs_test_1' });
    expect(claimed.status).toBe(200);
    const key = (claimed.body as { key: string }).key;
    expect(await handleAccount(key)).toMatchObject({ status: 200, body: { account: { email: 'pat@example.com', plan: 'pro', paying: true } } });
    expect((await handleClaim({ sessionId: 'cs_test_1' })).status).toBe(409);
    expect((await handleCheckout({ scanners: ['token'] }, key)).status).toBe(409);
  });

  it('does not give a plan for a checkout that is complete but not yet paid', async () => {
    setUp();
    const body = JSON.stringify({
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_2', mode: 'subscription', payment_status: 'unpaid', customer: 'cus_2', customer_details: { email: 'sam@example.com' }, metadata: { scanners: 'token', tier: 'pro' } } },
    });
    expect((await handleWebhook(body, await signWebhook(body, secret))).status).toBe(200);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'cs_test_2', status: 'complete', payment_status: 'unpaid' }))));
    expect((await handleClaim({ sessionId: 'cs_test_2' })).status).toBe(404);
  });

  it('asks Stripe to retry a subscription event for an account it doesn’t know', async () => {
    setUp();
    const body = JSON.stringify({
      id: 'evt_3',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_404', customer: 'cus_404', status: 'active', metadata: { scanners: 'token', tier: 'pro' } } },
    });
    expect((await handleWebhook(body, await signWebhook(body, secret))).status).toBe(500);
    await completeCheckout();
    const known = JSON.stringify({
      id: 'evt_4',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_9', customer: 'cus_9', status: 'active', metadata: { scanners: 'token', tier: 'pro' } } },
    });
    expect((await handleWebhook(known, await signWebhook(known, secret))).status).toBe(200);
  });

  it('refuses unsigned webhooks', async () => {
    setUp();
    expect((await handleWebhook('{}', 't=1,v1=00')).status).toBe(400);
  });

  it('answers sign-in the same for unknown emails and emails a link for known ones', async () => {
    const sent = setUp();
    await completeCheckout();
    const unknown = await handleSignIn({ email: 'who@example.com' });
    const known = await handleSignIn({ email: 'pat@example.com' });
    expect(unknown).toEqual(known);
    expect(sent).toHaveLength(1);
    const token = new URL(sent[0]).searchParams.get('signin')!;
    expect((await handleRedeem({ token })).status).toBe(200);
    expect((await handleRedeem({ token })).status).toBe(400);
  });

  it('in billing mode, scans without a key run as Free and Re-check is refused', async () => {
    setUp();
    configure({ insightx: '', twitter: '', coingecko: '', summarise: '', socials: '' }, { paidPlans: 'billing' });
    const reply = await handleScan({ address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', plan: 'ultra', refresh: true }, 'ip');
    expect(reply.status).toBe(403);
    configure({ insightx: '', twitter: '', coingecko: '', summarise: '', socials: '' }, { paidPlans: 'open' });
  });
});
