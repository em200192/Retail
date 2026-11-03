import { uuidv7 } from '@retail/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSale, type Client, mkProduct, newShop, type Shop, useTestApp } from './helpers.ts';

const env = useTestApp();

let shop: Shop;
let sam: Client;      // cashier on the till
let milk: string, cola: string, lager: string;
let sessionId: string;

const stockOf = async (productId: string) =>
  (await shop.owner.get(`/v1/stock?branch_id=${shop.branchId}`)).body.find((r: any) => r.product_id === productId)?.on_hand;

beforeAll(async () => {
  shop = await newShop(env.app, { code: 'MAN1' });
  milk = await mkProduct(shop.owner, { name: 'Milk 2L', price: 165, barcode: '5000000000042', vat: 'Z' });
  cola = await mkProduct(shop.owner, { name: 'Cola 500ml PMP', price: 150, barcode: '5000112637939', pmp: 125 });
  lager = await mkProduct(shop.owner, { name: 'Lager 4x440ml', price: 650, barcode: '5000000000059', min_age: 18 });
  await shop.owner.post('/v1/stock/receipts', { branch_id: shop.branchId, lines: [
    { product_id: milk, quantity: 50, unit_cost_pence: 110 }, { product_id: cola, quantity: 50, unit_cost_pence: 60 },
    { product_id: lager, quantity: 20, unit_cost_pence: 400 }] });
  sam = await shop.pinLogin(shop.cashierId, '1111');
  const s = await sam.post('/v1/till-sessions', { id: uuidv7(), till_id: shop.tillId, opening_float_pence: 10000 });
  expect(s.status).toBe(201);
  sessionId = s.body.id;
});

const push = (c: Client, sales: unknown[] = [], refunds: unknown[] = []) => c.post('/v1/sync/push', { sales, refunds });

describe('till sessions', () => {
  it('allows only one open session per till and is idempotent on the device id', async () => {
    const again = await sam.post('/v1/till-sessions', { id: sessionId, till_id: shop.tillId, opening_float_pence: 10000 });
    expect(again.status).toBe(200);
    const second = await sam.post('/v1/till-sessions', { id: uuidv7(), till_id: shop.tillId });
    expect(second.status).toBe(409);
  });
});

