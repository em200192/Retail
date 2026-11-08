import { afterAll, describe, expect, it } from 'vitest';
import { FailureLimiter, setAuthRateLimits } from '../src/lib/ratelimit.ts';
import { client, newShop, useTestApp } from './helpers.ts';

describe('wrong-attempt lockouts', () => {
  const env = useTestApp();
  afterAll(() => setAuthRateLimits(false));

  it('locks a key after too many failures, then unlocks after the lock time', () => {
    setAuthRateLimits(true);
    let t = 0;
    const l = new FailureLimiter(3, 60_000, 120_000, () => t);
    l.fail('k'); l.fail('k'); l.check('k');
    l.fail('k');
    expect(() => l.check('k')).toThrow(/Wait 2 minutes/);
    t += 121_000;
    expect(() => l.check('k')).not.toThrow();
    l.fail('k'); l.succeed('k'); l.fail('k'); l.fail('k');
    expect(() => l.check('k')).not.toThrow();
  });

  it('locks a staff PIN on a till after 5 wrong tries, even with the right PIN', async () => {
    const shop = await newShop(env.app);
    setAuthRateLimits(true);
    const c = client(env.app);
    const attempt = (pin: string) => c.post('/v1/auth/pin-login', { device_id: shop.deviceId, device_secret: shop.deviceSecret, staff_id: shop.cashierId, pin });
    for (let i = 0; i < 5; i++) expect((await attempt('0000')).status).toBe(401);
    const locked = await attempt('1111');
    expect(locked.status).toBe(429);
    expect(locked.body.message).toMatch(/Too many wrong attempts/);
    // Other staff on the same till are not locked.
    const other = await c.post('/v1/auth/pin-login', { device_id: shop.deviceId, device_secret: shop.deviceSecret, staff_id: shop.managerId, pin: '2222' });
    expect(other.status).toBe(200);
  });

  it('locks back-office sign-in for an email after 8 wrong passwords', async () => {
    const shop = await newShop(env.app);
    setAuthRateLimits(true);
    const c = client(env.app);
    for (let i = 0; i < 8; i++) expect((await c.post('/v1/auth/login', { email: shop.email, password: 'wrong password' })).status).toBe(401);
    expect((await c.post('/v1/auth/login', { email: shop.email, password: 'correct horse battery' })).status).toBe(429);
  });
});
