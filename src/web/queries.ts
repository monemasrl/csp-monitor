// All dashboard SQL lives here. Views receive the plain objects these functions return.
import type { Db } from '../db/db.js';
import { BUILTIN_NOISE } from '../ingest/noise.js';
import { isRiskyWildcard, matchesPattern } from '../match.js';
import { listDiscarded, type Discarded } from '../store/discarded.js';
import { listSites, type Site } from '../store/sites.js';
import { utcDay } from '../time.js';
import { isApprovableSource, parsePattern } from './validate.js';

const DAY = 86_400_000;
const SILENT_AFTER = 3 * DAY;
const NEVER_SEEN_GRACE = DAY;
const MAX_ROWS = 500;

export type StatusKey = 'new' | 'approved' | 'global' | 'suspect' | 'dashboard';
export const STATUS_KEYS: StatusKey[] = ['new', 'approved', 'global', 'suspect', 'dashboard'];

export type OriginRow = {
  id: number; siteId: number; directive: string; origin: string; category: string; status: StatusKey;
  firstSeen: number; lastSeen: number; count: number; firstPage: string;
};
export type ReviewItem = OriginRow & { siteName: string };
export type SiteState =
  | { kind: 'review'; count: number } | { kind: 'over-cap'; dropped: number } | { kind: 'silent' }
  | { kind: 'learning'; days: number } | { kind: 'ok' };
export type SiteCard = { site: Site; state: SiteState; bars: number[]; reports30: number; droppedToday: number };
export type Series = { days: string[]; values: number[] };
export type ReasonCount = { reason: string; count: number };

type DbOrigin = {
  id: number; site_id: number; directive: string; origin: string; category: string; status: string;
  first_seen: number; last_seen: number; count: number; first_page: string | null;
};

const ALERTABLE = "o.category IN ('external', 'data', 'blob')";
/** 'new' rows, plus 'suspect' rows with an alert still waiting to be sent. */
const TO_REVIEW = `o.report_type = 'csp-violation' AND ${ALERTABLE} AND (o.status = 'new' OR (o.status = 'suspect' AND EXISTS (
  SELECT 1 FROM pending_alerts p WHERE p.origin_id = o.id AND p.sent_at IS NULL)))`;

function globalApprovals(db: Db): { pattern: string; directive: string }[] {
  return db.prepare('SELECT pattern, directive FROM approvals WHERE site_id IS NULL').all() as { pattern: string; directive: string }[];
}

/** Maps a DB row to its display status; `globals` = global approvals, to tell 'globale' from 'approvata'. */
function toRow(r: DbOrigin, globals: { pattern: string; directive: string }[]): OriginRow {
  let status: StatusKey;
  if (r.category === 'inline' || r.category === 'eval') status = 'dashboard';
  else if (r.status === 'approved') {
    status = globals.some(g => g.directive === r.directive && matchesPattern(g.pattern, r.origin)) ? 'global' : 'approved';
  } else status = r.status === 'suspect' ? 'suspect' : 'new';
  return {
    id: r.id, siteId: r.site_id, directive: r.directive, origin: r.origin, category: r.category, status,
    firstSeen: r.first_seen, lastSeen: r.last_seen, count: r.count, firstPage: r.first_page ?? '',
  };
}

export function lastDays(now: number, n = 30): string[] {
  return Array.from({ length: n }, (_, i) => utcDay(now - (n - 1 - i) * DAY));
}

/** Daily report counts for the last 30 UTC days, per site. */
function seriesBySite(db: Db, now: number): Map<number, number[]> {
  const days = lastDays(now);
  const rows = db
    .prepare('SELECT site_id, day, SUM(count) n FROM daily_counts WHERE day >= ? GROUP BY site_id, day')
    .all(days[0]) as { site_id: number; day: string; n: number }[];
  const out = new Map<number, number[]>();
  for (const r of rows) {
    const i = days.indexOf(r.day);
    if (i < 0) continue;
    if (!out.has(r.site_id)) out.set(r.site_id, days.map(() => 0));
    out.get(r.site_id)![i] = r.n;
  }
  return out;
}

