/**
 * In-page demo backend for the Counter preview. It replaces `fetch` for the
 * two real apps (till + back office) and answers like the API, starting from
 * responses captured from a seeded demo shop (demo/capture.ts). State lives
 * in memory only: reload the page and the shop resets. Not used in production.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { productNameFromInvoice, uuidv7 } from '@retail/shared';
import { pagesFromFile, readInvoice, ReadError, similarity } from './ocr';

export const DEMO_API = 'https://demo.counter.invalid';
declare global {
  interface Window { __DEMO_DATA__: any; __demo: DemoControl; }
}
export interface DemoControl { offline: boolean; setOffline(v: boolean): void; onChange(cb: () => void): void; signedIn: boolean }

// ------------------------------------------------------------------ dates
const ukDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
const DAY = 86400000;
function shiftDates(data: any): any {
  const shiftDays = Math.round((Date.parse(ukDay(new Date())) - Date.parse(data.captured_on)) / DAY);
  if (!shiftDays) return data;
  const ms = shiftDays * DAY;
  const json = JSON.stringify(data);
  return JSON.parse(json, (_k, v) => {
    if (typeof v !== 'string') return v;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return new Date(Date.parse(v) + ms).toISOString();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(Date.parse(`${v}T12:00:00Z`) + ms).toISOString().slice(0, 10);
    return v;
  });
}

// ------------------------------------------------------------------ state
const S: any = shiftDates(window.__DEMO_DATA__);
const pinsById: Record<string, string> = {};
for (const s of S.hello.staff) if (S.pins[s.display_name]) pinsById[s.id] = S.pins[s.display_name];
const staffById = () => new Map<string, any>(S.pull.staff.map((s: any) => [s.id, s]));
const productName = (id: string | null) => (id ? S.productDetails[id]?.name ?? null : null);
const supplierName = (id: string | null) => S.suppliers.find((s: any) => s.id === id)?.name ?? null;
const ownerId = S.me.staff.id as string;
const branchId = S.me.branches[0].id as string;
const tillId = S.hello.till?.id as string;
const cash: Record<string, any[]> = {};
const refunds: any[] = [];
const changedAt: Record<string, number> = {};
const listeners: (() => void)[] = [];
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ helpers
type Q = URLSearchParams;
interface Ctx { method: string; path: string; q: Q; body: any; staffId: string; params: Record<string, string> }
class HttpErr extends Error { constructor(public status: number, public code: string, message: string, public details?: any) { super(message); } }
const fail = (status: number, message: string, details?: any, code = 'unprocessable') => { throw new HttpErr(status, code, message, details); };

function stockRow(pid: string) { return S.stock.find((r: any) => r.product_id === pid); }
function stockAdd(pid: string, qty: number, type: string, opts: { reason_code?: string | null; reason?: string | null; cost?: number | null; staffId?: string } = {}) {
  const row = stockRow(pid);
  if (row) { row.on_hand = Math.round((row.on_hand + qty) * 1000) / 1000; row.available = row.on_hand - (row.reserved ?? 0); }
  const det = S.productDetails[pid];
  if (det?.stock?.[0]) { det.stock[0].on_hand = row?.on_hand ?? det.stock[0].on_hand + qty; det.stock[0].available = det.stock[0].on_hand - (det.stock[0].reserved ?? 0); }
  S.movements.unshift({ id: uuidv7(), branch_id: branchId, product_id: pid, quantity: qty, movement_type: type, reason_code: opts.reason_code ?? null,
    reason: opts.reason ?? null, unit_cost_pence: opts.cost ?? det?.avg_cost_pence ?? null, occurred_at: now(), created_at: now() });
}
function lowStock() {
  return S.stock.filter((r: any) => r.reorder_point !== null && r.on_hand <= r.reorder_point)
    .map((r: any) => ({ tenant_id: S.me.tenant.id, branch_id: branchId, product_id: r.product_id, name: r.name, quantity: r.on_hand, reorder_point: r.reorder_point, reorder_qty: r.reorder_qty }));
}
function openSession() { return S.tillSessions.find((s: any) => s.till_id === tillId && s.status === 'open'); }
function lastSeq() {
  return S.sales.reduce((m: number, s: any) => Math.max(m, Number(String(s.receipt_number).split('-')[2]) || 0), 0);
}

function computeZ(sessionId: string) {
  const session = S.tillSessions.find((s: any) => s.id === sessionId);
  const ids = S.sales.filter((s: any) => s.till_session_id === sessionId && !s.is_training).map((s: any) => s.id);
  const z: any = { till_session_id: sessionId, generated_at: now(), opening_float_pence: session?.opening_float_pence ?? 0,
    sales: { count: 0, gross_pence: 0, discounts_pence: 0, net_pence: 0, vat_pence: 0, items: 0 }, voided_sales: { count: 0, value_pence: 0 },
    voided_lines: { count: 0, value_pence: 0 }, payments: {}, refunds: { count: 0, total_pence: 0, by_method: {} }, cash_movements: {}, vat_by_code: {} };
  for (const id of ids) {
    const d = S.saleDetails[id];
    if (!d) continue;
    for (const l of d.lines) if (l.is_voided) { z.voided_lines.count++; z.voided_lines.value_pence += l.line_total_pence; }
    if (d.status === 'voided') { z.voided_sales.count++; z.voided_sales.value_pence += d.total_pence; continue; }
    z.sales.count++; z.sales.gross_pence += d.subtotal_pence; z.sales.discounts_pence += d.discount_pence; z.sales.net_pence += d.total_pence;
    z.sales.vat_pence += d.vat_pence; z.sales.items += Number(d.item_count ?? 0);
    for (const p of d.payments) if (p.status === 'approved') z.payments[p.method] = (z.payments[p.method] ?? 0) + p.amount_pence;
    for (const l of d.lines) if (!l.is_voided) {
      const v = (z.vat_by_code[l.vat_code] ??= { gross_pence: 0, vat_pence: 0, net_pence: 0 });
      v.gross_pence += l.line_total_pence; v.vat_pence += l.vat_pence; v.net_pence = v.gross_pence - v.vat_pence;
    }
  }
  for (const r of refunds.filter((r) => r.till_session_id === sessionId)) {
    z.refunds.count++; z.refunds.total_pence += r.total_pence; z.refunds.by_method[r.refund_method] = (z.refunds.by_method[r.refund_method] ?? 0) + r.total_pence;
  }
  for (const m of cash[sessionId] ?? []) {
    const c = (z.cash_movements[m.movement_type] ??= { count: 0, amount_pence: 0 }); c.count++; c.amount_pence += m.amount_pence;
  }
  const amt = (k: string) => z.cash_movements[k]?.amount_pence ?? 0;
  z.expected_cash_pence = z.opening_float_pence + (z.payments.cash ?? 0) - (z.refunds.by_method.cash ?? 0) + amt('paid_in') + amt('float_adjust') - amt('paid_out') - amt('cash_drop');
  return z;
}

function checkApprover(approverId: string, pin: string, requesterId: string) {
  if (approverId === requesterId) fail(403, 'You cannot approve your own action', undefined, 'forbidden');
  if (pinsById[approverId] !== pin) fail(403, 'Approval PIN is incorrect', undefined, 'forbidden');
  const a = staffById().get(approverId);
  if (!a?.permissions?.includes('pos.approve')) fail(403, 'That person cannot approve actions', undefined, 'forbidden');
  return a;
}

function recordSale(p: any): 'created' | 'duplicate' {
  if (S.saleDetails[p.id]) return 'duplicate';
  const live = p.lines.filter((l: any) => !l.is_voided);
  const total = live.reduce((a: number, l: any) => a + l.line_total_pence, 0);
  if (total !== p.total_pence) fail(422, 'Sale totals do not match its lines');
  const paid = p.payments.filter((x: any) => x.status === 'approved').reduce((a: number, x: any) => a + x.amount_pence, 0);
  if (p.status === 'completed' && paid !== p.total_pence) fail(422, `Payments (${paid}p) must equal the total (${p.total_pence}p)`);
  const items = live.reduce((a: number, l: any) => a + l.quantity, 0);
  const row = { id: p.id, receipt_number: p.receipt_number, status: p.status, channel: 'pos', staff_id: p.staff_id, customer_id: null,
    total_pence: p.total_pence, vat_pence: p.vat_pence, discount_pence: p.discount_pence, item_count: items, is_training: p.is_training,
    completed_at: p.completed_at ?? p.voided_at, till_session_id: p.till_session_id };
  S.sales.push(row);
  S.saleDetails[p.id] = { ...p, branch_id: branchId, item_count: items, created_at: now(), refunds: [] };
  if (p.status === 'completed' && !p.is_training) {
    for (const l of live) if (l.product_id) stockAdd(l.product_id, -l.quantity, 'sale', { staffId: p.staff_id });
    const today = ukDay(new Date());
    let d = S.daily.find((r: any) => r.business_date === today);
    if (!d) { d = { business_date: today, branch_id: branchId, transactions: 0, net_sales_pence: 0, vat_pence: 0, gross_sales_pence: 0, discounts_pence: 0,
      refunds_pence: 0, cost_of_goods_pence: 0, waste_cost_pence: 0, cash_pence: 0, card_pence: 0, online_pence: 0, avg_basket_pence: 0, gross_margin_pence: 0 }; S.daily.push(d); }
    d.transactions++; d.net_sales_pence += p.total_pence - p.vat_pence; d.vat_pence += p.vat_pence; d.gross_sales_pence += p.subtotal_pence;
    d.discounts_pence += p.discount_pence;
    const cost = live.reduce((a: number, l: any) => a + Math.round(l.quantity * (l.unit_cost_pence ?? S.productDetails[l.product_id]?.avg_cost_pence ?? 0)), 0);
    d.cost_of_goods_pence += cost; d.gross_margin_pence = d.net_sales_pence - d.cost_of_goods_pence;
    for (const x of p.payments) if (x.status === 'approved') { if (x.method === 'cash') d.cash_pence += x.amount_pence; if (x.method === 'card') d.card_pence += x.amount_pence; }
    d.avg_basket_pence = Math.round((d.net_sales_pence + d.vat_pence) / d.transactions); d.computed_at = now();
  }
  return 'created';
}

function recordRefund(r: any): 'created' | 'duplicate' {
  if (refunds.some((x) => x.id === r.id)) return 'duplicate';
  const sale = r.original_sale_id ? S.saleDetails[r.original_sale_id] : null;
  if (r.original_sale_id && !sale) fail(422, 'Original sale not found');
  const requester = staffById().get(r.staff_id);
  if (!requester?.permissions?.includes('pos.refund')) fail(403, 'This member of staff cannot give refunds', undefined, 'forbidden');
  refunds.push({ ...r, branch_id: branchId });
  for (const l of r.lines) {
    const pid = l.product_id ?? sale?.lines.find((x: any) => x.id === l.sale_line_id)?.product_id;
    if (pid) { stockAdd(pid, l.quantity, 'refund'); if (!l.restock) stockAdd(pid, -l.quantity, 'waste', { reason_code: 'damaged' }); }
  }
  if (sale) {
    sale.refunds.push({ ...r, lines: r.lines });
    const refunded = new Map<string, number>();
    for (const rf of sale.refunds) for (const l of rf.lines) refunded.set(l.sale_line_id, (refunded.get(l.sale_line_id) ?? 0) + l.quantity);
    const full = sale.lines.filter((l: any) => !l.is_voided).every((l: any) => (refunded.get(l.id) ?? 0) >= l.quantity);
    sale.status = full ? 'refunded' : 'partially_refunded';
    const row = S.sales.find((s: any) => s.id === sale.id); if (row) row.status = sale.status;
  }
  const d = S.daily.find((x: any) => x.business_date === ukDay(new Date())); if (d) d.refunds_pence += r.total_pence;
  return 'created';
}

// ------------------------------------------------------------------ routes
type Handler = (c: Ctx) => any;
const routes: [string, RegExp, string[], Handler][] = [];
function on(method: string, pattern: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push([method, re, keys, h]);
}
const created = (body: any) => ({ __status: 201, body });

on('GET', '/health', () => ({ ok: true }));
on('GET', '/v1/me', () => S.me);

// ---- till device + login + sync
on('POST', '/v1/devices/hello', () => {
  const s = openSession();
  return { ...S.hello, till: S.hello.till ? { ...S.hello.till, open_session_id: s?.id ?? null } : null,
    staff: S.hello.staff, device: { ...S.hello.device, last_receipt_seq: lastSeq() } };
});
on('POST', '/v1/auth/pin-login', (c) => {
  if (!pinsById[c.body.staff_id] || pinsById[c.body.staff_id] !== c.body.pin) fail(401, 'PIN is incorrect', undefined, 'unauthorized');
  return { token: `demo.${c.body.staff_id}`, tenant_id: S.me.tenant.id, branch_id: branchId, staff_id: c.body.staff_id };
});
on('GET', '/v1/sync/pull', (c) => {
  const since = c.q.get('since') ? Date.parse(c.q.get('since')!) : null;
  const s = openSession();
  const base = { ...S.pull, server_time: now(), full: !since, tills: S.pull.tills.map((t: any) => ({ ...t, open_session_id: t.id === tillId ? s?.id ?? null : t.open_session_id })) };
  if (!since) return base;
  const ids = new Set(Object.entries(changedAt).filter(([, t]) => t > since).map(([id]) => id));
  return { ...base, products: S.pull.products.filter((p: any) => ids.has(p.id)), barcodes: S.pull.barcodes.filter((b: any) => ids.has(b.product_id)),
    prices: S.pull.prices.filter((p: any) => ids.has(p.product_id)) };
});
on('POST', '/v1/sync/push', (c) => {
  const run = (items: any[], fn: (x: any) => 'created' | 'duplicate') => items.map((x) => {
    try { return { id: x.id, status: fn(x) }; } catch (e) { const he = e as HttpErr; return { id: x.id, status: 'rejected', error: he.code ?? 'error', message: he.message, details: he.details }; }
  });
  const out = { sales: run(c.body.sales ?? [], recordSale), refunds: run(c.body.refunds ?? [], recordRefund) };
  listeners.forEach((l) => l());
  return out;
});
on('POST', '/v1/pos/verify-approval', (c) => {
  const a = checkApprover(c.body.approver_staff_id, c.body.approver_pin, c.staffId);
  return { approved_by: a.id, display_name: a.display_name, outcome: 'approved' };
});
on('GET', '/v1/expense-categories', () => S.expenseCategories);
on('GET', '/v1/branches/:id/staff-tiles', () => S.staffTiles);

// ---- till sessions
on('GET', '/v1/till-sessions', () => S.tillSessions.map((s: any) => (s.status === 'open' ? s : { ...s })));
on('GET', '/v1/till-sessions/:id', (c) => S.tillSessions.find((s: any) => s.id === c.params.id) ?? fail(404, 'Till session not found'));
on('POST', '/v1/till-sessions', (c) => {
  const existing = c.body.id && S.tillSessions.find((s: any) => s.id === c.body.id);
  if (existing) return existing;
  const open = S.tillSessions.find((s: any) => s.till_id === c.body.till_id && s.status === 'open');
  if (open) fail(409, 'This till is already open', { till_session_id: open.id }, 'conflict');
  const who = staffById().get(c.staffId);
  const s = { id: c.body.id ?? uuidv7(), till_id: c.body.till_id, till_name: S.hello.till?.name ?? 'Till', branch_id: branchId, status: 'open',
    opened_by: c.staffId, opened_by_name: who?.display_name ?? 'Staff', opened_at: now(), opening_float_pence: c.body.opening_float_pence ?? 0,
    closed_at: null, closed_by_name: null, expected_cash_pence: null, counted_cash_pence: null, variance_pence: null, net_sales_pence: null };
  S.tillSessions.unshift(s);
  return created(s);
});
on('POST', '/v1/till-sessions/:id/cash-movements', (c) => {
  const who = staffById().get(c.staffId);
  const type = c.body.movement_type;
  const perm = type === 'no_sale' ? 'pos.no_sale' : type === 'paid_out' ? 'pos.paid_out' : null;
  let approvedBy: string | null = null;
  if (perm && !who?.permissions?.includes(perm)) fail(403, `Missing permission: ${perm}`, { missing: [perm] }, 'forbidden');
  const isOwner = who?.role_key === 'owner';
  if (perm && !isOwner) {
    const limit = who?.limits?.[type === 'no_sale' ? 'pos.no_sale.max_per_shift' : 'pos.paid_out.max_amount_pence'];
    const value = type === 'no_sale' ? (cash[c.params.id] ?? []).filter((m) => m.movement_type === 'no_sale' && m.staff_id === c.staffId).length + 1 : c.body.amount_pence;
    if (limit === undefined || value > limit) {
      if (!c.body.approval) fail(403, 'Over your limit: a manager must approve this action', { needs_approval: true }, 'forbidden');
      approvedBy = checkApprover(c.body.approval.approver_staff_id, c.body.approval.approver_pin, c.staffId).id;
    }
  }
  const m = { id: uuidv7(), till_session_id: c.params.id, movement_type: type, amount_pence: c.body.amount_pence ?? 0, reason: c.body.reason ?? null,
    staff_id: c.staffId, approved_by: approvedBy, occurred_at: now() };
  (cash[c.params.id] ??= []).push(m);
  return created(m);
});
on('GET', '/v1/till-sessions/:id/z-report', (c) => S.tillSessions.find((s: any) => s.id === c.params.id)?.z_report ?? computeZ(c.params.id));
on('POST', '/v1/till-sessions/:id/close', (c) => {
  const s = S.tillSessions.find((x: any) => x.id === c.params.id);
  if (!s) fail(404, 'Till session not found');
  if (s.status !== 'open') fail(409, 'Till session is already closed', undefined, 'conflict');
  const z = computeZ(s.id);
  Object.assign(s, { status: 'closed', closed_at: now(), closed_by_name: staffById().get(c.staffId)?.display_name ?? 'Staff',
    expected_cash_pence: z.expected_cash_pence, counted_cash_pence: c.body.counted_cash_pence,
    variance_pence: c.body.counted_cash_pence - z.expected_cash_pence, z_report: z, net_sales_pence: z.sales.net_pence });
  return s;
});

// ---- sales
on('GET', '/v1/sales', (c) => {
  const rn = c.q.get('receipt_number'), from = c.q.get('from'), to = c.q.get('to');
  const limit = Number(c.q.get('limit') ?? 100);
  return S.sales.filter((s: any) => {
    if (rn) return s.receipt_number === rn;
    const d = ukDay(new Date(s.completed_at));
    return (!from || d >= from) && (!to || d <= to);
  }).sort((a: any, b: any) => (a.completed_at < b.completed_at ? 1 : -1)).slice(0, limit);
});
on('GET', '/v1/sales/:id', (c) => S.saleDetails[c.params.id] ?? fail(404, 'Sale not found', undefined, 'not_found'));
on('POST', '/v1/sales/:id/void', (c) => {
  const d = S.saleDetails[c.params.id]; if (!d) fail(404, 'Sale not found');
  d.status = 'voided'; d.voided_at = now(); d.void_reason = c.body.reason;
  for (const l of d.lines) if (!l.is_voided && l.product_id) stockAdd(l.product_id, l.quantity, 'adjustment', { reason_code: 'other', reason: 'Sale voided' });
  const row = S.sales.find((s: any) => s.id === d.id); if (row) row.status = 'voided';
  return { id: d.id, status: 'voided', voided_at: d.voided_at, void_reason: d.void_reason };
});

// ---- catalogue
on('GET', '/v1/categories', () => S.categories);
on('POST', '/v1/categories', (c) => { const x = { id: uuidv7(), ...c.body }; S.categories.push(x); return created(x); });
on('GET', '/v1/price-levels', () => S.priceLevels);
on('GET', '/v1/products', (c) => {
  const q = (c.q.get('q') ?? '').trim().toLowerCase(), cat = c.q.get('category_id');
  const rows = S.products.filter((p: any) => (c.q.get('include_archived') === 'true' || !p.archived_at) && (!cat || p.category_id === cat)
    && (!q || p.name.toLowerCase().includes(q) || p.sku === q || p.barcode === q
      || (S.productDetails[p.id]?.barcodes ?? []).some((b: any) => b.barcode === q)));
  return rows.slice(0, Number(c.q.get('limit') ?? 50));
});
on('GET', '/v1/products/:id', (c) => S.productDetails[c.params.id] ?? fail(404, 'Product not found', undefined, 'not_found'));
on('GET', '/v1/products/:id/prices', (c) => S.priceHistory[c.params.id] ?? []);
on('POST', '/v1/products', (c) => {
  const id = uuidv7();
  const { barcodes = [], price_pence, ...f } = c.body;
  const det = { id, ...f, is_active: true, archived_at: null, avg_cost_pence: null, last_cost_pence: null, vat_code: f.vat_code ?? 'S',
    barcodes: barcodes.map((b: any) => ({ id: uuidv7(), ...b, units_per_scan: b.units_per_scan ?? 1 })),
    current_prices: price_pence !== undefined ? [{ id: uuidv7(), price_level_id: S.priceLevels[0].id, price_level_code: 'retail', branch_id: null, min_qty: 1, price_pence, valid_from: now() }] : [],
    stock: [{ branch_id: branchId, on_hand: 0, reserved: 0, available: 0 }] };
  S.productDetails[id] = det;
  S.priceHistory[id] = det.current_prices.map((p: any) => ({ ...p, product_id: id }));
  S.products.push({ ...det, retail_price_pence: price_pence ?? null, barcode: barcodes[0]?.barcode ?? null });
  S.products.sort((a: any, b: any) => a.name.localeCompare(b.name));
  S.stock.push({ product_id: id, name: det.name, on_hand: 0, reserved: 0, available: 0, reorder_point: f.reorder_point ?? null, reorder_qty: f.reorder_qty ?? null });
  return created(det);
});
on('PATCH', '/v1/products/:id', (c) => {
  const det = S.productDetails[c.params.id]; if (!det) fail(404, 'Product not found');
  const { archived, ...f } = c.body;
  Object.assign(det, f); if (archived !== undefined) det.archived_at = archived ? now() : null;
  const row = S.products.find((p: any) => p.id === det.id); if (row) Object.assign(row, f, { archived_at: det.archived_at });
  changedAt[det.id] = Date.now();
  return det;
});
on('POST', '/v1/products/:id/prices', (c) => {
  const det = S.productDetails[c.params.id]; if (!det) fail(404, 'Product not found');
  const level = S.priceLevels.find((l: any) => l.id === c.body.price_level_id) ?? S.priceLevels.find((l: any) => l.is_default);
  const row = { id: uuidv7(), product_id: det.id, price_level_id: level.id, price_level_code: level.code, branch_id: c.body.branch_id ?? null,
    min_qty: c.body.min_qty ?? 1, price_pence: c.body.price_pence, valid_from: c.body.valid_from ?? now(), valid_to: null, created_at: now() };
  (S.priceHistory[det.id] ??= []).unshift(row);
  det.current_prices = [...det.current_prices.filter((p: any) => !(p.price_level_id === row.price_level_id && p.branch_id === row.branch_id && p.min_qty === row.min_qty)), row];
  if (level.is_default && !row.branch_id && row.min_qty === 1) { const l = S.products.find((p: any) => p.id === det.id); if (l) l.retail_price_pence = row.price_pence; }
  S.pull.prices.push({ product_id: det.id, price_level_id: row.price_level_id, branch_id: row.branch_id, min_qty: row.min_qty, price_pence: row.price_pence, valid_from: row.valid_from, valid_to: null });
  changedAt[det.id] = Date.now();
  return created(row);
});
on('POST', '/v1/products/:id/barcodes', (c) => {
  const det = S.productDetails[c.params.id]; const b = { id: uuidv7(), product_id: c.params.id, ...c.body };
  det.barcodes.push(b); S.pull.barcodes.push(b); changedAt[c.params.id] = Date.now(); return created(b);
});
on('DELETE', '/v1/products/:id/barcodes/:bid', (c) => {
  const det = S.productDetails[c.params.id]; det.barcodes = det.barcodes.filter((b: any) => b.id !== c.params.bid); return { __status: 204 };
});

// ---- stock
on('GET', '/v1/stock', (c) => {
  const q = (c.q.get('q') ?? '').toLowerCase();
  return S.stock.filter((r: any) => (!q || r.name.toLowerCase().includes(q))
    && (c.q.get('only_low') !== 'true' || (r.reorder_point !== null && r.on_hand <= r.reorder_point)));
});
on('GET', '/v1/stock/low', () => lowStock());
on('GET', '/v1/stock/expiring', () => S.expiring);
on('GET', '/v1/stock/movements', () => S.movements.slice(0, 200));
on('POST', '/v1/stock/receipts', (c) => {
  for (const l of c.body.lines) stockAdd(l.product_id, l.quantity, c.body.opening ? 'opening' : 'receipt', { cost: l.unit_cost_pence });
  return created({ ok: true, lines: c.body.lines.length });
});
on('POST', '/v1/stock/adjustments', (c) => {
  stockAdd(c.body.product_id, c.body.quantity, 'adjustment', { reason_code: c.body.reason_code, reason: c.body.reason });
  return created({ on_hand: stockRow(c.body.product_id)?.on_hand ?? 0, approval: { outcome: 'self_authorised' } });
});
on('POST', '/v1/stock/waste', (c) => {
  stockAdd(c.body.product_id, -c.body.quantity, 'waste', { reason_code: c.body.reason_code, reason: c.body.reason });
  if (c.body.batch_id) { const b = S.expiring.find((e: any) => e.batch_id === c.body.batch_id); if (b) { b.qty_remaining = Math.max(b.qty_remaining - c.body.quantity, 0); if (!b.qty_remaining) S.expiring = S.expiring.filter((e: any) => e !== b); } }
  return created({ ok: true, cost_pence: Math.round((S.productDetails[c.body.product_id]?.avg_cost_pence ?? 0) * c.body.quantity) });
});

// ---- purchasing
on('GET', '/v1/suppliers', () => S.suppliers);
on('GET', '/v1/suppliers/:id/products', (c) => S.supplierProducts?.[c.params.id] ?? []);
on('POST', '/v1/suppliers', (c) => { const s = { id: uuidv7(), is_active: true, order_days: null, ...c.body }; S.suppliers.push(s); return created(s); });
on('GET', '/v1/purchase-requests', (c) => S.requests.filter((r: any) => !c.q.get('status') || r.status === c.q.get('status')));
on('POST', '/v1/purchase-requests', (c) => {
  const who = staffById().get(c.staffId);
  const r = { id: uuidv7(), branch_id: branchId, product_id: c.body.product_id ?? null, product_name: productName(c.body.product_id ?? null),
    free_text: c.body.free_text ?? null, quantity: c.body.quantity ?? null, priority: c.body.priority ?? 'normal', note: c.body.note ?? null,
    requested_by: c.staffId, requested_by_name: who?.display_name ?? S.me.staff.display_name, status: 'pending', created_at: now() };
  S.requests.unshift(r); listeners.forEach((l) => l()); return created(r);
});
on('POST', '/v1/purchase-requests/:id/review', (c) => {
  const r = S.requests.find((x: any) => x.id === c.params.id); if (!r) fail(404, 'Request not found');
  if (r.status !== 'pending') fail(409, `Request is already ${r.status}`, undefined, 'conflict');
  r.status = c.body.decision === 'approve' ? 'approved' : 'rejected';
  if (r.status === 'approved') S.purchaseList.items.push({ id: uuidv7(), product_id: r.product_id, product_name: r.product_name, free_text: r.free_text,
    supplier_id: null, supplier_name: null, quantity: c.body.quantity ?? r.quantity ?? 1, unit: 'each', source: 'staff_request', status: 'approved', estimated_unit_cost_pence: null });
  return r;
});
on('GET', '/v1/purchase-list', () => S.purchaseList);
on('POST', '/v1/purchase-list/items', (c) => {
  const i = { id: uuidv7(), product_id: c.body.product_id ?? null, product_name: productName(c.body.product_id ?? null), free_text: c.body.free_text ?? null,
    supplier_id: c.body.supplier_id ?? null, supplier_name: supplierName(c.body.supplier_id ?? null), quantity: c.body.quantity, unit: c.body.unit ?? 'each',
    source: 'manual', status: 'approved', estimated_unit_cost_pence: S.productDetails[c.body.product_id]?.last_cost_pence ?? null };
  S.purchaseList.items.push(i); return created(i);
});
on('PATCH', '/v1/purchase-list/items/:id', (c) => {
  const i = S.purchaseList.items.find((x: any) => x.id === c.params.id); if (!i) fail(404, 'List item not found');
  Object.assign(i, c.body); if ('supplier_id' in c.body) i.supplier_name = supplierName(c.body.supplier_id); return i;
});
on('POST', '/v1/purchase-list/generate', () => {
  const have = new Set(S.purchaseList.items.filter((i: any) => ['pending', 'approved'].includes(i.status)).map((i: any) => i.product_id));
  const added = lowStock().filter((l: any) => !have.has(l.product_id)).map((l: any) => ({ id: uuidv7(), product_id: l.product_id, product_name: l.name,
    free_text: null, supplier_id: S.suppliers[0]?.id ?? null, supplier_name: S.suppliers[0]?.name ?? null, quantity: l.reorder_qty ?? l.reorder_point * 2,
    unit: 'each', source: 'reorder_point', ai_reason: `${l.quantity} left, reorder point is ${l.reorder_point}`, status: 'pending',
    estimated_unit_cost_pence: S.productDetails[l.product_id]?.last_cost_pence ?? null }));
  S.purchaseList.items.push(...added); return { purchase_list_id: S.purchaseList.id, added };
});
on('POST', '/v1/purchase-orders/from-list', () => {
  const ready = S.purchaseList.items.filter((i: any) => i.status === 'approved' && i.supplier_id && i.product_id);
  if (!ready.length) fail(422, 'No approved items with a supplier on the shopping list');
  const by = new Map<string, any[]>(); for (const i of ready) by.set(i.supplier_id, [...(by.get(i.supplier_id) ?? []), i]);
  const orders = [...by.entries()].map(([sid, items]) => {
    const id = uuidv7();
    const lines = items.map((i: any) => ({ id: uuidv7(), product_id: i.product_id, unit: 'each', qty_ordered: i.quantity, qty_received: 0, unit_cost_pence: i.estimated_unit_cost_pence }));
    items.forEach((i: any) => { i.status = 'ordered'; i.purchase_order_id = id; });
    return { id, po_number: `PO-MAN1-${ukDay(new Date()).replace(/-/g, '')}-${id.slice(-5).toUpperCase()}`, supplier_id: sid, supplier_name: supplierName(sid),
      status: 'draft', created_at: now(), sent_at: null, sent_via: null, lines,
      estimated_total_pence: lines.reduce((a: number, l: any) => a + (l.unit_cost_pence ?? 0) * l.qty_ordered, 0) };
  });
  S.purchaseOrders.unshift(...orders); return created(orders);
});
on('GET', '/v1/purchase-orders', () => S.purchaseOrders);
on('POST', '/v1/purchase-orders/:id/send', (c) => {
  const po = S.purchaseOrders.find((p: any) => p.id === c.params.id); if (!po) fail(404, 'Purchase order not found');
  const sup = S.suppliers.find((s: any) => s.id === po.supplier_id);
  Object.assign(po, { status: 'sent', sent_at: now(), sent_via: sup?.order_method ?? 'email' }); return po;
});

// ---- invoices
function invoiceRow(d: any) { return { id: d.id, status: d.status, invoice_number: d.invoice_number, invoice_date: d.invoice_date, total_pence: d.total_pence,
  ocr_confidence: d.ocr_confidence, ocr_error: d.ocr_error, created_at: d.created_at, supplier_name: d.supplier_name }; }
function syncInvoiceRow(d: any) { S.invoices = S.invoices.map((r: any) => (r.id === d.id ? invoiceRow(d) : r)); }
on('GET', '/v1/invoices', (c) => S.invoices.filter((i: any) => !c.q.get('status') || i.status === c.q.get('status')));
on('GET', '/v1/invoices/:id', (c) => S.invoiceDetails[c.params.id] ?? fail(404, 'Invoice not found', undefined, 'not_found'));
const dataUrlToB64 = (s: string) => s.replace(/^data:[^,]*,/, '');
const defaultLevel = () => S.priceLevels.find((p: any) => p.is_default) ?? S.priceLevels[0];
function findByBarcode(code: string): string | null {
  for (const [pid, det] of Object.entries<any>(S.productDetails)) if ((det.barcodes ?? []).some((b: any) => b.barcode === code)) return pid;
  return null;
}
function supplierCodeMatch(supplierId: string | null, code: string | null) {
  if (!supplierId || !code) return null;
  return (S.supplierProducts?.[supplierId] ?? []).find((sp: any) => sp.supplier_code === code) ?? null;
}
/** Supplier code (1.0) > barcode (0.97) > fuzzy name (capped at 0.85) — same order as the API. */
function matchLine(supplierId: string | null, l: any) {
  const sp = supplierCodeMatch(supplierId, l.supplier_code);
  if (sp) return { product_id: sp.product_id, match_status: 'matched_auto', match_confidence: 1 };
  if (l.barcode) { const pid = findByBarcode(l.barcode); if (pid) return { product_id: pid, match_status: 'matched_auto', match_confidence: 0.97 }; }
  const want = productNameFromInvoice(l.description ?? '');
  let best: { id: string; s: number } | null = null;
  for (const p of S.products) { if (p.archived_at) continue; const s = similarity(want, p.name); if (!best || s > best.s) best = { id: p.id, s }; }
  if (best && best.s >= 0.45) return { product_id: best.id, match_status: 'suggested', match_confidence: Math.min(0.85, Math.round(best.s * 100) / 100) };
  return { product_id: null, match_status: 'unmatched', match_confidence: null };
}
const MATCHED = new Set(['matched_auto', 'matched_manual', 'new_product_created']);

