import { randomBytes } from 'node:crypto';
import type { Db } from '../db/db.js';

export type Site = {
  id: number;
  name: string;
  key: string;
  domains: string[];
  createdAt: number;
  learningUntil: number;
  learningSummarySent: boolean;
  ratePerMin: number;
  ratePerDay: number;
  lastReportAt: number | null;
};

type Row = {
  id: number; name: string; key: string; domains: string; created_at: number; learning_until: number;
  learning_summary_sent: number; rate_per_min: number; rate_per_day: number; last_report_at: number | null;
};

const LEARNING_MS = 7 * 24 * 3600 * 1000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const KEY_LENGTH = 16;

function toSite(r: Row): Site {
  return {
    id: r.id, name: r.name, key: r.key, domains: JSON.parse(r.domains) as string[],
    createdAt: r.created_at, learningUntil: r.learning_until,
    learningSummarySent: r.learning_summary_sent !== 0,
    ratePerMin: r.rate_per_min, ratePerDay: r.rate_per_day, lastReportAt: r.last_report_at,
  };
}

/** Random key from [A-Za-z0-9] using rejection sampling (bytes >= 248 are discarded: 248 = 4 * 62, no modulo bias). */
export function generateKey(): string {
  let out = '';
  while (out.length < KEY_LENGTH) {
    for (const b of randomBytes(KEY_LENGTH * 2)) {
      if (b >= 248) continue;
      out += ALPHABET[b % 62];
      if (out.length === KEY_LENGTH) break;
    }
  }
  return out;
}

export function createSite(db: Db, input: { name: string; domains: string[] }, now: number): Site {
  const stmt = db.prepare('INSERT INTO sites (name, key, domains, created_at, learning_until) VALUES (?, ?, ?, ?, ?)');
  for (;;) {
    const key = generateKey();
    try {
      const info = stmt.run(input.name, key, JSON.stringify(input.domains), now, now + LEARNING_MS);
      return getSite(db, Number(info.lastInsertRowid))!;
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') continue;
      throw e;
    }
  }
}

export function getSiteByKey(db: Db, key: string): Site | null {
  const r = db.prepare('SELECT * FROM sites WHERE key = ?').get(key) as Row | undefined;
  return r ? toSite(r) : null;
}

export function getSite(db: Db, id: number): Site | null {
  const r = db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as Row | undefined;
  return r ? toSite(r) : null;
}

export function listSites(db: Db): Site[] {
  return (db.prepare('SELECT * FROM sites ORDER BY id').all() as Row[]).map(toSite);
}

export function updateSite(
  db: Db, id: number,
  patch: Partial<Pick<Site, 'name' | 'domains' | 'ratePerMin' | 'ratePerDay'>>,
): void {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
  if (patch.domains !== undefined) { sets.push('domains = ?'); vals.push(JSON.stringify(patch.domains)); }
  if (patch.ratePerMin !== undefined) { sets.push('rate_per_min = ?'); vals.push(patch.ratePerMin); }
  if (patch.ratePerDay !== undefined) { sets.push('rate_per_day = ?'); vals.push(patch.ratePerDay); }
  if (sets.length === 0) return;
  db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

export function endLearning(db: Db, id: number, now: number): void {
  db.prepare('UPDATE sites SET learning_until = ? WHERE id = ?').run(now, id);
}

export function touchSite(db: Db, id: number, now: number): void {
  db.prepare('UPDATE sites SET last_report_at = ? WHERE id = ?').run(now, id);
}
