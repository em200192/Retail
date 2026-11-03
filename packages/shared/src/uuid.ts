/**
 * UUIDv7 (RFC 9562): 48-bit unix-ms timestamp + random. Time-ordered, so
 * device-generated ids index well. Devices generate ids for sales, lines,
 * payments, refunds, time entries and age checks — retries reuse the id.
 * Uses Web Crypto (Node 19+, browsers, React Native with a getRandomValues polyfill).
 */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
