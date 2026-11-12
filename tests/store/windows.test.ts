import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { bumpWindow, sumWindow } from '../../src/store/windows.js';

const B = 900_000;
describe('window counters', () => {
  it('sums buckets from the one of `from` to the one of `to`, per site/type/key', () => {
    const db = openDb(':memory:');
    const t = 100 * B;
    bumpWindow(db, 1, 'network-error', 'total', t - 3 * B);
    bumpWindow(db, 1, 'network-error', 'total', t - B, 5);
    bumpWindow(db, 1, 'network-error', 'total', t + 10, 2);
    bumpWindow(db, 1, 'network-error', 'total', t + 20);
    bumpWindow(db, 1, 'network-error', 'errors', t, 7);
    bumpWindow(db, 2, 'network-error', 'total', t, 99);
    expect(sumWindow(db, 1, 'network-error', 'total', t - B, t)).toBe(8);
    expect(sumWindow(db, 1, 'network-error', 'total', t - B + 5, t + 5)).toBe(8); // bucket granularity
    expect(sumWindow(db, 1, 'network-error', 'total', t - 4 * B, t)).toBe(9);
    expect(sumWindow(db, 1, 'network-error', 'errors', t - B, t)).toBe(7);
    expect(sumWindow(db, 1, 'crash', 'total', t - B, t)).toBe(0);
  });
});