export function siteSeries(db: Db, siteId: number, now: number): Series {
  const days = lastDays(now);
  return { days, values: seriesBySite(db, now).get(siteId) ?? days.map(() => 0) };
}

function reviewCount(db: Db, siteId?: number): number {
  const where = siteId === undefined ? '' : ' AND o.site_id = ?';
  const args = siteId === undefined ? [] : [siteId];
  return (db.prepare(`SELECT COUNT(*) n FROM origins o WHERE ${TO_REVIEW}${where}`).get(...args) as { n: number }).n;
}

function droppedToday(db: Db, siteId: number, now: number): number {
  const r = db.prepare("SELECT count FROM noise_counts WHERE site_id = ? AND reason = 'rate-limit' AND day = ?")
    .get(siteId, utcDay(now)) as { count: number } | undefined;
  return r?.count ?? 0;
}

export function isSilent(site: Site, now: number): boolean {
  return site.lastReportAt !== null
    ? now - site.lastReportAt > SILENT_AFTER
    : now - site.createdAt > NEVER_SEEN_GRACE;
}

function siteState(db: Db, site: Site, now: number): SiteState {
  const review = reviewCount(db, site.id);
  if (review > 0) return { kind: 'review', count: review };
  const dropped = droppedToday(db, site.id, now);
  if (dropped > 0) return { kind: 'over-cap', dropped };
  if (isSilent(site, now)) return { kind: 'silent' };
  if (now < site.learningUntil) return { kind: 'learning', days: Math.ceil((site.learningUntil - now) / DAY) };
  return { kind: 'ok' };
}

const URGENCY: SiteState['kind'][] = ['review', 'over-cap', 'silent', 'learning', 'ok'];

function reviewItems(db: Db, limit: number, siteId?: number): ReviewItem[] {
  const where = siteId === undefined ? '' : ' AND o.site_id = ?';
  const rows = db
    .prepare(`SELECT o.*, s.name site_name FROM origins o JOIN sites s ON s.id = o.site_id
      WHERE ${TO_REVIEW}${where} ORDER BY o.first_seen DESC, o.id DESC LIMIT ?`)
    .all(...(siteId === undefined ? [] : [siteId]), limit) as (DbOrigin & { site_name: string })[];
  return rows.map(r => ({ ...toRow(r, []), siteName: r.site_name }));
}

export type NavData = { sites: { id: number; name: string }[] };
export function navData(db: Db): NavData {
  return { sites: listSites(db).map(s => ({ id: s.id, name: s.name })) };
}

export type OverviewData = {
  siteCount: number; reviewCount: number; silentCount: number; reports24h: number;
  review: ReviewItem[]; cards: SiteCard[];
};

export function overview(db: Db, now: number): OverviewData {
  const sites = listSites(db);
  const series = seriesBySite(db, now);
  const cards = sites.map((site): SiteCard => {
    const bars = series.get(site.id) ?? lastDays(now).map(() => 0);
    return {
      site, state: siteState(db, site, now), bars, reports30: bars.reduce((a, b) => a + b, 0),
      droppedToday: droppedToday(db, site.id, now),
    };
  });
  cards.sort((a, b) => URGENCY.indexOf(a.state.kind) - URGENCY.indexOf(b.state.kind) || a.site.id - b.site.id);
  const reports24h = (db.prepare('SELECT COUNT(*) n FROM samples WHERE received_at >= ?').get(now - DAY) as { n: number }).n;
  return {
    siteCount: sites.length,
    reviewCount: reviewCount(db),
    silentCount: sites.filter(s => isSilent(s, now)).length,
    reports24h,
    review: reviewItems(db, 20),
    cards,
  };
}

