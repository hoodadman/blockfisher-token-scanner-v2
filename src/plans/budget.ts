import type { LibraryStore } from './library';

/**
 * A shared daily spending cap, in dollars, for Free's basic community checks. It covers
 * X calls for Community only: Security runs on every scan whatever this says.
 *
 * A check reserves the most it can cost before it runs, so scans running at once can't
 * overshoot, then settles what it actually cost. Days are UTC days, like X's billing. The
 * running total is kept in the library's store, so a restart doesn't hand out a second
 * day's budget.
 */
export class DailyBudget {
  private day = '';
  private spent = 0;
  private loading?: Promise<void>;

  constructor(
    readonly dollars: number,
    private readonly store?: () => LibraryStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async roll(): Promise<void> {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today === this.day) return this.loading;
    this.day = today;
    this.spent = 0;
    this.loading = (async () => {
      try {
        const saved = Number(await this.store?.().get(this.key()));
        if (Number.isFinite(saved) && saved > this.spent) this.spent = saved;
      } catch (error) {
        console.error('budget read failed:', error instanceof Error ? error.message : error);
      }
    })();
    return this.loading;
  }

  private key() {
    return `budget:free-community:${this.day}`;
  }

  private save(): void {
    this.store?.()
      .set(this.key(), String(this.spent))
      .catch((error: unknown) => console.error('budget write failed:', error instanceof Error ? error.message : error));
  }

  /** Holds `amount` if today's budget has room for it. */
  async reserve(amount: number): Promise<boolean> {
    await this.roll();
    if (this.spent + amount > this.dollars + 1e-9) return false;
    this.spent += amount;
    this.save();
    return true;
  }

  /** Gives back what a reserved check didn't cost. */
  settle(reserved: number, cost: number): void {
    this.spent = Math.max(0, this.spent - Math.max(0, reserved - cost));
    this.save();
  }

  async spentToday(): Promise<number> {
    await this.roll();
    return this.spent;
  }
}