async function processInvoice(id: string, file: { b64: string; mime: string }) {
  const d = S.invoiceDetails[id];
  const progress = (text: string, vars?: Record<string, string | number>) => { d.ocr_progress = { text, vars }; };
  try {
    progress('Preparing the pages…');
    const pages = await pagesFromFile(file.b64, file.mime);
    const x = await readInvoice(pages, progress);
    // Supplier: match by name (or VAT number), else create it — like the API.
    const nm = String(x.supplier_name ?? '').trim();
    let sup = nm ? S.suppliers.find((s: any) => (x.supplier_vat_number && s.vat_number === x.supplier_vat_number)
      || similarity(s.name, nm.replace(/\b(ltd|limited|plc|wholesale|cash\s*&?\s*carry)\b/gi, '')) >= 0.5) : null;
    if (!sup && nm) { sup = { id: uuidv7(), name: nm, vat_number: x.supplier_vat_number ?? null, is_active: true, order_days: null, order_method: 'email', created_at: now() };
      S.suppliers.push(sup); S.supplierProducts[sup.id] = []; }
    if (sup && x.invoice_number && Object.values<any>(S.invoiceDetails).some((o) => o.id !== id && o.supplier_id === sup.id
      && o.invoice_number === x.invoice_number && o.status !== 'rejected')) {
      Object.assign(d, { status: 'rejected', supplier_id: sup.id, supplier_name: sup.name, invoice_number: x.invoice_number,
        ocr_error: 'Duplicate invoice: this supplier invoice number has already been uploaded' });
      return;
    }
    const lines = (x.lines ?? []).map((r: any, i: number) => {
      const l: any = { id: uuidv7(), invoice_id: id, line_no: i + 1, raw_text: r.raw_text ?? null, supplier_code: r.supplier_code ?? null,
        barcode: r.barcode ? String(r.barcode).replace(/\D/g, '') || null : null, description: r.description ?? '', quantity: r.quantity ?? null,
        pack_size: r.pack_size ?? null, unit_cost_pence: r.unit_cost_pence ?? null, line_total_pence: r.line_total_pence ?? null,
        vat_code: ['S', 'R', 'Z', 'E'].includes(r.vat_code) ? r.vat_code : null, is_pmp: r.is_pmp ?? null, pmp_price_pence: r.pmp_price_pence ?? null,
        rrp_pence: r.rrp_pence ?? null, expiry_date: r.expiry_date ?? null, matched_by: null };
      Object.assign(l, matchLine(sup?.id ?? null, l));
      l.product_name = productName(l.product_id);
      return l;
    });
    const conf = typeof x.confidence === 'number' ? x.confidence : 0.7;
    const allMatched = lines.length > 0 && lines.every((l: any) => MATCHED.has(l.match_status));
    Object.assign(d, { supplier_id: sup?.id ?? null, supplier_name: sup?.name ?? null, invoice_number: x.invoice_number ?? null,
      invoice_date: x.invoice_date ?? null, due_date: x.due_date ?? null, subtotal_pence: x.subtotal_pence ?? null, vat_pence: x.vat_pence ?? null,
      total_pence: x.total_pence ?? null, ocr_raw: x, ocr_confidence: conf, ocr_provider: 'claude', processed_at: now(), lines,
      status: allMatched && conf >= 0.8 ? 'approved' : 'needs_review' });
  } catch (e) {
    Object.assign(d, { status: 'failed', ocr_error: e instanceof ReadError ? e.message : 'We couldn’t read this invoice. Upload it again, or try a clearer photo.' });
    console.error(e);
  } finally {
    delete d.ocr_progress; syncInvoiceRow(d);
  }
}

