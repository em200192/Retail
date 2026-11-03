import { describe, expect, it } from 'vitest';
import { client, mkProduct, newShop, useTestApp } from './helpers.ts';

const env = useTestApp();

describe('signup, login and tenant isolation', () => {
  it('signs up a shop with default roles, price levels and an owner', async () => {
    const shop = await newShop(env.app);
    const me = await shop.owner.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.staff.role_key).toBe('owner');
    expect(me.body.permissions).toContain('roles.manage');
    expect(me.body.branches.map((b: any) => b.code)).toEqual([shop.branchCode]);
    const levels = await shop.owner.get('/v1/price-levels');
    expect(levels.body.map((l: any) => l.code)).toEqual(['retail', 'member', 'trade', 'staff']);
  });

  it('logs in with email + password and rejects a wrong password', async () => {
    const shop = await newShop(env.app);
    const ok = await client(env.app).post('/v1/auth/login', { email: shop.email, password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    expect(ok.body.tenant_id).toBe(shop.tenantId);
    const bad = await client(env.app).post('/v1/auth/login', { email: shop.email, password: 'wrong password!!' });
    expect(bad.status).toBe(401);
    const dup = await client(env.app).post('/v1/auth/signup', {
      email: shop.email, password: 'correct horse battery', full_name: 'X', business: { legal_name: 'X' }, branch: { code: 'XX', name: 'X' } });
    expect(dup.status).toBe(409);
  });

  it('rejects requests without a valid token', async () => {
    expect((await client(env.app).get('/v1/me')).status).toBe(401);
    expect((await client(env.app, 'nope.nope.nope').get('/v1/me')).status).toBe(401);
  });

  it('never shows one shop the other shop\'s data', async () => {
    const a = await newShop(env.app);
    const b = await newShop(env.app);
    const productId = await mkProduct(a.owner, { name: 'Shop A Milk', price: 165, barcode: '5000000000011' });
    expect((await a.owner.get(`/v1/products/${productId}`)).status).toBe(200);
    expect((await b.owner.get(`/v1/products/${productId}`)).status).toBe(404);
    const list = await b.owner.get('/v1/products?q=Milk');
    expect(list.body).toEqual([]);
    // B cannot reference A's records either (composite FKs + RLS)
    const price = await b.owner.post(`/v1/products/${productId}/prices`, { price_pence: 1 });
    expect(price.status).toBe(404);
    const stock = await b.owner.post('/v1/stock/adjustments', { branch_id: a.branchId, product_id: productId, quantity: 5 });
    expect(stock.status).toBe(404); // RLS hides A's branch entirely
  });
});

describe('devices and PIN login', () => {
  it('lets staff log in on a registered till with their PIN', async () => {
    const shop = await newShop(env.app);
    expect(shop.deviceNo).toBe(1);
    const sam = await shop.pinLogin(shop.cashierId, '1111');
    const me = await sam.get('/v1/me');
    expect(me.body.session).toMatchObject({ kind: 'pos', device_id: shop.deviceId, branch_id: shop.branchId });
    expect(me.body.permissions).toContain('pos.sell');
    expect(me.body.permissions).not.toContain('pos.refund');
    expect(me.body.limits['pos.discount.max_percent']).toBe(5);
  });

  it('rejects a wrong PIN or a wrong device secret', async () => {
    const shop = await newShop(env.app);
    const wrongPin = await client(env.app).post('/v1/auth/pin-login', { device_id: shop.deviceId, device_secret: shop.deviceSecret, staff_id: shop.cashierId, pin: '0000' });
    expect(wrongPin.status).toBe(401);
    const wrongSecret = await client(env.app).post('/v1/auth/pin-login', { device_id: shop.deviceId, device_secret: 'x'.repeat(43), staff_id: shop.cashierId, pin: '1111' });
    expect(wrongSecret.status).toBe(401);
  });

  it('blocks staff who are not set up for the device\'s branch', async () => {
    const shop = await newShop(env.app);
    const b2 = await shop.owner.post('/v1/branches', { code: 'TWO', name: 'Second' });
    const r = await shop.owner.post('/v1/staff', { first_name: 'Zed', role_id: shop.roleId('cashier'), branch_ids: [b2.body.id], pin: '4444' });
    const login = await client(env.app).post('/v1/auth/pin-login', { device_id: shop.deviceId, device_secret: shop.deviceSecret, staff_id: r.body.id, pin: '4444' });
    expect(login.status).toBe(403);
  });

  it('numbers POS devices per branch for receipt numbers', async () => {
    const shop = await newShop(env.app);
    const d2 = await shop.owner.post('/v1/devices', { branch_id: shop.branchId, name: 'Till 2', kind: 'pos' });
    expect(d2.body.device_no).toBe(2);
    const printer = await shop.owner.post('/v1/devices', { branch_id: shop.branchId, name: 'Labels', kind: 'label_printer' });
    expect(printer.body.device_no).toBeNull();
  });
});

describe('permissions are checked server-side', () => {
  it('stops a cashier from editing products or staff', async () => {
    const shop = await newShop(env.app);
    const sam = await shop.pinLogin(shop.cashierId, '1111');
    const p = await sam.post('/v1/products', { name: 'Sneaky', price_pence: 1 });
    expect(p.status).toBe(403);
    expect(p.body.details.missing).toContain('products.edit');
    expect((await sam.get('/v1/staff')).status).toBe(403);
  });

  it('applies per-person overrides on top of the role', async () => {
    const shop = await newShop(env.app);
    const r = await shop.owner.put(`/v1/staff/${shop.cashierId}/overrides`, {
      permissions: { 'pos.refund': true, 'pos.void_line': false }, limits: { 'pos.refund.max_amount_pence': 500 }, reason: 'Trusted' });
    expect(r.status).toBe(200);
    expect(r.body.permissions).toContain('pos.refund');
    expect(r.body.permissions).not.toContain('pos.void_line');
    expect(r.body.limits['pos.refund.max_amount_pence']).toBe(500);
  });

  it('protects the owner role', async () => {
    const shop = await newShop(env.app);
    const r = await shop.owner.put(`/v1/roles/${shop.roleId('owner')}/permissions`, { permissions: ['pos.sell'] });
    expect(r.status).toBe(403);
    const mo = await shop.pinLogin(shop.managerId, '2222');
    const promote = await mo.patch(`/v1/staff/${shop.cashierId}`, { role_id: shop.roleId('owner') });
    expect(promote.status).toBe(403);
  });

  it('records role changes in the audit log', async () => {
    const shop = await newShop(env.app);
    await shop.owner.put(`/v1/roles/${shop.roleId('cashier')}/limits`, { limits: { 'pos.discount.max_percent': 10 } });
    const rows = await env.db.asWorker((tx) => tx`
      SELECT actor_staff_id, action FROM audit_log WHERE tenant_id = ${shop.tenantId} AND table_name = 'role_limits' AND action = 'UPDATE'`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_staff_id).toBe(shop.ownerId);
  });
});
