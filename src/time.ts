/** UTC calendar day ('YYYY-MM-DD') of a ms-epoch timestamp. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
