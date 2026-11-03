// React Native has no Web Crypto. @retail/shared's uuidv7() needs
// globalThis.crypto.getRandomValues, so back it with expo-crypto's CSPRNG.
import { getRandomValues } from 'expo-crypto';

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = getRandomValues;
}