describe('offline sale sync', () => {
  it('stores a sale, takes stock off and is safe to retry', async () => {
    const sale = buildSale(shop, shop.cashierId, [
      { productId: milk, qty: 2, unitPrice: 165, vatCode: 'Z', barcode: '5000000000042' },
      { productId: cola, qty: 1, unitPrice: 125, barcode: '5000112637939', pmpPrice: 125 },
    ], { tillSessionId: sessionId });
    const first = await push(sam, [sale]);
    expect(first.body.sales).toEqual([{ id: sale.id, status: 'created' }]);
    expect(await stockOf(milk)).toBe(48);
    // Network dropped before the device saw the reply -> it sends again.
    const retry = await push(sam, [sale]);
    expect(retry.body.sales).toEqual([{ id: sale.id, status: 'duplicate' }]);
    expect(await stockOf(milk)).toBe(48);

    const stored = (await shop.owner.get(`/v1/sales/${sale.id}`)).body;
    expect(stored).toMatchObject({ receipt_number: sale.receipt_number, total_pence: 455, vat_pence: 21, status: 'completed' });
    expect(stored.lines[1]).toMatchObject({ vat_code: 'S', vat_rate_percent: 20, vat_pence: 21, unit_cost_pence: 60 });
  });

  it('rejects a sale whose VAT does not match the shared rounding', async () => {
    const sale = buildSale(shop, shop.cashierId, [{ productId: cola, qty: 1, unitPrice: 125, pmpPrice: 125, barcode: '5000112637939' }]);
    sale.lines[0]!.vat_pence = 20; sale.vat_pence = 20;
    const r = await push(sam, [sale]);
    expect(r.body.sales[0]).toMatchObject({ status: 'rejected', error: 'unprocessable' });
    expect(r.body.sales[0].message).toMatch(/VAT must be 21p/);
  });

  it('rejects charging above the printed PMP price', async () => {
    const overPmp = buildSale(shop, shop.cashierId, [{ productId: cola, qty: 1, unitPrice: 150, pmpPrice: 125, barcode: '5000112637939' }]);
    expect((await push(sam, [overPmp])).body.sales[0].status).toBe('rejected');
    // ...and pretending a PMP barcode is not PMP doesn't work either.
    const hidden = buildSale(shop, shop.cashierId, [{ productId: cola, qty: 1, unitPrice: 150, barcode: '5000112637939' }]);
    const r = await push(sam, [hidden]);
    expect(r.body.sales[0].message).toMatch(/price-marked at 125p/);
  });

  it('rejects totals that do not add up and payments that do not cover the total', async () => {
    const sale = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 1, unitPrice: 165, vatCode: 'Z' }]);
    sale.total_pence = 100;
    expect((await push(sam, [sale])).body.sales[0].message).toMatch(/totals do not match/);
    const short = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 1, unitPrice: 165, vatCode: 'Z' }]);
    short.payments[0]!.amount_pence = 100;
    short.payments[0]!.change_pence = short.payments[0]!.tendered_pence! - 100;
    expect((await push(sam, [short])).body.sales[0].message).toMatch(/Payments/);
  });

  it('requires a passed Challenge 25 check for age-restricted items', async () => {
    const noCheck = buildSale(shop, shop.cashierId, [{ productId: lager, qty: 1, unitPrice: 650 }]);
    expect((await push(sam, [noCheck])).body.sales[0].message).toMatch(/Challenge 25/);

    const refusedId = uuidv7();
    const refused = buildSale(shop, shop.cashierId, [{ productId: lager, qty: 1, unitPrice: 650, ageCheckId: refusedId }], {
      ageChecks: [{ id: refusedId, product_id: lager, staff_id: shop.cashierId, required_age: 18, outcome: 'refused', occurred_at: new Date().toISOString() }] });
    expect((await push(sam, [refused])).body.sales[0].status).toBe('rejected');

    const okId = uuidv7();
    const ok = buildSale(shop, shop.cashierId, [{ productId: lager, qty: 1, unitPrice: 650, ageCheckId: okId }], {
      ageChecks: [{ id: okId, product_id: lager, staff_id: shop.cashierId, required_age: 25, outcome: 'id_checked_ok', occurred_at: new Date().toISOString() }] });
    expect((await push(sam, [ok])).body.sales[0].status).toBe('created');
    const log = await env.db.withTenant({ tenantId: shop.tenantId, staffId: null, userId: null, deviceId: null },
      (tx) => tx`SELECT outcome FROM age_checks WHERE sale_id = ${ok.id}`);
    expect(log[0]!.outcome).toBe('id_checked_ok');
  });

  it('enforces discount limits unless a manager approved', async () => {
    // Cashier limit: 5% and 100p. A 10% discount on a £6.50 item is over.
    const lineDiscount = 65;
    const mk = (approvalId?: string) => {
      const s = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 4, unitPrice: 165, vatCode: 'Z', lineDiscount }]);
      s.discounts = [{ id: uuidv7(), sale_line_id: s.lines[0]!.id, discount_type: 'percent', percent: 10, amount_pence: lineDiscount,
        reason_code: 'damaged_packaging', staff_id: shop.cashierId, approval_id: approvalId ?? null }];
      return s;
    };
    const denied = await push(sam, [mk()]);
    expect(denied.body.sales[0]).toMatchObject({ status: 'rejected', error: 'forbidden' });

    const approvalId = uuidv7();
    const approved = mk(approvalId);
    approved.approvals = [{ id: approvalId, sale_line_id: approved.lines[0]!.id, action_code: 'pos.discount', requested_by: shop.cashierId,
      approved_by: shop.managerId, outcome: 'approved', value: 10, occurred_at: new Date().toISOString() }];
    expect((await push(sam, [approved])).body.sales[0].status).toBe('created');

    // A cashier cannot be the "manager" approving their own discount.
    const selfApproval = uuidv7();
    const self = mk(selfApproval);
    self.approvals = [{ id: selfApproval, action_code: 'pos.discount', requested_by: shop.cashierId, approved_by: shop.supervisorId,
      outcome: 'approved', occurred_at: new Date().toISOString() }];
    self.approvals[0]!['approved_by' as never] = shop.cashierId as never;
    expect((await push(sam, [self])).body.sales[0].status).toBe('rejected');
  });

  it('spreads a basket discount over the lines so VAT stays right', async () => {
    const approvalId = uuidv7();
    const s = buildSale(shop, shop.ownerId, [
      { productId: milk, qty: 1, unitPrice: 165, vatCode: 'Z' }, { productId: cola, qty: 2, unitPrice: 125, pmpPrice: 125, barcode: '5000112637939' },
    ], { basketDiscount: 41 });
    s.discounts = [{ id: uuidv7(), discount_type: 'percent', percent: 10, amount_pence: 41, staff_id: shop.ownerId, approval_id: null }];
    void approvalId;
    const r = await push(sam, [s]);
    expect(r.body.sales[0].status).toBe('created');
    expect(s.total_pence).toBe(374);
    expect(s.lines.map((l) => l.line_discount_pence)).toEqual([16, 25]);
  });

  it('keeps voided lines for loss prevention but takes no stock for them', async () => {
    const before = await stockOf(milk);
    const s = buildSale(shop, shop.cashierId, [
      { productId: milk, qty: 1, unitPrice: 165, vatCode: 'Z' }, { productId: milk, qty: 3, unitPrice: 165, vatCode: 'Z', voidedBy: shop.cashierId },
    ]);
    expect((await push(sam, [s])).body.sales[0].status).toBe('created');
    expect(await stockOf(milk)).toBe(before - 1);
  });

  it('never lets training-mode sales touch stock', async () => {
    const before = await stockOf(milk);
    const s = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 5, unitPrice: 165, vatCode: 'Z' }], { isTraining: true });
    expect((await push(sam, [s])).body.sales[0].status).toBe('created');
    expect(await stockOf(milk)).toBe(before);
  });

  it('rejects receipt numbers from another device or branch', async () => {
    const s = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 1, unitPrice: 165, vatCode: 'Z' }]);
    s.receipt_number = 'OTHER-1-99';
    expect((await push(sam, [s])).body.sales[0].message).toMatch(/Receipt number/);
  });

  it('processes a batch independently: one bad sale does not block the rest', async () => {
    const good = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 1, unitPrice: 165, vatCode: 'Z' }]);
    const bad = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 1, unitPrice: 165, vatCode: 'Z' }]);
    bad.vat_pence = 99;
    const r = await push(sam, [bad, good, { nonsense: true }]);
    expect(r.body.sales.map((x: any) => x.status)).toEqual(['rejected', 'created', 'rejected']);
  });

  it('only accepts sync from POS device sessions', async () => {
    const s = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 1, unitPrice: 165, vatCode: 'Z' }]);
    expect((await push(shop.owner, [s])).status).toBe(403);
  });
});

