/**
 * Local key-value store for the cached catalogue, till state and counters.
 * Web build: localStorage (this file). Native: SQLite (kv.native.ts).
 * Both implement the same interface.
 */
export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const PREFIX = 'counter:';

export const kv: KV = {
  async get<T>(key: string) {
    try {
      const raw = globalThis.localStorage?.getItem(PREFIX + key);
      return raw == null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  },
  async set(key, value) {
    globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  },
  async del(key) {
    globalThis.localStorage?.removeItem(PREFIX + key);
  },
};