on('POST', '/v1/invoices', (c) => {
  const id = uuidv7();
  const d: any = { id, tenant_id: S.me.tenant.id, branch_id: c.body.branch_id ?? branchId, supplier_id: null, purchase_order_id: null, status: 'processing',
    invoice_number: null, invoice_date: null, due_date: null, subtotal_pence: null, vat_pence: null, total_pence: null, supplier_name: null,
    ocr_confidence: null, ocr_error: null, ocr_raw: null, created_at: now(), posted_at: null, uploaded_by: c.staffId, lines: [] };
  S.invoiceDetails[id] = d; S.invoices.unshift(invoiceRow(d));
  void processInvoice(id, { b64: dataUrlToB64(c.body.content_base64 ?? ''), mime: c.body.mime_type ?? 'image/jpeg' });
  return created(invoiceRow(d));
});
on('PATCH', '/v1/invoices/:id', (c) => {
  const d = S.invoiceDetails[c.params.id]; Object.assign(d, c.body); if (c.body.supplier_id) d.supplier_name = supplierName(c.body.supplier_id);
  syncInvoiceRow(d); return d;
});
on('PATCH', '/v1/invoices/:id/lines/:lineId', (c) => {
  const d = S.invoiceDetails[c.params.id]; const l = d.lines.find((x: any) => x.id === c.params.lineId); if (!l) fail(404, 'Invoice line not found');
  const { ignore, ...f } = c.body; Object.assign(l, f);
  if (ignore) Object.assign(l, { match_status: 'ignored', product_id: null, product_name: null });
  else if (c.body.product_id) Object.assign(l, { match_status: 'matched_manual', match_confidence: 1, product_name: productName(c.body.product_id) });
  return l;
});

