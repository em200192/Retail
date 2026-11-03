import { describe, expect, it } from 'vitest';
import { mkProduct, newShop, useTestApp } from './helpers.ts';

const env = useTestApp();

describe('catalogue, pricing and scanning', () => {
  it('resolves price levels, quantity breaks and branch prices', async () => {
    const shop = await newShop(env.app);
    const id = await mkProduct(shop.owner, { name: 'Semi-skimmed milk 2L', price: 165, barcode: '5000000000028', vat: 'Z' });
    const levels = (await shop.owner.get('/v1/price-levels')).body;
    const trade = levels.find((l: any) => l.code === 'trade').id;
    await shop.owner.post(`/v1/products/${id}/prices`, { price_pence: 145, price_level_id: trade });
    await shop.owner.post(`/v1/products/${id}/prices`, { price_pence: 150, min_qty: 6 });
    await shop.owner.post(`/v1/products/${id}/prices`, { price_pence: 159, branch_id: shop.branchId });

    const scan = (await shop.owner.get(`/v1/scan?barcode=5000000000028&branch_id=${shop.branchId}`)).body;
    expect(scan).toMatchObject({ found: true, quantity: 1, unit_price_pence: 159, is_pmp: false });
    expect(scan.product).toMatchObject({ vat_code: 'Z', vat_rate_percent: 0 });
    const tradeScan = (await shop.owner.get(`/v1/scan?barcode=5000000000028&branch_id=${shop.branchId}&price_level_id=${trade}`)).body;
    expect(tradeScan.unit_price_pence).toBe(145);
  });

  it('never charges more than the printed price on a PMP pack', async () => {
    const shop = await newShop(env.app);
    await mkProduct(shop.owner, { name: 'Cola 500ml', price: 150, barcode: '5000112637922', pmp: 125 });
    const scan = (await shop.owner.get(`/v1/scan?barcode=5000112637922&branch_id=${shop.branchId}`)).body;
    expect(scan).toMatchObject({ is_pmp: true, pmp_price_pence: 125, resolved_price_pence: 150, unit_price_pence: 125 });
  });

  it('scans a case barcode as many units', async () => {
    const shop = await newShop(env.app);
    await mkProduct(shop.owner, { name: 'Water 500ml', price: 60, barcode: '5000000000035',
      extraBarcodes: [{ barcode: '15000000000032', barcode_type: 'ITF14', units_per_scan: 24 }] });
    const scan = (await shop.owner.get(`/v1/scan?barcode=15000000000032&branch_id=${shop.branchId}`)).body;
    expect(scan).toMatchObject({ quantity: 24, unit_price_pence: 60, line_amount_pence: 1440 });
  });

  it('reads weight and price from in-store scale barcodes', async () => {
    const shop = await newShop(env.app);
    const r = await shop.owner.post('/v1/barcode-rules', { name: 'Scale price', prefix: '2', item_code_start: 2, item_code_length: 5,
      value_type: 'price_pence', value_start: 7, value_length: 5 });
    expect(r.status).toBe(201);
    await shop.owner.post('/v1/barcode-rules', { name: 'Scale weight', prefix: '21', item_code_start: 3, item_code_length: 4,
      value_type: 'weight_g', value_start: 7, value_length: 5 });
    const cheese = await mkProduct(shop.owner, { name: 'Cheddar (per kg)', price: 899,
      extraBarcodes: [{ barcode: '00123', barcode_type: 'PLU' }] });
    const olives = await mkProduct(shop.owner, { name: 'Olives (per kg)', price: 1200,
      extraBarcodes: [{ barcode: '0456', barcode_type: 'PLU' }] });
    const byPrice = (await shop.owner.get(`/v1/scan?barcode=2001230045671&branch_id=${shop.branchId}`)).body;
    expect(byPrice).toMatchObject({ found: true, embedded: 'price', line_amount_pence: 456 });
    expect(byPrice.product.id).toBe(cheese);
    const byWeight = (await shop.owner.get(`/v1/scan?barcode=2104560045503&branch_id=${shop.branchId}`)).body;
    expect(byWeight).toMatchObject({ embedded: 'weight', quantity: 0.455, unit_price_pence: 1200, line_amount_pence: 546 });
    expect(byWeight.product.id).toBe(olives);
  });

  it('suggests an unknown barcode from the UK catalogue and copies it', async () => {
    const shop = await newShop(env.app);
    const scan = (await shop.owner.get(`/v1/scan?barcode=5000213001134&branch_id=${shop.branchId}`)).body;
    expect(scan.found).toBe(false);
    expect(scan.catalog_suggestion).toMatchObject({ name: 'Guinness Draught 4x440ml', min_age: 18 });
    const p = await shop.owner.post('/v1/products/from-catalog', { gtin: '5000213001134', price_pence: 650 });
    expect(p.status).toBe(201);
    const again = (await shop.owner.get(`/v1/scan?barcode=5000213001134&branch_id=${shop.branchId}`)).body;
    expect(again).toMatchObject({ found: true, unit_price_pence: 650, requires_age_check: true });
  });

  it('keeps price history: changes add rows, never overwrite', async () => {
    const shop = await newShop(env.app);
    const id = await mkProduct(shop.owner, { name: 'Bread', price: 120 });
    await shop.owner.post(`/v1/products/${id}/prices`, { price_pence: 135 });
    const hist = (await shop.owner.get(`/v1/products/${id}/prices`)).body;
    expect(hist.map((h: any) => h.price_pence)).toEqual([135, 120]);
    const outbox = await env.db.asWorker((tx) => tx`
      SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id = ${shop.tenantId} AND event_type = 'price.changed'`);
    expect(outbox[0]!.n).toBe(2);
  });

  it('applies category defaults (VAT, age) to new products', async () => {
    const shop = await newShop(env.app);
    const cat = await shop.owner.post('/v1/categories', { name: 'Beers & ciders', default_vat_code: 'S', default_min_age: 18 });
    const p = await shop.owner.post('/v1/products', { name: 'Lager 4x440', category_id: cat.body.id });
    expect(p.body).toMatchObject({ vat_code: 'S', min_age: 18 });
  });
});

