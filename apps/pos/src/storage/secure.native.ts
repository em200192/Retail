import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

// SecureStore keys may only contain [A-Za-z0-9._-].
const k = (key: string) => `counter.${key.replace(/[^A-Za-z0-9._-]/g, '_')}`;

export const secure = {
  get: (key: string) => SecureStore.getItemAsync(k(key)),
  set: (key: string, value: string) => SecureStore.setItemAsync(k(key), value),
  del: (key: string) => SecureStore.deleteItemAsync(k(key)),
};

export function sha256Hex(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
}
