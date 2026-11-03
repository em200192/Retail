import type { QueueItem, QueueStore } from '../logic/queue';
import { localDb } from './db.native';

/** Native: the offline queue is an SQLite table (survives app kills and reboots). */
export function createQueueStore(): QueueStore {
  return {
    async all() {
      const rows = await localDb().getAllAsync<{ item: string }>('SELECT item FROM outbox ORDER BY created_at, id');
      return rows.map((r) => JSON.parse(r.item) as QueueItem);
    },
    async put(item) {
      await localDb().runAsync(
        `INSERT INTO outbox (id, kind, status, created_at, item) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, item = excluded.item`,
        item.id, item.kind, item.status, item.createdAt, JSON.stringify(item));
    },
    async remove(id) {
      await localDb().runAsync('DELETE FROM outbox WHERE id = ?', id);
    },
  };
}
