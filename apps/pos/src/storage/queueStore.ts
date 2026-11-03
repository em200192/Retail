import type { QueueItem, QueueStore } from '../logic/queue';

/**
 * Web build: the offline queue lives in localStorage (one key per record, so a
 * write never rewrites the whole queue). Native: SQLite (queueStore.native.ts).
 */
const PREFIX = 'counter:outbox:';

export function createQueueStore(): QueueStore {
  const ls = () => globalThis.localStorage;
  return {
    async all() {
      const out: QueueItem[] = [];
      const store = ls();
      if (!store) return out;
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k?.startsWith(PREFIX)) continue;
        try {
          out.push(JSON.parse(store.getItem(k)!) as QueueItem);
        } catch { /* skip a corrupt entry */ }
      }
      return out;
    },
    async put(item) {
      ls()?.setItem(PREFIX + item.id, JSON.stringify(item));
    },
    async remove(id) {
      ls()?.removeItem(PREFIX + id);
    },
  };
}
