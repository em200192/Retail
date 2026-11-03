import * as SQLite from 'expo-sqlite';

/** The till's on-device database (native only). */
let db: SQLite.SQLiteDatabase | null = null;

export function localDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync('counter.db');
    db.execSync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        item TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_status ON outbox (status, created_at);
    `);
  }
  return db;
}