function noiseByReason(db: Db, siteId: number, now: number, days: number): ReasonCount[] {
  return db
    .prepare('SELECT reason, SUM(count) count FROM noise_counts WHERE site_id = ? AND day >= ? GROUP BY reason ORDER BY count DESC, reason')
    .all(siteId, utcDay(now - (days - 1) * DAY)) as ReasonCount[];
}

export type DashSample = {
  receivedAt: number; page: string; sourceFile: string; sample: string; line: number | null; ua: string; disposition: string;
};
export type InlineRow = OriginRow & { samples: string[] };

export type SiteSummary = {
  site: Site; series: Series; reports30: number; reviewCount: number; approvedCount: number;
  review: ReviewItem[]; known: OriginRow[]; inline: InlineRow[]; noise7: ReasonCount[]; reports7: number;
  approvedSources: { directive: string; pattern: string }[];
  discarded: Discarded[];
};

/** Approvals to put in the suggested header: this site's, plus global ones matching an origin seen on it. */
function suggestedSources(db: Db, siteId: number): { directive: string; pattern: string }[] {
  const own = db.prepare('SELECT directive, pattern FROM approvals WHERE site_id = ?').all(siteId) as { directive: string; pattern: string }[];
  const seen = db.prepare("SELECT DISTINCT directive, origin FROM origins WHERE site_id = ? AND report_type = 'csp-violation'").all(siteId) as { directive: string; origin: string }[];
  const globals = globalApprovals(db).filter(g => seen.some(s => s.directive === g.directive && matchesPattern(g.pattern, s.origin)));
  // Only well-formed sources ever reach a header the user will paste into a server config.
  return [...own, ...globals].filter(a => isApprovableSource(a.pattern) || parsePattern(a.pattern) === a.pattern);
}

export function siteSummary(db: Db, site: Site, now: number): SiteSummary {
  const globals = globalApprovals(db);
  const series = siteSeries(db, site.id, now);
  const all = (db.prepare("SELECT * FROM origins o WHERE site_id = ? AND report_type = 'csp-violation' ORDER BY last_seen DESC, id DESC").all(site.id) as DbOrigin[])
    .map(r => toRow(r, globals));
  const known = all.filter(r => r.status === 'approved' || r.status === 'global' || r.status === 'suspect').slice(0, MAX_ROWS);
  const lastSamples = db.prepare(
    "SELECT script_sample FROM samples WHERE origin_id = ? AND script_sample <> '' ORDER BY received_at DESC, id DESC LIMIT 3",
  );
  const inline = all.filter(r => r.status === 'dashboard').map(r => ({
    ...r, samples: (lastSamples.all(r.id) as { script_sample: string }[]).map(s => s.script_sample),
  }));
  const last7 = lastDays(now, 7)[0]!;
  const reports7 = (db.prepare('SELECT COALESCE(SUM(count), 0) n FROM daily_counts WHERE site_id = ? AND day >= ?')
    .get(site.id, last7) as { n: number }).n;
  return {
    site, series, reports30: series.values.reduce((a, b) => a + b, 0),
    reviewCount: reviewCount(db, site.id),
    approvedCount: new Set(all.filter(r => r.status === 'approved' || r.status === 'global').map(r => r.origin)).size,
    review: reviewItems(db, MAX_ROWS, site.id), known, inline,
    noise7: noiseByReason(db, site.id, now, 7), reports7,
    approvedSources: suggestedSources(db, site.id),
    discarded: listDiscarded(db, site.id),
  };
}

export type CspFilters = { directive: string; status: StatusKey | ''; noise: boolean };
export type CspRow = OriginRow & { topPage: string };
export type CspData = {
  site: Site; filters: CspFilters; directives: string[]; rows: CspRow[]; truncated: boolean; series: Series;
  browsers: { name: string; pct: number }[]; noise30: ReasonCount[];
  totals: { reports30: number; external: number; approved: number; review: number };
};

