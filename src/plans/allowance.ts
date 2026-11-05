import type { LibraryStore } from './library';

/**
 * Each member's fresh Community + Foundation checks this calendar month (UTC), counted per
 * account (or, with no account, per client). Only scans that read X afresh use one: a saved
 * or shared result doesn't, and Security is never counted.
 *
 * A check takes one before it runs, so scans running at once can't overshoot, and gives it
 * back if X failed. The counts are kept in the library's store (Postgres or Redis), so a
 * restart doesn't hand out a second month.
 */
export interface AllowanceStatus {
  used: number;
  limit: number;
  left: number;
  /** When the month rolls over (ms, UTC). */
  resetsAt: number;
}

export class MonthlyAllowance {
  private month = '';
  private readonly used = new Map<string, number>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    private readonly store?: () => LibraryStore,
    private readonly now: () => number = Date.now,
  ) {}

  private roll(): void {
    const month = new Date(this.now()).toISOString().slice(0, 7);
    if (month === this.month) return;
    this.month = month;
    this.used.clear();
    this.loading.clear();
  }

  private key(client: string) {
    return `fresh-checks:${this.month}:${client}`;
  }

  private load(client: string): Promise<void> {
    this.roll();
    let loading = this.loading.get(client);
    if (!loading) {
      const month = this.month;
      loading = (async () => {
        try {
          const saved = Number(await this.store?.().get(this.key(client)));
          if (month !== this.month) return;
          if (Number.isFinite(saved) && saved > (this.used.get(client) ?? 0)) this.used.set(client, saved);
        } catch (error) {
          console.error('allowance read failed:', error instanceof Error ? error.message : error);
        }
      })();
      this.loading.set(client, loading);
    }
    return loading;
  }

  private save(client: string): void {
    this.store?.()
      .set(this.key(client), String(this.used.get(client) ?? 0))
      .catch((error: unknown) => console.error('allowance write failed:', error instanceof Error ? error.message : error));
  }

  /** Uses one fresh check if any are left this month. */
  async take(client: string, limit: number): Promise<boolean> {
    await this.load(client);
    const used = this.used.get(client) ?? 0;
    if (used >= limit) return false;
    this.used.set(client, used + 1);
    this.save(client);
    return true;
  }

  /** Hands back a check that didn't read X after all. */
  giveBack(client: string): void {
    const used = this.used.get(client) ?? 0;
    if (used === 0) return;
    this.used.set(client, used - 1);
    this.save(client);
  }

  async status(client: string, limit: number): Promise<AllowanceStatus> {
    await this.load(client);
    const used = Math.min(this.used.get(client) ?? 0, limit);
    const now = new Date(this.now());
    return { used, limit, left: limit - used, resetsAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) };
  }
}