function requireOpenInvoice(id: string) {
  const d = S.invoiceDetails[id]; if (!d) fail(404, 'Invoice not found', undefined, 'not_found');
  if (!['needs_review', 'approved'].includes(d.status)) fail(409, `Invoice is ${d.status}`, undefined, 'conflict');
  return d;
}
function createProductFromLine(d: any, lineId: string, o: { name?: string; vat_code?: string; category_id?: string | null; price_pence?: number | null } = {}) {
  const l = d.lines.find((x: any) => x.id === lineId); if (!l) fail(404, 'Invoice line not found', undefined, 'not_found');
  if (l.match_status === 'ignored') fail(409, 'This line is ignored', undefined, 'conflict');
  const name = (o.name ?? productNameFromInvoice(l.description)).trim(); if (!name) fail(422, 'Enter a product name');
  if (l.barcode && findByBarcode(l.barcode)) fail(409, 'A product with this barcode already exists — match the line to it instead', undefined, 'conflict');
  const pid = uuidv7(); const vat = o.vat_code ?? l.vat_code ?? 'S';
  const cost = l.unit_cost_pence != null ? Math.round(l.unit_cost_pence / (l.pack_size || 1)) : null;
  const price = o.price_pence !== undefined ? o.price_pence : (l.is_pmp && l.pmp_price_pence ? l.pmp_price_pence : l.rrp_pence);
  const lvl = defaultLevel();
  const barcodes = l.barcode ? [{ id: uuidv7(), product_id: pid, barcode: l.barcode, barcode_type: l.barcode.length === 8 ? 'EAN8' : l.barcode.length === 14 ? 'ITF14' : 'EAN13',
    units_per_scan: 1, is_primary: true, is_pmp: !!(l.is_pmp && l.pmp_price_pence), pmp_price_pence: l.is_pmp ? l.pmp_price_pence : null }] : [];
  const prices = price != null ? [{ id: uuidv7(), product_id: pid, price_level_id: lvl.id, price_level_code: lvl.code, branch_id: null, min_qty: 1, price_pence: price,
    valid_from: now(), valid_to: null }] : [];
  const base = { id: pid, name, name_i18n: {}, brand: null, size_text: null, sku: null, category_id: o.category_id ?? null, vat_code: vat, min_age: null,
    sold_by_weight: false, unit_type: 'each', track_stock: true, is_active: true, archived_at: null, avg_cost_pence: cost, last_cost_pence: cost, updated_at: now() };
  S.productDetails[pid] = { ...base, barcodes, current_prices: prices, stock: [{ branch_id: branchId, on_hand: 0, reserved: 0, available: 0 }] };
  S.priceHistory[pid] = prices;
  S.products.push({ ...base, retail_price_pence: price ?? null, barcode: l.barcode ?? null });
  S.products.sort((a: any, b: any) => a.name.localeCompare(b.name));
  S.stock.push({ product_id: pid, name, on_hand: 0, reserved: 0, available: 0, reorder_point: null, reorder_qty: null });
  S.pull.products.push({ ...base, is_ranged: true }); S.pull.barcodes.push(...barcodes); S.pull.prices.push(...prices);
  changedAt[pid] = Date.now();
  for (const x of d.lines) {
    if (x.id === lineId || (l.supplier_code && x.supplier_code === l.supplier_code && !x.product_id && x.match_status !== 'ignored')) {
      Object.assign(x, { product_id: pid, product_name: name, match_status: 'new_product_created', match_confidence: 1, matched_by: ownerId });
    }
  }
  return { product_id: pid, name, price_pence: price ?? null };
}
on('POST', '/v1/invoices/:id/lines/:lineId/create-product', (c) => created(createProductFromLine(requireOpenInvoice(c.params.id), c.params.lineId, c.body ?? {})));
on('POST', '/v1/invoices/:id/create-missing-products', (c) => {
  const d = requireOpenInvoice(c.params.id); const out: any[] = [], skipped: any[] = [];
  for (const l of d.lines) {
    if (l.product_id || l.match_status === 'ignored' || !((l.quantity ?? 0) > 0) || !(l.supplier_code || l.barcode)) continue;
    try { out.push(createProductFromLine(d, l.id)); } catch (e) { skipped.push({ line_id: l.id, reason: (e as Error).message }); }
  }
  return { created: out, skipped };
});
on('POST', '/v1/invoices/:id/post', (c) => {
  const d = requireOpenInvoice(c.params.id);
  const open = d.lines.filter((l: any) => l.match_status !== 'ignored' && !l.product_id);
  if (open.length) fail(422, `${open.length} line(s) still need a product (or mark them ignored)`);
  // Net per product, so a void note (−1) cancels the line it voids.
  const per = new Map<string, { units: number; cost: number; costed: number; codes: Map<string, any> }>();
  for (const l of d.lines) {
    if (!l.product_id || l.match_status === 'ignored') continue;
    const pack = l.pack_size || 1, units = (l.quantity ?? 0) * pack;
    const p = per.get(l.product_id) ?? { units: 0, cost: 0, costed: 0, codes: new Map() };
    p.units += units;
    if (l.unit_cost_pence != null) { p.cost += (l.quantity ?? 0) * l.unit_cost_pence; p.costed += units; }
    if (l.supplier_code && (l.quantity ?? 0) > 0) p.codes.set(l.supplier_code, l);
    per.set(l.product_id, p);
  }
  let n = 0;
  for (const [pid, p] of per) {
    if (p.units <= 0) continue;
    const unitCost = p.costed > 0 ? Math.round(p.cost / p.costed) : null;
    stockAdd(pid, p.units, 'receipt', { cost: unitCost, staffId: c.staffId }); n++;
    const det = S.productDetails[pid]; if (det && unitCost != null) det.last_cost_pence = unitCost;
    if (d.supplier_id) {
      const list = (S.supplierProducts[d.supplier_id] ??= []);
      for (const [code, l] of p.codes) {
        const ex = list.find((sp: any) => sp.supplier_code === code);
        const row = { supplier_id: d.supplier_id, product_id: pid, supplier_code: code, supplier_description: l.description, pack_size: l.pack_size,
          case_cost_pence: l.unit_cost_pence, last_cost_at: now(), match_source: 'ocr_confirmed', product_name: productName(pid) };
        if (ex) Object.assign(ex, row); else list.push({ id: uuidv7(), is_preferred: false, created_at: now(), ...row });
      }
    }
  }
  Object.assign(d, { status: 'posted', posted_at: now() }); syncInvoiceRow(d);
  return { invoice: d, lines_received: n };
});
on('POST', '/v1/invoices/:id/reject', (c) => { const d = S.invoiceDetails[c.params.id]; Object.assign(d, { status: 'rejected', ocr_error: c.body.reason }); syncInvoiceRow(d); return d; });

