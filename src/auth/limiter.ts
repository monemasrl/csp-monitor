const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const MAX_ENTRIES = 10_000;
const SWEEP_EVERY_MS = 60_000;

/** In-memory only: client IPs must never reach disk or logs. */
export class LoginLimiter {
  private failures = new Map<string, number[]>();
  private blockedUntil = new Map<string, number>();
  private lastSweep = 0;

  get size(): number {
    return this.failures.size + this.blockedUntil.size;
  }

  fail(ip: string, now: number): void {
    if (now - this.lastSweep >= SWEEP_EVERY_MS || this.size >= MAX_ENTRIES) this.sweep(now);
    const list = (this.failures.get(ip) ?? []).filter((t) => t > now - WINDOW_MS);
    list.push(now);
    this.failures.set(ip, list);
    if (list.length >= MAX_FAILURES) {
      this.blockedUntil.set(ip, now + WINDOW_MS);
      this.failures.delete(ip);
    }
  }

  blocked(ip: string, now: number): boolean {
    const until = this.blockedUntil.get(ip);
    if (until === undefined) return false;
    if (now >= until) {
      this.blockedUntil.delete(ip);
      return false;
    }
    return true;
  }

  reset(ip: string): void {
    this.failures.delete(ip);
    this.blockedUntil.delete(ip);
  }

  /** Drops expired entries; if still over the cap, evicts the oldest failure-only entries (never blocked ones). */
  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [ip, until] of this.blockedUntil) if (now >= until) this.blockedUntil.delete(ip);
    for (const [ip, list] of this.failures) {
      if (list.length === 0 || list[list.length - 1]! <= now - WINDOW_MS) this.failures.delete(ip);
    }
    for (const ip of this.failures.keys()) {
      if (this.size < MAX_ENTRIES) break;
      this.failures.delete(ip); // Map iterates in insertion order: oldest first
    }
  }
}
