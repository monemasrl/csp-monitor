import type { Db } from '../db/db.js';

export const UNSEEN_PER_DAY_OVER_LIMIT = 500;

/** In-memory fixed-window limiter: per-minute (floor(now/60000)) and per-UTC-day (floor(now/86400000)) counters per site. */
export class RateLimiter {
  private readonly state = new Map<number, { minute: number; minuteCount: number; day: number; dayCount: number }>();

  /** Counts the report against both windows; false when either window is already full. */
  allow(siteId: number, perMin: number, perDay: number, now: number): boolean {
    const minute = Math.floor(now / 60_000);
    const day = Math.floor(now / 86_400_000);
    let s = this.state.get(siteId);
    if (!s) {
      s = { minute, minuteCount: 0, day, dayCount: 0 };
      this.state.set(siteId, s);
    }
    if (s.minute !== minute) { s.minute = minute; s.minuteCount = 0; }
    if (s.day !== day) { s.day = day; s.dayCount = 0; }
    if (s.minuteCount >= perMin || s.dayCount >= perDay) return false;
    s.minuteCount++;
    s.dayCount++;
    return true;
  }

  private readonly unseen = new Map<number, { day: number; count: number }>();

  /** Over-limit path only: caps never-seen (directive, origin) pairs recorded per site per UTC day. */
  allowUnseen(siteId: number, now: number): boolean {
    const day = Math.floor(now / 86_400_000);
    let u = this.unseen.get(siteId);
    if (!u || u.day !== day) {
      u = { day, count: 0 };
      this.unseen.set(siteId, u);
    }
    if (u.count >= UNSEEN_PER_DAY_OVER_LIMIT) return false;
    u.count++;
    return true;
  }
}

/** Set of (site, directive, origin) already present in `origins`; lets the flood path tell new origins from known ones. */
export class KnownCache {
  private readonly set = new Set<string>();

  private static k(siteId: number, directive: string, origin: string): string {
    return JSON.stringify([siteId, directive, origin]);
  }

  load(db: Db): void {
    this.set.clear();
    const rows = db
      .prepare("SELECT site_id, directive, origin FROM origins WHERE report_type = 'csp-violation'")
      .all() as { site_id: number; directive: string; origin: string }[];
    for (const r of rows) this.add(r.site_id, r.directive, r.origin);
  }

  has(siteId: number, directive: string, origin: string): boolean {
    return this.set.has(KnownCache.k(siteId, directive, origin));
  }

  add(siteId: number, directive: string, origin: string): void {
    this.set.add(KnownCache.k(siteId, directive, origin));
  }

  /** Drops every entry of a site (after its data is cleared or the site is removed). */
  forgetSite(siteId: number): void {
    const prefix = `[${siteId},`;
    for (const k of this.set) if (k.startsWith(prefix)) this.set.delete(k);
  }
}