describe('stock ledger', () => {
  it('receives, adjusts, wastes and reports low stock', async () => {
    const shop = await newShop(env.app);
    const id = await mkProduct(shop.owner, { name: 'Eggs x6', price: 199, reorder_point: 10, reorder_qty: 30 });
    const rec = await shop.owner.post('/v1/stock/receipts', { branch_id: shop.branchId, lines: [{ product_id: id, quantity: 24, unit_cost_pence: 110 }] });
    expect(rec.status).toBe(201);
    const waste = await shop.owner.post('/v1/stock/waste', { branch_id: shop.branchId, product_id: id, quantity: 2, reason_code: 'damaged' });
    expect(waste.body.cost_pence).toBe(220);
    const adj = await shop.owner.post('/v1/stock/adjustments', { branch_id: shop.branchId, product_id: id, quantity: -14, reason: 'Recount' });
    expect(adj.status).toBe(201);
    expect(adj.body.on_hand).toBe(8);
    const low = (await shop.owner.get(`/v1/stock/low?branch_id=${shop.branchId}`)).body;
    expect(low.map((l: any) => l.product_id)).toEqual([id]);
    const moves = (await shop.owner.get(`/v1/stock/movements?branch_id=${shop.branchId}&product_id=${id}`)).body;
    expect(moves.map((m: any) => m.movement_type).sort()).toEqual(['adjustment', 'receipt', 'waste']);
  });

  it('needs a manager PIN for adjustments over the limit', async () => {
    const shop = await newShop(env.app);
    const id = await mkProduct(shop.owner, { name: 'Crisps', price: 100 });
    await shop.owner.put(`/v1/roles/${shop.roleId('supervisor')}/permissions`, {
      permissions: ['stock.adjust', 'stock.view', 'products.view'] });
    await shop.owner.put(`/v1/roles/${shop.roleId('supervisor')}/limits`, { limits: { 'stock.adjust.max_qty': 5 } });
    const ava = await shop.pinLogin(shop.supervisorId, '3333');
    expect((await ava.post('/v1/stock/adjustments', { branch_id: shop.branchId, product_id: id, quantity: 3 })).status).toBe(201);
    const over = await ava.post('/v1/stock/adjustments', { branch_id: shop.branchId, product_id: id, quantity: 12 });
    expect(over.status).toBe(403);
    expect(over.body.details.needs_approval).toBe(true);
    const badPin = await ava.post('/v1/stock/adjustments', { branch_id: shop.branchId, product_id: id, quantity: 12,
      approval: { approver_staff_id: shop.ownerId, approver_pin: '0000' } });
    expect(badPin.status).toBe(403);
    const ok = await ava.post('/v1/stock/adjustments', { branch_id: shop.branchId, product_id: id, quantity: 12,
      approval: { approver_staff_id: shop.ownerId, approver_pin: '9999' } });
    expect(ok.status).toBe(201);
    expect(ok.body.approval.outcome).toBe('approved');
    expect(ok.body.on_hand).toBe(15);
  });

  it('cannot bypass the ledger', async () => {
    const shop = await newShop(env.app);
    const id = await mkProduct(shop.owner, { name: 'Tea', price: 300 });
    await shop.owner.post('/v1/stock/receipts', { branch_id: shop.branchId, lines: [{ product_id: id, quantity: 5 }] });
    const ctx = { tenantId: shop.tenantId, staffId: shop.ownerId, userId: null, deviceId: null };
    await expect(env.db.withTenant(ctx, (tx) => tx`UPDATE stock_levels SET quantity = 999`)).rejects.toThrow(/permission denied/);
    await expect(env.db.withTenant(ctx, (tx) => tx`DELETE FROM stock_movements`)).rejects.toThrow(/permission denied/);
  });

  it('transfers between branches and runs a stocktake', async () => {
    const shop = await newShop(env.app);
    const id = await mkProduct(shop.owner, { name: 'Sugar 1kg', price: 129 });
    const b2 = (await shop.owner.post('/v1/branches', { code: 'B2', name: 'Station Rd' })).body.id;
    await shop.owner.post('/v1/stock/receipts', { branch_id: shop.branchId, lines: [{ product_id: id, quantity: 20, unit_cost_pence: 80 }] });
    const t = await shop.owner.post('/v1/stock/transfers', { from_branch_id: shop.branchId, to_branch_id: b2, lines: [{ product_id: id, quantity: 8 }] });
    expect(t.status).toBe(201);
    const rcv = await shop.owner.post(`/v1/stock/transfers/${t.body.id}/receive`, { lines: [{ product_id: id, quantity_received: 7 }] });
    expect(rcv.body.status).toBe('received');
    const s1 = (await shop.owner.get(`/v1/stock?branch_id=${shop.branchId}`)).body.find((r: any) => r.product_id === id);
    const s2 = (await shop.owner.get(`/v1/stock?branch_id=${b2}`)).body.find((r: any) => r.product_id === id);
    expect([s1.on_hand, s2.on_hand]).toEqual([12, 7]);

    const st = await shop.owner.post('/v1/stocktakes', { branch_id: shop.branchId });
    await shop.owner.post(`/v1/stocktakes/${st.body.id}/counts`, { product_id: id, counted_qty: 10 });
    const done = await shop.owner.post(`/v1/stocktakes/${st.body.id}/complete`);
    expect(done.body).toMatchObject({ status: 'completed', lines_with_variance: 1, variance_value_pence: -160 });
    const after = (await shop.owner.get(`/v1/stock?branch_id=${shop.branchId}`)).body.find((r: any) => r.product_id === id);
    expect(after.on_hand).toBe(10);
  });

  it('tracks expiry batches', async () => {
    const shop = await newShop(env.app);
    const id = await mkProduct(shop.owner, { name: 'Yoghurt', price: 90, track_expiry: true });
    const soon = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await shop.owner.post('/v1/stock/receipts', { branch_id: shop.branchId, lines: [{ product_id: id, quantity: 12, expiry_date: soon }] });
    const exp = (await shop.owner.get(`/v1/stock/expiring?branch_id=${shop.branchId}`)).body;
    expect(exp).toHaveLength(1);
    expect(exp[0]).toMatchObject({ product_id: id, qty_remaining: 12, days_left: 1 });
  });
});