describe('refunds and voids', () => {
  it('needs a manager for a cashier refund, then puts stock back', async () => {
    const sale = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 3, unitPrice: 165, vatCode: 'Z' }], { tillSessionId: sessionId });
    await push(sam, [sale]);
    const before = await stockOf(milk);
    const refund = (approval?: unknown) => ({
      id: uuidv7(), original_sale_id: sale.id, till_session_id: sessionId, staff_id: shop.supervisorId, reason_code: 'changed_mind',
      refund_method: 'cash', total_pence: 330, vat_pence: 0, occurred_at: new Date().toISOString(), approval: approval ?? null,
      lines: [{ id: uuidv7(), sale_line_id: sale.lines[0]!.id, product_id: milk, quantity: 2, amount_pence: 330, vat_code: 'Z', vat_pence: 0, restock: true }],
    });
    // Cashiers can't refund at all.
    const asCashier = { ...refund(), staff_id: shop.cashierId };
    expect((await push(sam, [], [asCashier])).body.refunds[0].error).toBe('forbidden');
    // Supervisor limit is £20, so £3.30 is fine.
    const ok = await push(sam, [], [refund()]);
    expect(ok.body.refunds[0].status).toBe('created');
    expect(await stockOf(milk)).toBe(before + 2);
    expect((await shop.owner.get(`/v1/sales/${sale.id}`)).body.status).toBe('partially_refunded');
    // Can't refund more than was bought.
    const tooMuch = refund();
    tooMuch.lines[0]!.quantity = 2;
    expect((await push(sam, [], [tooMuch])).body.refunds[0].status).toBe('rejected');
  });

  it('sends damaged returns straight to waste', async () => {
    const sale = buildSale(shop, shop.cashierId, [{ productId: cola, qty: 1, unitPrice: 125, pmpPrice: 125, barcode: '5000112637939' }]);
    await push(sam, [sale]);
    const before = await stockOf(cola);
    const r = await push(sam, [], [{
      id: uuidv7(), original_sale_id: sale.id, staff_id: shop.supervisorId, reason_code: 'faulty', refund_method: 'cash',
      total_pence: 125, vat_pence: 21, occurred_at: new Date().toISOString(),
      lines: [{ id: uuidv7(), sale_line_id: sale.lines[0]!.id, quantity: 1, amount_pence: 125, vat_code: 'S', vat_pence: 21, restock: false }],
    }]);
    expect(r.body.refunds[0].status).toBe('created');
    expect(await stockOf(cola)).toBe(before);
    expect((await shop.owner.get(`/v1/sales/${sale.id}`)).body.status).toBe('refunded');
  });

  it('requires approval for unreceipted refunds', async () => {
    const base = { id: uuidv7(), staff_id: shop.managerId, reason_code: 'no_receipt', refund_method: 'cash', total_pence: 165, vat_pence: 0,
      occurred_at: new Date().toISOString(),
      lines: [{ id: uuidv7(), product_id: milk, quantity: 1, amount_pence: 165, vat_code: 'Z', vat_pence: 0, restock: true }] };
    expect((await push(sam, [], [base])).body.refunds[0].status).toBe('rejected');
    const approvalId = uuidv7();
    const approved = { ...base, id: uuidv7(), approval: { id: approvalId, action_code: 'pos.refund_unreceipted', requested_by: shop.managerId,
      approved_by: shop.ownerId, outcome: 'approved', value: 165, occurred_at: new Date().toISOString() } };
    expect((await push(sam, [], [approved])).body.refunds[0].status).toBe('created');
  });

  it('voids a completed sale online and returns the stock', async () => {
    const sale = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 2, unitPrice: 165, vatCode: 'Z' }], { tillSessionId: sessionId });
    await push(sam, [sale]);
    const before = await stockOf(milk);
    expect((await sam.post(`/v1/sales/${sale.id}/void`, { reason: 'Wrong card' })).status).toBe(403);
    const mo = await shop.pinLogin(shop.managerId, '2222');
    const v = await mo.post(`/v1/sales/${sale.id}/void`, { reason: 'Wrong card' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('voided');
    expect(await stockOf(milk)).toBe(before + 2);
  });
});