// ---- reports & finance
on('GET', '/v1/reports/daily', (c) => S.daily.filter((r: any) => r.business_date >= c.q.get('from')! && r.business_date <= c.q.get('to')!)
  .sort((a: any, b: any) => (a.business_date < b.business_date ? -1 : 1)));
on('GET', '/v1/reports/top-products', (c) => {
  const days = (Date.parse(c.q.get('to')!) - Date.parse(c.q.get('from')!)) / DAY + 1;
  const order = (c.q.get('order') ?? 'revenue') as 'revenue' | 'quantity' | 'margin';
  const rows = days <= 7 ? [...S.top7].sort((a: any, b: any) => (order === 'quantity' ? b.qty_sold - a.qty_sold : order === 'margin' ? b.margin_pence - a.margin_pence : b.net_sales_pence - a.net_sales_pence))
    : S.top14[order];
  return rows.slice(0, Number(c.q.get('limit') ?? 20));
});
on('GET', '/v1/reports/staff-activity', () => S.staffActivity);
on('GET', '/v1/reports/vat', (c) => c.q.get('from') === S.vat.period_start ? { period_start: S.vat.period_start, period_end: S.vat.period_end, ...S.vat.data }
  : { period_start: c.q.get('from'), period_end: c.q.get('to'), box1_vat_due_sales_pence: 0, box2_vat_due_acquisitions_pence: 0, box3_total_vat_due_pence: 0,
    box4_vat_reclaimed_pence: 0, box5_net_vat_pence: 0, box6_total_sales_ex_vat_pence: 0, box7_total_purchases_ex_vat_pence: 0, box8_supplies_ex_vat_pence: 0,
    box9_acquisitions_ex_vat_pence: 0, direction: 'payable' });
