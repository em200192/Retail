import { describe, expect, it } from 'vitest';
import type { OcrInvoice } from '../src/integrations/ocr.ts';
import { publishOutbox } from '../src/worker/jobs.ts';
import { mkProduct, newShop, useTestApp } from './helpers.ts';

const env = useTestApp();

const invoiceLines = (overrides: Partial<OcrInvoice['lines'][number]>[]): OcrInvoice['lines'] => overrides.map((o) => ({
  raw_text: null, supplier_code: null, barcode: null, description: 'x', quantity: 1, pack_size: null, unit_cost_pence: null,
  line_total_pence: null, rrp_pence: null, vat_code: 'S', is_pmp: null, pmp_price_pence: null, expiry_date: null, ...o,
}));

const booker = (invoiceNumber: string, lines: OcrInvoice['lines'], confidence = 0.95): OcrInvoice => ({
  supplier_name: 'Booker Ltd', supplier_vat_number: 'GB 123 4567 89', invoice_number: invoiceNumber, invoice_date: '2026-11-01',
  due_date: null, subtotal_pence: 5000, vat_pence: 600, total_pence: 5600, confidence, lines,
});

describe('staff requests -> shopping list -> purchase order', () => {
  it('runs the full purchasing loop', async () => {
    const shop = await newShop(env.app);
    const cola = await mkProduct(shop.owner, { name: 'Cola 500ml', price: 150, reorder_point: 12, reorder_qty: 48 });
    const crisps = await mkProduct(shop.owner, { name: 'Crisps 32g', price: 100 });
    const sup = (await shop.owner.post('/v1/suppliers', { name: 'Bestway', email: 'orders@bestway.example', order_method: 'email' })).body;
    await shop.owner.post(`/v1/suppliers/${sup.id}/products`, { product_id: cola, supplier_code: 'BW-COLA24', pack_size: 24, case_cost_pence: 1440, is_preferred: true });
    await shop.owner.post(`/v1/suppliers/${sup.id}/products`, { product_id: crisps, supplier_code: 'BW-CR32', pack_size: 32, case_cost_pence: 1600 });

    // Cashier: "we're out of crisps"
    const sam = await shop.pinLogin(shop.cashierId, '1111');
    const reqRes = await sam.post('/v1/purchase-requests', { branch_id: shop.branchId, product_id: crisps, quantity: 32, priority: 'urgent' });
    expect(reqRes.status).toBe(201);
    expect((await sam.get(`/v1/purchase-requests?branch_id=${shop.branchId}`)).body).toHaveLength(1);
    expect((await sam.post(`/v1/purchase-requests/${reqRes.body.id}/review`, { decision: 'approve' })).status).toBe(403);

    const mo = await shop.pinLogin(shop.managerId, '2222');
    const reviewed = await mo.post(`/v1/purchase-requests/${reqRes.body.id}/review`, { decision: 'approve' });
    expect(reviewed.body.status).toBe('approved');

    // Low stock (cola: 0 on hand, reorder point 12) -> suggested line.
    await shop.owner.post('/v1/stock/receipts', { branch_id: shop.branchId, lines: [{ product_id: cola, quantity: 5 }] });
    const gen = await mo.post('/v1/purchase-list/generate', { branch_id: shop.branchId });
    expect(gen.body.added).toHaveLength(1);
    expect(gen.body.added[0]).toMatchObject({ product_id: cola, quantity: 48, source: 'reorder_point', status: 'pending' });
    expect((await mo.post('/v1/purchase-list/generate', { branch_id: shop.branchId })).body.added).toHaveLength(0);
    await mo.patch(`/v1/purchase-list/items/${gen.body.added[0].id}`, { status: 'approved' });

    const list = (await mo.get(`/v1/purchase-list?branch_id=${shop.branchId}`)).body;
    expect(list.items.map((i: any) => i.source).sort()).toEqual(['reorder_point', 'staff_request']);

    const pos = await mo.post('/v1/purchase-orders/from-list', { branch_id: shop.branchId });
    expect(pos.status).toBe(201);
    expect(pos.body).toHaveLength(1);
    const po = (await mo.get(`/v1/purchase-orders?branch_id=${shop.branchId}`)).body[0];
    const lines = Object.fromEntries(po.lines.map((l: any) => [l.product_id, l]));
    expect(lines[cola]).toMatchObject({ unit: 'case', qty_ordered: 2, unit_cost_pence: 1440 });
    expect(lines[crisps]).toMatchObject({ unit: 'case', qty_ordered: 1 });
    expect(po.estimated_total_pence).toBe(2 * 1440 + 1600);

    const sent = await mo.post(`/v1/purchase-orders/${po.id}/send`, {});
    expect(sent.body.status).toBe('sent');
    // Earlier test files leave events in the shared outbox; drain it (one call publishes a batch of 50).
    while ((await publishOutbox({ db: env.db })).published > 0) { /* keep draining */ }
    const emails = await env.db.asWorker((tx) => tx`
      SELECT to_address, template_code FROM outbound_messages WHERE tenant_id = ${shop.tenantId} AND template_code = 'purchase_order'`);
    expect(emails).toEqual([{ to_address: 'orders@bestway.example', template_code: 'purchase_order' }]);
  });
});