export function cspViolations(db: Db, site: Site, now: number, raw: { directive?: string; status?: string; noise?: string }): CspData {
  const directives = (db.prepare("SELECT DISTINCT directive FROM origins WHERE site_id = ? AND report_type = 'csp-violation' ORDER BY directive").all(site.id) as { directive: string }[])
    .map(r => r.directive);
  const filters: CspFilters = {
    directive: raw.directive && directives.includes(raw.directive) ? raw.directive : '',
    status: STATUS_KEYS.includes(raw.status as StatusKey) ? (raw.status as StatusKey) : '',
    noise: raw.noise === '1',
  };
  const globals = globalApprovals(db);
  const rows = (db.prepare(`SELECT o.*, (SELECT s.page FROM samples s WHERE s.origin_id = o.id
      GROUP BY s.page ORDER BY COUNT(*) DESC, MAX(s.received_at) DESC LIMIT 1) top_page
      FROM origins o WHERE o.site_id = ? AND o.report_type = 'csp-violation' ORDER BY o.count DESC, o.id`).all(site.id) as (DbOrigin & { top_page: string | null })[])
    .map(r => ({ ...toRow(r, globals), topPage: r.top_page ?? r.first_page ?? '' }));
  const filtered = rows.filter(r => (!filters.directive || r.directive === filters.directive) && (!filters.status || r.status === filters.status));

  const uas = db.prepare('SELECT ua, COUNT(*) n FROM samples WHERE site_id = ? AND received_at >= ? GROUP BY ua')
    .all(site.id, now - 30 * DAY) as { ua: string | null; n: number }[];
  const families = new Map<string, number>();
  for (const u of uas) {
    const name = (u.ua ?? '').replace(/\s+\d+$/, '') || 'Altro';
    families.set(name, (families.get(name) ?? 0) + u.n);
  }
  const total = [...families.values()].reduce((a, b) => a + b, 0);
  const sorted = [...families.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 4);
  const rest = sorted.slice(4).reduce((a, [, n]) => a + n, 0);
  if (rest > 0) top.push(['Altri', rest]);
  const browsers = top.map(([name, n]) => ({ name, pct: total > 0 ? Math.round((n / total) * 100) : 0 }));

  const series = siteSeries(db, site.id, now);
  const external = rows.filter(r => r.category !== 'inline' && r.category !== 'eval' && r.category !== 'self');
  return {
    site, filters, directives, rows: filtered.slice(0, MAX_ROWS), truncated: filtered.length > MAX_ROWS, series, browsers,
    noise30: filters.noise ? noiseByReason(db, site.id, now, 30) : [],
    totals: {
      reports30: series.values.reduce((a, b) => a + b, 0),
      external: new Set(external.map(r => r.origin)).size,
      approved: new Set(external.filter(r => r.status === 'approved' || r.status === 'global').map(r => r.origin)).size,
      review: reviewCount(db, site.id),
    },
  };
}

export type OriginDetailData = {
  site: Site; row: OriginRow; approvable: boolean; siblings: OriginRow[];
  sites: { id: number; name: string; firstSeen: number; lastSeen: number }[];
  crossSite: { id: number; name: string }[]; startedFrom: string; samples: DashSample[]; raw: string | null;
};

/** Origin row by id, only if it belongs to the site. */
export function originOfSite(db: Db, siteId: number, originId: number): { origin: string; category: string } | null {
  const r = db.prepare('SELECT origin, category FROM origins WHERE id = ? AND site_id = ?').get(originId, siteId) as
    { origin: string; category: string } | undefined;
  return r ?? null;
}

