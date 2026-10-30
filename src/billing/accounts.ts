import type { PlanId } from '../plans/plans';
import { SCANNER_IDS, type ScannerId, type TokenTier } from './catalog';
import { randomHex, randomToken, sha256Hex } from './crypto';

/**
 * Accounts: who has paid for what. An account is made by its first checkout (there is no
 * sign-up without paying; Free needs no account). It is reached with an access key, a
 * random string the browser or extension keeps and sends with each scan. Only a hash of
 * each key is stored, so the store alone can't be used to sign in.
 *
 * A key is handed out once after checkout (claimKey), or by an emailed sign-in link
 * (startSignIn, then redeemSignIn) on another browser. server.mjs passes in a store kept in
 * Postgres (DATABASE_URL) or Redis (REDIS_URL); without either it lives in memory and
 * every account is lost on restart, which /api/health warns about.
 */
export interface AccountStore {
  kind: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Stripe's subscription statuses that still give the paid plan. past_due: Stripe is retrying the card. */
const PAYING = new Set(['active', 'trialing', 'past_due']);

export interface Account {
  id: string;
  email: string;
  /** Stripe customer and subscription ids. */
  customer?: string;
  subscription?: string;
  /** The subscription's Stripe status. */
  status: string;
  scanners: ScannerId[];
  tier: TokenTier;
  /** Hashes of the access keys in use, newest last. */
  keys: string[];
  createdAt: number;
  updatedAt: number;
}

/** What a browser is shown about its own account. */
export interface AccountView {
  email: string;
  status: string;
  paying: boolean;
  scanners: ScannerId[];
  plan: PlanId;
}

export const MAX_KEYS = 10;
export const SIGN_IN_MINUTES = 30;

const hash = sha256Hex;
const secret = (prefix: string) => `${prefix}_${randomToken(24)}`;
const normalEmail = (email: string) => email.trim().toLowerCase();

export function memoryAccounts(): AccountStore {
  const entries = new Map<string, string>();
  return {
    kind: 'memory',
    async get(key) {
      return entries.get(key);
    },
    async set(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

/** The token scanner plan an account's scans run on. */
export function planOf(account: Account | undefined): PlanId {
  if (!account || !PAYING.has(account.status) || !account.scanners.includes('token')) return 'free';
  return account.tier;
}

export function viewOf(account: Account): AccountView {
  return { email: account.email, status: account.status, paying: PAYING.has(account.status), scanners: account.scanners, plan: planOf(account) };
}

export interface PaidPackage {
  email?: string;
  customer?: string;
  subscription?: string;
  status: string;
  scanners: ScannerId[];
  tier: TokenTier;
}

export class Accounts {
  constructor(
    private readonly store: AccountStore,
    private readonly now: () => number = Date.now,
  ) {}

  get kind(): string {
    return this.store.kind;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const raw = await this.store.get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private async save(account: Account): Promise<Account> {
    account.updatedAt = this.now();
    await this.store.set(`account:${account.id}`, JSON.stringify(account));
    await this.store.set(`email:${account.email}`, account.id);
    if (account.customer) await this.store.set(`customer:${account.customer}`, account.id);
    return account;
  }

  async byId(id: string | undefined): Promise<Account | undefined> {
    return id ? this.read<Account>(`account:${id}`) : undefined;
  }

  async byEmail(email: string): Promise<Account | undefined> {
    return this.byId(await this.store.get(`email:${normalEmail(email)}`));
  }

  async byCustomer(customer: string): Promise<Account | undefined> {
    return this.byId(await this.store.get(`customer:${customer}`));
  }

  /** The account an access key belongs to, if the key is still in use. */
  async byKey(key: string | undefined): Promise<Account | undefined> {
    if (!key) return undefined;
    const digest = await hash(key);
    const account = await this.byId(await this.store.get(`key:${digest}`));
    return account?.keys.includes(digest) ? account : undefined;
  }

  /**
   * Records a paid checkout or a subscription change. Finds the account by Stripe customer,
   * then by email, else makes one. Fields the event doesn't carry are kept.
   */
  async applyPackage(paid: PaidPackage): Promise<Account | undefined> {
    let account = (paid.customer ? await this.byCustomer(paid.customer) : undefined) ?? (paid.email ? await this.byEmail(paid.email) : undefined);
    if (!account) {
      if (!paid.email) return undefined;
      account = {
        id: randomHex(12),
        email: normalEmail(paid.email),
        status: paid.status,
        scanners: [],
        tier: 'pro',
        keys: [],
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    }
    account.status = paid.status;
    if (paid.customer) account.customer = paid.customer;
    if (paid.subscription) account.subscription = paid.subscription;
    const scanners = SCANNER_IDS.filter((id) => paid.scanners.includes(id));
    if (scanners.length > 0) {
      account.scanners = scanners;
      account.tier = paid.tier;
    }
    return this.save(account);
  }

  /** Remembers which account a checkout made, so its success page can claim a key once. */
  async linkCheckout(sessionId: string, account: Account): Promise<void> {
    if (!(await this.store.get(`checkout:${sessionId}`))) await this.store.set(`checkout:${sessionId}`, JSON.stringify({ id: account.id, claimed: false }));
  }

  /** The first access key for a finished checkout. Only once per checkout. */
  async claimKey(sessionId: string): Promise<{ key: string; account: Account } | 'claimed' | undefined> {
    const link = await this.read<{ id: string; claimed: boolean }>(`checkout:${sessionId}`);
    if (!link) return undefined;
    if (link.claimed) return 'claimed';
    const account = await this.byId(link.id);
    if (!account) return undefined;
    await this.store.set(`checkout:${sessionId}`, JSON.stringify({ ...link, claimed: true }));
    return { key: await this.issueKey(account), account };
  }

  /** A new access key for this account. The oldest stops working past MAX_KEYS. */
  async issueKey(account: Account): Promise<string> {
    const key = secret('bf');
    const digest = await hash(key);
    account.keys = [...account.keys, digest];
    while (account.keys.length > MAX_KEYS) {
      const dropped = account.keys.shift()!;
      await this.store.delete(`key:${dropped}`);
    }
    await this.store.set(`key:${digest}`, account.id);
    await this.save(account);
    return key;
  }

  /** Signs one browser out: its key stops working. */
  async revokeKey(key: string): Promise<void> {
    const account = await this.byKey(key);
    const digest = await hash(key);
    await this.store.delete(`key:${digest}`);
    if (account) {
      account.keys = account.keys.filter((item) => item !== digest);
      await this.save(account);
    }
  }

  /** A one-time sign-in token for the account with this email, or undefined when there is none. */
  async startSignIn(email: string): Promise<string | undefined> {
    const account = await this.byEmail(email);
    if (!account) return undefined;
    const token = secret('signin');
    await this.store.set(`signin:${await hash(token)}`, JSON.stringify({ id: account.id, expires: this.now() + SIGN_IN_MINUTES * 60_000 }));
    return token;
  }

  /** Swaps a sign-in token for an access key. Each token works once, within SIGN_IN_MINUTES. */
  async redeemSignIn(token: string): Promise<{ key: string; account: Account } | undefined> {
    const slot = `signin:${await hash(token)}`;
    const pending = await this.read<{ id: string; expires: number }>(slot);
    if (!pending) return undefined;
    await this.store.delete(slot);
    if (pending.expires < this.now()) return undefined;
    const account = await this.byId(pending.id);
    if (!account) return undefined;
    return { key: await this.issueKey(account), account };
  }
}
