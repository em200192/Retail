import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, KEYLEN = 32;

/** Password / PIN hash: 'scrypt$N$r$p$salt$hash' (base64url). */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(secret, Buffer.from(saltB64, 'base64url'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

/** Device secrets are 256-bit random, so a plain SHA-256 is sufficient. */
export function newDeviceSecret(): string {
  return randomBytes(32).toString('base64url');
}
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------- JWT (HS256)
export interface TokenClaims {
  kind: 'user' | 'pos';
  tid: string;           // tenant id
  sid: string;           // staff id
  uid?: string;          // user id (back-office logins)
  did?: string;          // device id (POS logins)
  bid?: string;          // branch id (POS logins)
  iat: number;
  exp: number;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signToken(claims: Omit<TokenClaims, 'iat' | 'exp'>, secret: string, ttlSeconds: number): string {
  const iat = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, iat, exp: iat + ttlSeconds })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyToken(token: string, secret: string): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header.alg !== 'HS256') return null;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as TokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (!claims.tid || !claims.sid || (claims.kind !== 'user' && claims.kind !== 'pos')) return null;
    return claims;
  } catch {
    return null;
  }
}
