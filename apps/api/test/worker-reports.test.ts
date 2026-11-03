import { describe, expect, it } from 'vitest';
import { LogEmailAdapter, MockDeliveryAdapter } from '../src/integrations/adapters.ts';
import { backoffSeconds, publishOutbox, refreshDailySummaries, sendOutboundMessages } from '../src/worker/jobs.ts';
import { buildSale, mkProduct, newShop, useTestApp } from './helpers.ts';

const env = useTestApp();
const today = () => new Date().toISOString().slice(0, 10);

describe('outbox worker', () => {
  it('backs off exponentially, capped at an hour', () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(20)).toBe(3600);
  });

  it('marks a handler failure for retry and moves available_at forward', async () => {
    const shop = await newShop(env.app);
    const p = await mkProduct(shop.owner, { name: 'Stocked', price: 100 });
    const conn = await env.db.withTenant({ tenantId: shop.tenantId, staffId: shop.ownerId, userId: null, deviceId: null }, async (tx) => {
      const [c] = await tx`INSERT INTO integration_connections (tenant_id, branch_id, provider, status, external_store_id)
                           VALUES (${shop.tenantId}, ${shop.branchId}, 'uber_eats', 'active', 'store-1') RETURNING id`;
      await tx`INSERT INTO external_product_links (tenant_id, connection_id, product_id, external_item_id)
               VALUES (${shop.tenantId}, ${c!.id}, ${p}, 'ue-item-1')`;
      return c!.id as string;
    });
    // Drain earlier events for this shop first.
    await publishOutbox({ db: env.db });
    await shop.owner.post('/v1/stock/receipts', { branch_id: shop.branchId, lines: [{ product_id: p, quantity: 7 }] });

    const flaky = new MockDeliveryAdapter('uber_eats');
    flaky.pushStock = async () => { throw new Error('Uber Eats 503'); };
    const r1 = await publishOutbox({ db: env.db, delivery: new Map([['uber_eats', flaky]]) });
    expect(r1.failed).toBe(1);
    const [ev] = await env.db.asWorker((tx) => tx`
      SELECT attempts, last_error, available_at > now() AS delayed, published_at FROM outbox_events
      WHERE tenant_id = ${shop.tenantId} AND event_type = 'stock.changed' ORDER BY id DESC LIMIT 1`);
    expect(ev).toMatchObject({ attempts: 1, last_error: 'Uber Eats 503', delayed: true, published_at: null });

    // Later: platform is back up.
    await env.db.asWorker((tx) => tx`UPDATE outbox_events SET available_at = now() WHERE tenant_id = ${shop.tenantId} AND published_at IS NULL`);
    const good = new MockDeliveryAdapter('uber_eats');
    const r2 = await publishOutbox({ db: env.db, delivery: new Map([['uber_eats', good]]) });
    expect(r2.failed).toBe(0);
    expect(good.calls).toEqual([{ method: 'pushStock', args: [conn, [{ productId: p, externalItemId: 'ue-item-1', available: 7 }]] }]);
  });

  it('turns notify.* events into emails for owners and managers', async () => {
    const shop = await newShop(env.app);
    const sam = await shop.pinLogin(shop.cashierId, '1111');
    await sam.post('/v1/purchase-requests', { branch_id: shop.branchId, free_text: 'Out of 2L milk', priority: 'urgent' });
    await publishOutbox({ db: env.db });
    const email = new LogEmailAdapter();
    await sendOutboundMessages({ db: env.db, messages: new Map([['email', email]]) });
    const mine = email.sent.filter((m) => m.templateCode === 'purchase_request' && /owner-|mo-/.test(m.to));
    expect(mine.length).toBeGreaterThanOrEqual(2); // owner + manager of this shop
    const [row] = await env.db.asWorker((tx) => tx`
      SELECT count(*)::int AS n FROM outbound_messages WHERE tenant_id = ${shop.tenantId} AND status = 'sent'`);
    expect(row!.n).toBe(2);
  });
});