on('POST', '/v1/vat-returns', (c) => created({ id: uuidv7(), status: 'draft', ...c.body }));

// ---- people & settings
on('GET', '/v1/staff', () => S.staff);
on('POST', '/v1/staff', (c) => {
  const id = uuidv7(); const role = S.roles.find((r: any) => r.id === c.body.role_id);
  const s = { id, first_name: c.body.first_name, last_name: c.body.last_name, display_name: c.body.display_name ?? c.body.first_name, email: c.body.email,
    employment_type: c.body.employment_type ?? 'part_time', status: 'active', start_date: c.body.start_date, role_id: c.body.role_id, role_name: role?.name,
    has_pin: !!c.body.pin, branch_ids: c.body.branch_ids };
  S.staff.push(s);
  if (c.body.pin) {
    pinsById[id] = c.body.pin;
    const tile = { id, display_name: s.display_name, role_key: role?.system_key ?? null, role_name: role?.name };
    S.hello.staff.push(tile); S.staffTiles.push({ id, display_name: s.display_name });
    S.pull.staff.push({ id, display_name: s.display_name, role_key: role?.system_key ?? null, permissions: role?.permissions ?? [], limits: role?.limits ?? {} });
  }
  return created(s);
});
on('PUT', '/v1/staff/:id/pin', (c) => { pinsById[c.params.id] = c.body.pin; const s = S.staff.find((x: any) => x.id === c.params.id); if (s) s.has_pin = true; return { ok: true }; });
on('GET', '/v1/roles', () => S.roles);
on('PUT', '/v1/roles/:id/permissions', (c) => {
  const r = S.roles.find((x: any) => x.id === c.params.id); r.permissions = [...c.body.permissions].sort();
  for (const s of S.pull.staff) if (S.staff.find((x: any) => x.id === s.id)?.role_id === r.id) s.permissions = r.permissions;
  return { role_id: r.id, permissions: r.permissions };
});
on('PUT', '/v1/roles/:id/limits', (c) => {
  const r = S.roles.find((x: any) => x.id === c.params.id);
  for (const [k, v] of Object.entries(c.body.limits)) { if (v === null) delete r.limits[k]; else r.limits[k] = v; }
  for (const s of S.pull.staff) if (S.staff.find((x: any) => x.id === s.id)?.role_id === r.id) s.limits = { ...r.limits };
  return Object.entries(r.limits).map(([limit_code, value]) => ({ limit_code, value }));
});
on('GET', '/v1/permissions', () => S.permissions);
on('GET', '/v1/branches', () => S.branches);
on('POST', '/v1/branches', (c) => { const b = { id: uuidv7(), is_active: true, ...c.body }; S.branches.push(b); return created(b); });
on('GET', '/v1/devices', () => S.devices);
on('POST', '/v1/devices', (c) => {
  const no = Math.max(0, ...S.devices.map((d: any) => d.device_no ?? 0)) + 1;
  const d = { id: uuidv7(), branch_id: c.body.branch_id, name: c.body.name, kind: c.body.kind, platform: c.body.platform ?? null, device_no: no,
    last_seen_at: null, last_sync_at: null, is_active: true, registered_at: now() };
  S.devices.push(d);
  const secret = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('');
  return created({ device_id: d.id, device_no: no, till_id: uuidv7(), device_secret: secret });
});
on('PATCH', '/v1/devices/:id', (c) => { const d = S.devices.find((x: any) => x.id === c.params.id); Object.assign(d, c.body); return d; });