describe('supplier invoices with OCR', () => {
  it('matches by supplier code, barcode and name; learns from confirmations; blocks duplicates', async () => {
    const shop = await newShop(env.app);
    const beans = await mkProduct(shop.owner, { name: 'Heinz Baked Beanz 415g', price: 135, barcode: '5000157024671' });
    const tea = await mkProduct(shop.owner, { name: 'PG Tips 80 Tea Bags', price: 299 });
    const bread = await mkProduct(shop.owner, { name: 'Warburtons Toastie White 800g', price: 155, track_expiry: true });

    const upload = () => shop.owner.post('/v1/invoices', { branch_id: shop.branchId, file_name: 'booker.pdf', mime_type: 'application/pdf',
      content_base64: Buffer.from('%PDF-1.4 fake').toString('base64') });

    // ---- invoice 1: the shop has never seen Booker before
    const inv1 = await upload();
    expect(inv1.status).toBe(201);
    env.ocr.queued.push(booker('INV-1001', invoiceLines([
      { supplier_code: '123456', barcode: '5000157024671', description: 'HEINZ BEANZ 24X415G', quantity: 1, pack_size: 24, unit_cost_pence: 1680, vat_code: 'Z' },
      { supplier_code: '223344', description: 'PG TIPS TEA BAGS 80', quantity: 2, pack_size: 6, unit_cost_pence: 1200, vat_code: 'Z' },
      { supplier_code: '998877', description: 'WARBURTONS TOASTIE 800G', quantity: 1, pack_size: 10, unit_cost_pence: 900, vat_code: 'Z', expiry_date: '2026-11-06' },
      { supplier_code: '555000', description: 'CARRIER BAG CHARGE', quantity: 1, unit_cost_pence: 0, vat_code: 'S' },
    ])));
    await publishOutbox({ db: env.db, ocr: env.ocr, files: env.files });

    let inv = (await shop.owner.get(`/v1/invoices/${inv1.body.id}`)).body;
    expect(inv).toMatchObject({ status: 'needs_review', invoice_number: 'INV-1001', supplier_name: 'Booker' });
    const byCode = Object.fromEntries(inv.lines.map((l: any) => [l.supplier_code, l]));
    expect(byCode['123456']).toMatchObject({ product_id: beans, match_status: 'matched_auto' }); // barcode
    expect(byCode['223344']).toMatchObject({ product_id: tea, match_status: 'matched_auto' }); // fuzzy name match
    expect(byCode['223344'].match_confidence).toBeLessThan(0.9);                               // ...so a human reviews it
    expect(byCode['998877']).toMatchObject({ product_id: bread, match_status: 'matched_auto' });
    expect(byCode['998877'].match_confidence).toBeLessThanOrEqual(0.85);
    expect(byCode['555000'].match_status).toBe('unmatched');                                  // bag charge: no product

    // Posting is blocked until every line is resolved.
    expect((await shop.owner.post(`/v1/invoices/${inv1.body.id}/post`)).status).toBe(422);
    await shop.owner.patch(`/v1/invoices/${inv1.body.id}/lines/${byCode['223344'].id}`, { product_id: tea });
    await shop.owner.patch(`/v1/invoices/${inv1.body.id}/lines/${byCode['998877'].id}`, { product_id: bread });
    await shop.owner.patch(`/v1/invoices/${inv1.body.id}/lines/${byCode['555000'].id}`, { ignore: true });
    const posted = await shop.owner.post(`/v1/invoices/${inv1.body.id}/post`);
    expect(posted.status).toBe(200);
    expect(posted.body.lines_received).toBe(3);

    const stock = Object.fromEntries((await shop.owner.get(`/v1/stock?branch_id=${shop.branchId}`)).body.map((r: any) => [r.product_id, r.on_hand]));
    expect(stock[beans]).toBe(24);
    expect(stock[tea]).toBe(12);
    expect(stock[bread]).toBe(10);
    const beansRow = (await shop.owner.get(`/v1/products/${beans}`)).body;
    expect(beansRow).toMatchObject({ last_cost_pence: 70, avg_cost_pence: 70 });
    expect((await shop.owner.get(`/v1/stock/expiring?branch_id=${shop.branchId}`)).body.length).toBeLessThanOrEqual(1);

    // ---- invoice 2 from the same wholesaler: everything auto-matches now
    const inv2 = await upload();
    env.ocr.queued.push(booker('INV-1002', invoiceLines([
      { supplier_code: '223344', description: 'PG TIPS 80S', quantity: 1, unit_cost_pence: 1200, vat_code: 'Z' },
      { supplier_code: '998877', description: 'WARBURTONS TST WHT', quantity: 2, unit_cost_pence: 900, vat_code: 'Z' },
    ])));
    await publishOutbox({ db: env.db, ocr: env.ocr, files: env.files });
    inv = (await shop.owner.get(`/v1/invoices/${inv2.body.id}`)).body;
    expect(inv.status).toBe('approved');
    expect(inv.lines.map((l: any) => [l.match_status, l.match_confidence, l.pack_size])).toEqual([
      ['matched_auto', 1, 6], ['matched_auto', 1, 10]]);

    // ---- the same invoice uploaded again is rejected, not double-counted
    const dup = await upload();
    env.ocr.queued.push(booker('INV-1001', invoiceLines([{ supplier_code: '123456', description: 'HEINZ', quantity: 1 }])));
    await publishOutbox({ db: env.db, ocr: env.ocr, files: env.files });
    const dupRow = (await shop.owner.get(`/v1/invoices/${dup.body.id}`)).body;
    expect(dupRow.status).toBe('rejected');
    expect(dupRow.ocr_error).toMatch(/Duplicate/);
  });

  it('accepts a hand-typed invoice when OCR is not available', async () => {
    const shop = await newShop(env.app);
    const milk = await mkProduct(shop.owner, { name: 'Milk 4 pint', price: 165, barcode: '5000000000066' });
    const inv = await shop.owner.post('/v1/invoices', { branch_id: shop.branchId, file_name: 'photo.jpg', mime_type: 'image/jpeg',
      content_base64: Buffer.from('jpeg').toString('base64') });
    const ex = await shop.owner.put(`/v1/invoices/${inv.body.id}/extraction`, {
      ...booker('M-77', invoiceLines([{ barcode: '5000000000066', description: 'Milk', quantity: 12, unit_cost_pence: 105, vat_code: 'Z' }])),
      supplier_name: 'Dairy Direct', supplier_vat_number: null });
    expect(ex.status).toBe(200);
    expect(ex.body.invoice.status).toBe('needs_review'); // unknown supplier
    const sup = (await shop.owner.post('/v1/suppliers', { name: 'Dairy Direct' })).body;
    await shop.owner.patch(`/v1/invoices/${inv.body.id}`, { supplier_id: sup.id });
    expect((await shop.owner.post(`/v1/invoices/${inv.body.id}/post`)).status).toBe(200);
    const s = (await shop.owner.get(`/v1/stock?branch_id=${shop.branchId}`)).body.find((r: any) => r.product_id === milk);
    expect(s.on_hand).toBe(12);
  });
});
