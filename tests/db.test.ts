import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openDb } from '../src/db/db.js';

it('creates all tables and is idempotent', () => {
  const db = openDb(':memory:');
  db.exec(readFileSync('src/db/schema.sql', 'utf8'));
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
  expect(names).toEqual(expect.arrayContaining(['sites', 'origins', 'approvals', 'noise_patterns', 'daily_counts', 'noise_counts', 'samples', 'pending_alerts', 'settings']));
});

it('enables foreign keys', () => {
  const db = openDb(':memory:');
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
});
