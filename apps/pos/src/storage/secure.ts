/**
 * Secrets (device pairing, cached PIN verifiers). Web build: localStorage —
 * the browser till is a preview/dev target. Native: expo-secure-store
 * (Keychain / Keystore), see secure.native.ts.
 */
const PREFIX = 'counter:secure:';

export const secure = {
  async get(key: string): Promise<string | null> {
    try {
      return globalThis.localStorage?.getItem(PREFIX + key) ?? null;
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    globalThis.localStorage?.setItem(PREFIX + key, value);
  },
  async del(key: string): Promise<void> {
    globalThis.localStorage?.removeItem(PREFIX + key);
  },
};

/** SHA-256 hex digest (Web Crypto). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