// ------------------------------------------------------------------ dispatcher
function handle(method: string, url: URL, body: any, auth: string | null): { status: number; body?: any } {
  let path = url.pathname;
  if (path === '/api/session') {
    if (method === 'DELETE') { window.__demo.signedIn = false; return { status: 200, body: { ok: true } }; }
    if (body?.action === 'signup') { window.__demo.signedIn = true; return { status: 200, body: { ok: true } }; }
    if (String(body?.email).toLowerCase() !== 'owner@cornershop.demo' || body?.password !== 'demo-password-1') {
      return { status: 401, body: { error: 'unauthorized', message: 'Email or password is incorrect. In the demo use owner@cornershop.demo and demo-password-1.' } };
    }
    window.__demo.signedIn = true; return { status: 200, body: { ok: true, tenant_id: S.me.tenant.id } };
  }
  if (path.startsWith('/api/proxy')) path = path.slice('/api/proxy'.length);
  const staffId = auth?.startsWith('Bearer demo.') ? auth.slice('Bearer demo.'.length) : ownerId;
  for (const [m, re, keys, h] of routes) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (!match) continue;
    const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]));
    try {
      const out = h({ method, path, q: url.searchParams, body, staffId, params });
      if (out && typeof out === 'object' && '__status' in out) return { status: out.__status, body: out.body };
      return { status: 200, body: out };
    } catch (e) {
      if (e instanceof HttpErr) return { status: e.status, body: { error: e.code, message: e.message, details: e.details } };
      console.error('[demo backend]', method, path, e);
      return { status: 500, body: { error: 'internal', message: 'Demo backend error' } };
    }
  }
  // Anything not modelled: reads return nothing, writes pretend to succeed.
  return method === 'GET' ? { status: 200, body: [] } : { status: 200, body: { ok: true } };
}

