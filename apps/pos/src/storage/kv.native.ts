import { localDb } from './db.native';
import type { KV } from './kv';

export type { KV } from './kv';

export const kv: KV = {
  async get<T>(key: string) {
    const row = await localDb().getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
    return row ? (JSON.parse(row.value) as T) : null;
  },
  async set(key, value) {
    await localDb().runAsync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, JSON.stringify(value));
  },
  async del(key) {
    await localDb().runAsync('DELETE FROM kv WHERE key = ?', key);
  },
};