describe('cash management', () => {
  it('needs approval for a cashier no-sale and limits paid-outs', async () => {
    await shop.owner.put(`/v1/staff/${shop.cashierId}/overrides`, { permissions: { 'pos.no_sale': true } });
    const sam2 = await shop.pinLogin(shop.cashierId, '1111');
    const ns = await sam2.post(`/v1/till-sessions/${sessionId}/cash-movements`, { movement_type: 'no_sale' });
    expect(ns.status).toBe(403);
    const approved = await sam2.post(`/v1/till-sessions/${sessionId}/cash-movements`, { movement_type: 'no_sale',
      approval: { approver_staff_id: shop.supervisorId, approver_pin: '3333' } });
    expect(approved.body).toMatchObject({ approved_by: shop.supervisorId });
    expect(approved.status).toBe(201);
    expect(approved.body.approved_by).toBe(shop.supervisorId);

    const mo = await shop.pinLogin(shop.managerId, '2222');
    const cats = await env.db.withTenant({ tenantId: shop.tenantId, staffId: null, userId: null, deviceId: null },
      (tx) => tx`SELECT id FROM expense_categories WHERE name = 'Cleaning'`);
    const po = await mo.post(`/v1/till-sessions/${sessionId}/cash-movements`, { movement_type: 'paid_out', amount_pence: 1200,
      reason: 'Window cleaner', expense: { category_id: cats[0]!.id, description: 'Window cleaner' } });
    expect(po.status).toBe(201);
    const big = await mo.post(`/v1/till-sessions/${sessionId}/cash-movements`, { movement_type: 'paid_out', amount_pence: 15000 });
    expect(big.status).toBe(403);
  });

  it('cashes up: expected cash, variance and a frozen Z report', async () => {
    const z = (await shop.owner.get(`/v1/till-sessions/${sessionId}/z-report`)).body;
    expect(z.sales.count).toBeGreaterThan(0);
    expect(z.voided_sales.count).toBe(1);
    expect(z.cash_movements.paid_out.amount_pence).toBe(1200);
    const expected = 10000 + (z.payments.cash ?? 0) - (z.refunds.by_method.cash ?? 0) - 1200;
    expect(z.expected_cash_pence).toBe(expected);
    expect(z.vat_by_code.Z.vat_pence).toBe(0);

    const mo = await shop.pinLogin(shop.managerId, '2222');
    const closed = await mo.post(`/v1/till-sessions/${sessionId}/close`, { counted_cash_pence: expected - 50 });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', variance_pence: -50, expected_cash_pence: expected });
    expect(closed.body.z_report.sales.count).toBe(z.sales.count);
    expect((await mo.post(`/v1/till-sessions/${sessionId}/close`, { counted_cash_pence: 0 })).status).toBe(409);
  });
});

describe('device pull', () => {
  it('gives the till everything it needs offline, incl. staff permissions', async () => {
    const pull = (await sam.get('/v1/sync/pull')).body;
    expect(pull.full).toBe(true);
    expect(pull.device.device_no).toBe(shop.deviceNo);
    expect(pull.products.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Milk 2L', 'Cola 500ml PMP']));
    expect(pull.barcodes.find((b: any) => b.barcode === '5000112637939')).toMatchObject({ is_pmp: true, pmp_price_pence: 125 });
    const samRow = pull.staff.find((s: any) => s.id === shop.cashierId);
    expect(samRow.permissions).toContain('pos.sell');
    expect(samRow.limits['pos.discount.max_percent']).toBe(5);
    expect(pull.staff[0].pos_pin_hash).toBeUndefined();
    const delta = (await sam.get(`/v1/sync/pull?since=${encodeURIComponent(pull.server_time)}`)).body;
    expect(delta.products).toEqual([]);
  });
});
