// Fixed-window limiter kept in memory. Fine for one server instance; with
// several, move it to Redis or the database.
export class RateLimiter {
  private windows = new Map<string, { start: number; used: number }>();

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  /** Try to spend `cost` units for `key`. Returns false when over the limit. */
  take(key: string, cost = 1, now = Date.now()): boolean {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, used: 0 };
      this.windows.set(key, w);
    }
    if (w.used + cost > this.limit) return false;
    w.used += cost;
    if (this.windows.size > 50_000) this.sweep(now);
    return true;
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}
