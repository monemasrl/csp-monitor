// Display helpers for the dashboard. Every time value comes from the caller (ms epoch).

const TZ = 'Europe/Rome';
const dateTime = new Intl.DateTimeFormat('it-IT', {
  timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const numbers = new Intl.NumberFormat('it-IT');

export const fmtNum = (n: number): string => numbers.format(n);
export const fmtDateTime = (ms: number): string => dateTime.format(ms);
export const fmtDate = (ms: number): string => dateOnly.format(ms);

/** 'YYYY-MM-DD' (UTC day, as stored in daily_counts) to '13 ott'. */
export function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return dayMonth.format(Date.UTC(y!, m! - 1, d!));
}

export function fmtAgo(ms: number | null, now: number): string {
  if (ms === null) return 'mai';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'adesso';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 ora fa' : `${h} ore fa`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'ieri' : `${d} giorni fa`;
}

export function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}
