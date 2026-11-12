import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

export type Db = Database.Database;

const schema = readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8');

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  return db;
}