// ------------------------------------------------------------------ fetch shim
const realFetch = window.fetch.bind(window);
window.__demo = {
  offline: false,
  signedIn: false,
  setOffline(v: boolean) { this.offline = v; listeners.forEach((l) => l()); },
  onChange(cb: () => void) { listeners.push(cb); },
};
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  const isTill = url.origin === DEMO_API;
  const isOffice = url.origin === location.origin && url.pathname.startsWith('/api/');
  if (!isTill && !isOffice) return realFetch(input as RequestInfo, init);
  if (isTill && window.__demo.offline) {
    await new Promise((r) => setTimeout(r, 150));
    throw new TypeError('Failed to fetch (demo: offline)');
  }
  const method = (init?.method ?? 'GET').toUpperCase();
  const raw = init?.body ? String(init.body) : '';
  const headers = new Headers(init?.headers);
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 120)); // feel like a network
  const res = handle(method, url, raw ? JSON.parse(raw) : undefined, headers.get('authorization'));
  return new Response(res.status === 204 || res.body === undefined ? null : JSON.stringify(res.body), {
    status: res.status, headers: { 'content-type': 'application/json' } });
};

// Each page load is a fresh demo: clear the till's cached state, then
// pre-pair it with the demo shop (the real app reads this on boot).
try {
  for (const k of Object.keys(localStorage)) if (k.startsWith('counter:')) localStorage.removeItem(k);
  localStorage.setItem('counter:secure:pairing', JSON.stringify({ ...S.pairing, api: DEMO_API }));
} catch { /* storage blocked: the till shows its pairing screen instead */ }
export const DEMO_PAIRING_CODE = btoa(JSON.stringify({ ...S.pairing, api: DEMO_API })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
(window as any).__DEMO_PAIRING_CODE__ = DEMO_PAIRING_CODE;