export function originDetail(db: Db, site: Site, originId: number, now: number): OriginDetailData | null {
  const r = db.prepare('SELECT * FROM origins WHERE id = ? AND site_id = ?').get(originId, site.id) as DbOrigin | undefined;
  if (!r) return null;
  const globals = globalApprovals(db);
  const row = toRow(r, globals);
  const siblings = (db.prepare("SELECT * FROM origins WHERE site_id = ? AND report_type = 'csp-violation' AND origin = ? ORDER BY directive").all(site.id, r.origin) as DbOrigin[])
    .map(x => toRow(x, globals));
  const sites = (db.prepare(`SELECT s.id, s.name, MIN(o.first_seen) first_seen, MAX(o.last_seen) last_seen
      FROM origins o JOIN sites s ON s.id = o.site_id WHERE o.report_type = 'csp-violation' AND o.origin = ? GROUP BY s.id ORDER BY first_seen, s.id`)
    .all(r.origin) as { id: number; name: string; first_seen: number; last_seen: number }[])
    .map(s => ({ id: s.id, name: s.name, firstSeen: s.first_seen, lastSeen: s.last_seen }));
  // inline/eval/data:/blob: are the same string on every site: only real external origins warrant the warning.
  const crossSite = r.category === 'external'
    ? sites.filter(s => s.id !== site.id && s.lastSeen >= now - DAY).map(s => ({ id: s.id, name: s.name }))
    : [];
  const samples = (db.prepare(`SELECT received_at, page, source_file, script_sample, line, ua, disposition FROM samples
      WHERE origin_id = ? ORDER BY received_at DESC, id DESC LIMIT 20`).all(r.id) as {
    received_at: number; page: string | null; source_file: string | null; script_sample: string | null;
    line: number | null; ua: string | null; disposition: string | null;
  }[]).map(s => ({
    receivedAt: s.received_at, page: s.page ?? '', sourceFile: s.source_file ?? '', sample: s.script_sample ?? '',
    line: s.line, ua: s.ua ?? '', disposition: s.disposition ?? '',
  }));
  const first = db.prepare("SELECT source_file FROM samples WHERE origin_id = ? AND source_file <> '' ORDER BY received_at, id LIMIT 1")
    .get(r.id) as { source_file: string } | undefined;
  const last = db.prepare('SELECT body FROM samples WHERE origin_id = ? ORDER BY received_at DESC, id DESC LIMIT 1')
    .get(r.id) as { body: string } | undefined;
  return {
    site, row, approvable: r.category !== 'inline' && r.category !== 'eval' && isApprovableSource(r.origin),
    siblings, sites, crossSite, startedFrom: first?.source_file ?? r.first_page ?? '', samples, raw: last?.body ?? null,
  };
}

export type ApprovalItem = { id: number; siteId: number | null; siteName: string | null; pattern: string; directive: string; createdAt: number; risky: boolean };
export type ListsData = {
  approvals: ApprovalItem[]; noise: { id: number; pattern: string; createdAt: number }[]; builtinNoise: string[];
  sites: { id: number; name: string }[];
};

export function lists(db: Db): ListsData {
  const approvals = (db.prepare(`SELECT a.id, a.site_id, s.name site_name, a.pattern, a.directive, a.created_at
      FROM approvals a LEFT JOIN sites s ON s.id = a.site_id
      ORDER BY a.site_id IS NOT NULL, s.name, a.pattern, a.directive`).all() as {
    id: number; site_id: number | null; site_name: string | null; pattern: string; directive: string; created_at: number;
  }[]).map(a => ({
    id: a.id, siteId: a.site_id, siteName: a.site_name, pattern: a.pattern, directive: a.directive,
    createdAt: a.created_at, risky: isRiskyWildcard(a.pattern),
  }));
  const noise = (db.prepare('SELECT id, pattern, created_at FROM noise_patterns ORDER BY pattern').all() as
    { id: number; pattern: string; created_at: number }[]).map(n => ({ id: n.id, pattern: n.pattern, createdAt: n.created_at }));
  return { approvals, noise, builtinNoise: BUILTIN_NOISE, sites: navData(db).sites };
}

export function addNoisePattern(db: Db, pattern: string, now: number): void {
  db.prepare('INSERT OR IGNORE INTO noise_patterns (pattern, created_at) VALUES (?, ?)').run(pattern, now);
}

export function deleteNoisePattern(db: Db, id: number): void {
  db.prepare('DELETE FROM noise_patterns WHERE id = ?').run(id);
}
