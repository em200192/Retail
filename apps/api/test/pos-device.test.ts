import { uuidv7 } from '@retail/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSale, client, type Client, mkProduct, newShop, type Shop, useTestApp } from './helpers.ts';

const env = useTestApp();

let shop: Shop;
let sam: Client;

beforeAll(async () => {
  shop = await newShop(env.app, { code: 'DEV1' });
  sam = await shop.pinLogin(shop.cashierId, '1111');
});

describe('device hello (till start-up before login)', () => {
  it('returns the shop header, till and staff tiles for a valid device secret', async () => {
    const r = await client(env.app).post('/v1/devices/hello', { device_id: shop.deviceId, device_secret: shop.deviceSecret });
    expect(r.status).toBe(200);
    expect(r.body.device).toMatchObject({ id: shop.deviceId, device_no: shop.deviceNo });
    expect(r.body.branch).toMatchObject({ id: shop.branchId, code: 'DEV1', postcode: 'M1 1AA' });
    expect(r.body.tenant.trading_name).toMatch(/Corner Shop/);
    expect(r.body.till).toMatchObject({ id: shop.tillId, open_session_id: null });
    const ids = r.body.staff.map((s: any) => s.id);
    expect(ids).toEqual(expect.arrayContaining([shop.ownerId, shop.cashierId, shop.managerId, shop.supervisorId]));
    expect(r.body.staff.find((s: any) => s.id === shop.managerId).role_key).toBe('manager');
    expect(JSON.stringify(r.body)).not.toMatch(/pin_hash|secret/);
  });

  it('rejects a wrong secret or unknown device', async () => {
    const bad = await client(env.app).post('/v1/devices/hello', { device_id: shop.deviceId, device_secret: 'x'.repeat(43) });
    expect(bad.status).toBe(401);
    const unknown = await client(env.app).post('/v1/devices/hello', { device_id: uuidv7(), device_secret: shop.deviceSecret });
    expect(unknown.status).toBe(401);
  });

  it('shows the open till session so a restarted till can carry on', async () => {
    const s = await sam.post('/v1/till-sessions', { id: uuidv7(), till_id: shop.tillId, opening_float_pence: 5000 });
    expect(s.status).toBe(201);
    const r = await client(env.app).post('/v1/devices/hello', { device_id: shop.deviceId, device_secret: shop.deviceSecret });
    expect(r.body.till.open_session_id).toBe(s.body.id);
    const pull = (await sam.get('/v1/sync/pull')).body;
    expect(pull.tills.find((t: any) => t.id === shop.tillId).open_session_id).toBe(s.body.id);
    expect(pull.tenant.trading_name).toMatch(/Corner Shop/);
    expect(pull.branch.postcode).toBe('M1 1AA');
  });

  it('tells a re-paired till the last receipt sequence it used', async () => {
    const hello = () => client(env.app).post('/v1/devices/hello', { device_id: shop.deviceId, device_secret: shop.deviceSecret });
    expect((await hello()).body.device.last_receipt_seq).toBe(0);
    const milk = await mkProduct(shop.owner, { name: 'Milk', price: 165, vat: 'Z' });
    const sale = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 1, unitPrice: 165, vatCode: 'Z' }]);
    sale.receipt_number = `DEV1-${shop.deviceNo}-41`;
    expect((await sam.post('/v1/sync/push', { sales: [sale] })).body.sales[0].status).toBe('created');
    expect((await hello()).body.device.last_receipt_seq).toBe(41);
  });
});

describe('online manager approval check', () => {
  const ask = (c: Client, approver: string, pin: string, extra: Record<string, unknown> = {}) =>
    c.post('/v1/pos/verify-approval', { action_code: 'pos.discount', limit_code: 'pos.discount.max_percent', value: 10,
      approver_staff_id: approver, approver_pin: pin, ...extra });

  it('accepts a manager with the right PIN', async () => {
    const r = await ask(sam, shop.managerId, '2222');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ approved_by: shop.managerId, display_name: 'Mo', outcome: 'approved' });
  });

  it('rejects a wrong PIN, a non-approver and self-approval', async () => {
    expect((await ask(sam, shop.managerId, '0000')).status).toBe(403);
    // Cashiers do not hold pos.approve.
    const sam2 = await shop.pinLogin(shop.supervisorId, '3333');
    expect((await ask(sam2, shop.cashierId, '1111')).status).toBe(403);
    const mo = await shop.pinLogin(shop.managerId, '2222');
    expect((await ask(mo, shop.managerId, '2222')).status).toBe(403);
  });

  it('is only for till sessions', async () => {
    expect((await ask(shop.owner, shop.managerId, '2222')).status).toBe(403);
  });
});