describe('daily summaries and reports', () => {
  it('aggregates sales (minus training), payments, COGS and waste per day', async () => {
    const shop = await newShop(env.app);
    const milk = await mkProduct(shop.owner, { name: 'Milk', price: 165, vat: 'Z' });
    const beer = await mkProduct(shop.owner, { name: 'Ale', price: 300 });
    await shop.owner.post('/v1/stock/receipts', { branch_id: shop.branchId, lines: [
      { product_id: milk, quantity: 20, unit_cost_pence: 100 }, { product_id: beer, quantity: 5, unit_cost_pence: 150 }] });
    await shop.owner.post('/v1/stock/waste', { branch_id: shop.branchId, product_id: milk, quantity: 1, reason_code: 'expired' });
    const sam = await shop.pinLogin(shop.cashierId, '1111');
    const s1 = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 2, unitPrice: 165, vatCode: 'Z' }]);
    const s2 = buildSale(shop, shop.cashierId, [{ productId: beer, qty: 5, unitPrice: 300 }], { method: 'card' });
    const train = buildSale(shop, shop.cashierId, [{ productId: milk, qty: 9, unitPrice: 165, vatCode: 'Z' }], { isTraining: true });
    const r = await sam.post('/v1/sync/push', { sales: [s1, s2, train] });
    expect(r.body.sales.map((x: any) => x.status)).toEqual(['created', 'created', 'created']);

    await refreshDailySummaries(env.db, { tenantId: shop.tenantId, date: today() });
    const daily = (await shop.owner.get(`/v1/reports/daily?branch_id=${shop.branchId}&from=${today()}&to=${today()}`)).body;
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({
      transactions: 2, gross_sales_pence: 1830, vat_pence: 250, net_sales_pence: 1580, cash_pence: 330, card_pence: 1500,
      cost_of_goods_pence: 200 + 750, waste_cost_pence: 100, avg_basket_pence: 915, gross_margin_pence: 1580 - 950,
    });

    const top = (await shop.owner.get(`/v1/reports/top-products?branch_id=${shop.branchId}&from=${today()}&to=${today()}`)).body;
    expect(top.map((t: any) => [t.name, t.qty_sold, t.had_stockout])).toEqual([['Ale', 5, true], ['Milk', 2, false]]);

    // A cashier can't see reports.
    expect((await sam.get(`/v1/reports/daily?branch_id=${shop.branchId}&from=${today()}&to=${today()}`)).status).toBe(403);
    // A manager sees sales but not margins/costs unless they hold reports.financial.
    await shop.owner.put(`/v1/staff/${shop.managerId}/overrides`, { permissions: { 'reports.financial': false } });
    const mo = await shop.pinLogin(shop.managerId, '2222');
    const moDaily = (await mo.get(`/v1/reports/daily?branch_id=${shop.branchId}&from=${today()}&to=${today()}`)).body;
    expect(moDaily[0].cost_of_goods_pence).toBeUndefined();
  });

  it('prepares an MTD 9-box VAT draft', async () => {
    const shop = await newShop(env.app);
    const choc = await mkProduct(shop.owner, { name: 'Chocolate', price: 120 });
    const sam = await shop.pinLogin(shop.cashierId, '1111');
    await sam.post('/v1/sync/push', { sales: [buildSale(shop, shop.cashierId, [{ productId: choc, qty: 10, unitPrice: 120 }])] });
    const ctx = { tenantId: shop.tenantId, staffId: shop.ownerId, userId: null, deviceId: null };
    await env.db.withTenant(ctx, (tx) => tx`
      INSERT INTO expenses (tenant_id, category_id, description, net_pence, vat_pence, total_pence, incurred_on)
      SELECT ${shop.tenantId}, id, 'Electric', 5000, 250, 5250, CURRENT_DATE FROM expense_categories WHERE name = 'Utilities'`);
    const from = today().slice(0, 8) + '01';
    const r = await shop.owner.post('/v1/vat-returns', { period_start: from, period_end: today() > from ? today() : '2099-01-01' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'draft', box1_vat_due_sales_pence: 200, box4_vat_reclaimed_pence: 250, box5_net_vat_pence: 50,
      box6_total_sales_ex_vat_pence: 1000, box7_total_purchases_ex_vat_pence: 5000, direction: 'repayable' });
    const mo = await shop.pinLogin(shop.managerId, '2222');
    expect((await mo.post('/v1/vat-returns', { period_start: from, period_end: '2099-01-01' })).status).toBe(403);
  });
});
