const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

/** In-memory only: client IPs must never reach disk or logs. */
export class LoginLimiter {
  private failures = new Map<string, number[]>();
  private blockedUntil = new Map<string, number>();

  fail(ip: string, now: number): void {
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
}
