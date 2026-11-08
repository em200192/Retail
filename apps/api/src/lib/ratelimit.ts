import { HttpError } from './errors.ts';

/**
 * Counts failed attempts (wrong password, wrong PIN) per key and locks the key
 * for a while once there are too many. In memory: one API process. With several
 * API instances, move this to Postgres or Redis.
 */
let enabled = true;
/** Tests that create many shops from one address switch the shared limiters off. */
export function setAuthRateLimits(on: boolean) { enabled = on; }

export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; first: number; lockedUntil: number }>();
  constructor(private readonly maxFailures: number, private readonly windowMs: number, private readonly lockMs: number,
    private readonly now: () => number = Date.now) {}

  /** Throws 429 while the key is locked. */
  check(key: string): void {
    if (!enabled) return;
    const h = this.hits.get(key);
    if (!h) return;
    const t = this.now();
    if (h.lockedUntil > t) {
      const minutes = Math.max(1, Math.ceil((h.lockedUntil - t) / 60_000));
      throw new HttpError(429, 'too_many_attempts',
        `Too many wrong attempts. Wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`, { retry_after_seconds: Math.ceil((h.lockedUntil - t) / 1000) });
    }
    if (t - h.first > this.windowMs) this.hits.delete(key);
  }

  fail(key: string): void {
    if (!enabled) return;
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t - h.first > this.windowMs) { h = { count: 0, first: t, lockedUntil: 0 }; this.hits.set(key, h); }
    h.count++;
    if (h.count >= this.maxFailures) { h.lockedUntil = t + this.lockMs; h.count = 0; h.first = t; }
    if (this.hits.size > 50_000) this.sweep(t);
  }

  succeed(key: string): void { this.hits.delete(key); }

  private sweep(t: number) {
    for (const [k, h] of this.hits) if (h.lockedUntil < t && t - h.first > this.windowMs) this.hits.delete(k);
  }
}

const MIN = 60_000;
/** Shared limiters for the public auth endpoints and manager approvals. */
export const limiters = {
  /** Back-office password: per email and per IP address. */
  loginEmail: new FailureLimiter(8, 15 * MIN, 15 * MIN),
  loginIp: new FailureLimiter(40, 15 * MIN, 15 * MIN),
  /** Till PIN: per staff member on a device, and per device. */
  pin: new FailureLimiter(5, 15 * MIN, 5 * MIN),
  pinDevice: new FailureLimiter(20, 15 * MIN, 15 * MIN),
  /** New shops per IP address (counts every attempt). */
  signupIp: new FailureLimiter(30, 60 * MIN, 60 * MIN),
};
