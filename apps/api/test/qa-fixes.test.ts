import { describe, expect, it } from 'vitest';
import { OCR_NOT_SET_UP, publishOutbox } from '../src/worker/jobs.ts';
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

  it('marks an invoice as not read, with a reason, when invoice reading is not set up', async () => {
    const shop = await newShop(env.app);
    const inv = await shop.owner.post('/v1/invoices', { branch_id: shop.branchId, file_name: 'a.pdf', mime_type: 'application/pdf',
      content_base64: Buffer.from('%PDF-1.4 fake').toString('base64') });
    expect(inv.status).toBe(201);
    while ((await publishOutbox({ db: env.db, files: env.files })).published > 0) { /* drain */ }
    const d = (await shop.owner.get(`/v1/invoices/${inv.body.id}`)).body;
    expect(d).toMatchObject({ status: 'failed', ocr_error: OCR_NOT_SET_UP });
  });

  it('says which product already has a barcode', async () => {
    const shop = await newShop(env.app);
    await mkProduct(shop.owner, { name: 'Walkers Ready Salted', price: 125, barcode: '5000328657950' });
    const other = await mkProduct(shop.owner, { name: 'Walkers Cheese', price: 125 });
    const r = await shop.owner.post(`/v1/products/${other}/barcodes`, { barcode: '5000328657950', barcode_type: 'EAN13' });
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('This barcode is already on Walkers Ready Salted');
  });

  it('lists the primary shop first, not alphabetically', async () => {
    const shop = await newShop(env.app);
    expect((await shop.owner.post('/v1/branches', { code: 'AAA1', name: 'Aardvark Road' })).status).toBe(201);
    const me = (await shop.owner.get('/v1/me')).body;
    expect(me.branches[0].id).toBe(shop.branchId);
  });
});
