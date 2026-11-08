import { describe, expect, it } from 'vitest';
import { buildSale, mkProduct, newShop, useTestApp } from './helpers.ts';

describe('fixes from till QA', () => {
  const env = useTestApp();

  it('lets a supervisor find another cashier’s receipt to refund it, but not list everyone’s sales', async () => {
    const shop = await newShop(env.app);
    const p = await mkProduct(shop.owner, { name: 'Crisps', price: 100 });
    const cashier = await shop.pinLogin(shop.cashierId, '1111');
    const sale = buildSale(shop, shop.cashierId, [{ productId: p, qty: 1, unitPrice: 100 }]);
    expect((await cashier.post('/v1/sync/push', { sales: [sale] })).body.sales[0].status).toBe('created');

    const sup = await shop.pinLogin(shop.supervisorId, '3333');
    const found = await sup.get(`/v1/sales?branch_id=${shop.branchId}&receipt_number=${sale.receipt_number}`);
    expect(found.status).toBe(200);
    expect(found.body.map((s: any) => s.id)).toEqual([sale.id]);
    const all = await sup.get(`/v1/sales?branch_id=${shop.branchId}`);
    expect(all.body.find((s: any) => s.id === sale.id)).toBeUndefined();
  });

  it('lets stock staff log in on a till and pull the catalogue', async () => {
    const shop = await newShop(env.app);
    const r = await shop.owner.post('/v1/staff', { first_name: 'Tom', role_id: shop.roleId('stock'), branch_ids: [shop.branchId], pin: '4444' });
    expect(r.status).toBe(201);
    const tom = await shop.pinLogin(r.body.id, '4444');
    const pull = await tom.get('/v1/sync/pull');
    expect(pull.status).toBe(200);
    expect(Array.isArray(pull.body.products)).toBe(true);
  });

  it('refuses an opening float that is clearly a typing mistake', async () => {
    const shop = await newShop(env.app);
    const sam = await shop.pinLogin(shop.cashierId, '1111');
    const bad = await sam.post('/v1/till-sessions', { till_id: shop.tillId, opening_float_pence: 150_001_200 });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/£5,000 or less/);
    expect((await sam.post('/v1/till-sessions', { till_id: shop.tillId, opening_float_pence: 15_000 })).status).toBe(201);
  });
});
