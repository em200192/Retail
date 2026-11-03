import { evaluateDiscount, lineAmount, parseReceiptNumber, type Permission, vatFromGross } from '@retail/shared';
import { z } from 'zod';
import { type Actor, loadActor } from '../lib/authz.ts';
import type { Tx } from '../lib/db.ts';
import { conflict, forbidden, HttpError, unprocessable } from '../lib/errors.ts';
import { enqueueEvent } from '../lib/outbox.ts';
import { type MovementInput, postMovements } from '../lib/stock.ts';
import { isoDateTime, pence, positivePence, quantity, uuid, vatCode } from '../lib/validate.ts';

// --------------------------------------------------------------------------
// Payload shapes sent by the POS device. ALL ids are generated on the device
// (UUIDv7) — re-sending the same payload is always safe.
//
// Conventions (shared with the device):
//  * quantity is in base units (a 12-pack case barcode = 12)
//  * line_total = round(unit_price × qty) − line_discount − promotion_discount
//  * basket discounts are apportioned onto lines (apportion()) so every
//    line's VAT is correct; sale_discounts keeps the audit record
//  * sale.subtotal = Σ round(unit_price × qty); sale.discount = Σ line + promo
//    discounts; sale.total = Σ line_total; sale.vat = Σ line vat (non-voided)
// --------------------------------------------------------------------------

const approvalRow = z.object({
  id: uuid,
  sale_line_id: uuid.nullish(),
  action_code: z.string(),
  requested_by: uuid,
  approved_by: uuid.nullish(),
  outcome: z.enum(['self_authorised', 'approved', 'denied']),
  value: z.number().nullish(),
  reason: z.string().nullish(),
  occurred_at: isoDateTime,
});

const ageCheckRow = z.object({
  id: uuid,
  product_id: uuid.nullish(),
  staff_id: uuid,
  required_age: z.number().int().min(12).max(25),
  outcome: z.enum(['looked_over_25', 'id_checked_ok', 'refused', 'id_not_available']),
  occurred_at: isoDateTime,
});

export const saleSchema = z.object({
  id: uuid,
  till_session_id: uuid.nullish(),
  staff_id: uuid,
  customer_id: uuid.nullish(),
  price_level_id: uuid.nullish(),
  channel: z.enum(['pos', 'self_checkout', 'phone']).default('pos'),
  receipt_number: z.string().min(3),
  status: z.enum(['completed', 'voided']),
  is_training: z.boolean().default(false),
  subtotal_pence: pence,
  discount_pence: pence,
  total_pence: pence,
  vat_pence: z.number().int(),
  started_at: isoDateTime.nullish(),
  completed_at: isoDateTime.nullish(),
  voided_at: isoDateTime.nullish(),
  voided_by: uuid.nullish(),
  void_reason: z.string().nullish(),
  notes: z.string().nullish(),
  lines: z.array(z.object({
    id: uuid,
    line_no: z.number().int().positive(),
    product_id: uuid.nullish(),
    barcode_scanned: z.string().nullish(),
    description: z.string().min(1),
    quantity: quantity.refine((q) => q > 0, 'quantity must be > 0'),
    unit_price_pence: pence,
    price_level_id: uuid.nullish(),
    is_pmp: z.boolean().default(false),
    pmp_price_pence: pence.nullish(),
    line_discount_pence: pence.default(0),
    promotion_id: uuid.nullish(),
    promotion_discount_pence: pence.default(0),
    line_total_pence: pence,
    vat_code: vatCode,
    vat_rate_percent: z.number().nonnegative(),
    vat_pence: z.number().int(),
    unit_cost_pence: pence.nullish(),
    age_check_id: uuid.nullish(),
    is_voided: z.boolean().default(false),
    voided_by: uuid.nullish(),
    void_reason: z.string().nullish(),
    added_at: isoDateTime.nullish(),
  })).min(1),
  payments: z.array(z.object({
    id: uuid,
    method: z.enum(['cash', 'card', 'voucher', 'loyalty_points', 'account', 'online_platform', 'gift_card']),
    amount_pence: positivePence,
    tendered_pence: pence.nullish(),
    change_pence: pence.nullish(),
    provider: z.string().nullish(),
    provider_txn_ref: z.string().nullish(),
    card_brand: z.string().nullish(),
    card_last4: z.string().regex(/^\d{4}$/).nullish(),
    auth_code: z.string().nullish(),
    status: z.enum(['approved', 'declined', 'voided']).default('approved'),
    occurred_at: isoDateTime,
  })).default([]),
  discounts: z.array(z.object({
    id: uuid,
    sale_line_id: uuid.nullish(),
    discount_type: z.enum(['percent', 'amount', 'price_override']),
    percent: z.number().positive().max(100).nullish(),
    amount_pence: positivePence,
    reason_code: z.string().nullish(),
    staff_id: uuid,
    approval_id: uuid.nullish(),
  })).default([]),
  approvals: z.array(approvalRow).default([]),
  age_checks: z.array(ageCheckRow).default([]),
});
export type SalePayload = z.infer<typeof saleSchema>;

export const refundSchema = z.object({
  id: uuid,
  original_sale_id: uuid.nullish(),
  till_session_id: uuid.nullish(),
  staff_id: uuid,
  approval: approvalRow.nullish(),
  reason_code: z.string().min(1),
  reason: z.string().nullish(),
  refund_method: z.enum(['cash', 'card', 'voucher', 'loyalty_points', 'original_platform']),
  total_pence: positivePence,
  vat_pence: z.number().int(),
  occurred_at: isoDateTime,
  lines: z.array(z.object({
    id: uuid,
    sale_line_id: uuid.nullish(),
    product_id: uuid.nullish(),
    quantity: quantity.refine((q) => q > 0),
    amount_pence: pence,
    vat_code: vatCode,
    vat_pence: z.number().int(),
    restock: z.boolean().default(true),
  })).min(1),
});
export type RefundPayload = z.infer<typeof refundSchema>;

export interface DeviceContext {
  tenantId: string;
  deviceId: string;
  branchId: string;
}

export type SyncOutcome = { id: string; status: 'created' | 'duplicate' } | { id: string; status: 'rejected'; error: string; message: string; details?: unknown };

const PASSING_AGE_CHECKS = new Set(['looked_over_25', 'id_checked_ok']);

/** Actors are loaded once per staff id per transaction. */
class ActorCache {
  private cache = new Map<string, Promise<Actor>>();
  constructor(private tx: Tx) {}
  get(staffId: string): Promise<Actor> {
    if (!this.cache.has(staffId)) {
      this.cache.set(staffId, loadActor(this.tx, staffId).catch(() => {
        throw unprocessable(`Unknown or inactive staff member ${staffId}`);
      }));
    }
    return this.cache.get(staffId)!;
  }
  async require(staffId: string, ...perms: Permission[]): Promise<Actor> {
    const a = await this.get(staffId);
    const missing = perms.filter((p) => !a.permissions.has(p));
    if (missing.length) throw forbidden(`Staff ${staffId} lacks ${missing.join(', ')}`, { staff_id: staffId, missing });
    return a;
  }
}

async function vatRate(tx: Tx, code: string, at: string): Promise<number> {
  const [r] = await tx<{ rate: number }[]>`SELECT vat_rate_on(${code}, (${at}::timestamptz AT TIME ZONE 'Europe/London')::date) AS rate`;
  if (r?.rate === null || r?.rate === undefined) throw unprocessable(`No VAT rate for code ${code}`);
  return r.rate;
}

async function checkApprovals(cache: ActorCache, approvals: z.infer<typeof approvalRow>[]) {
  for (const a of approvals) {
    await cache.get(a.requested_by);
    if (a.outcome === 'approved') {
      if (!a.approved_by) throw unprocessable(`Approval ${a.id} has no approver`);
      if (a.approved_by === a.requested_by) throw forbidden('Staff cannot approve their own action');
      await cache.require(a.approved_by, 'pos.approve');
    }
  }
}

function needApproved(
  approvals: Map<string, z.infer<typeof approvalRow>>, approvalId: string | null | undefined, action: string, what: string,
) {
  const a = approvalId ? approvals.get(approvalId) : undefined;
  if (!a || a.outcome !== 'approved' || a.action_code !== action) {
    throw forbidden(`${what} is over the staff member's limit and has no manager approval`, { needs_approval: true, action });
  }
}

/**
 * Validates and stores ONE sale from a device. Runs inside withTenant().
 * Returns 'duplicate' (and changes nothing) if the device already sent it.
 */
export async function ingestSale(tx: Tx, dev: DeviceContext, s: SalePayload): Promise<'created' | 'duplicate'> {
  const [exists] = await tx`SELECT 1 FROM sales WHERE id = ${s.id}`;
  if (exists) return 'duplicate';

  const cache = new ActorCache(tx);
  const [branch] = await tx<{ code: string }[]>`SELECT code FROM branches WHERE id = ${dev.branchId}`;
  const [device] = await tx<{ device_no: number | null }[]>`SELECT device_no FROM devices WHERE id = ${dev.deviceId}`;
  const rn = parseReceiptNumber(s.receipt_number);
  if (!rn || rn.branchCode !== branch?.code || rn.deviceNo !== device?.device_no) {
    throw unprocessable(`Receipt number must be ${branch?.code}-${device?.device_no}-{seq}`);
  }

  // -- who sold it
  await cache.require(s.staff_id, s.is_training ? 'pos.training_mode' : 'pos.sell');
  if (s.till_session_id) {
    const [ts] = await tx<{ branch_id: string }[]>`SELECT branch_id FROM till_sessions WHERE id = ${s.till_session_id}`;
    if (!ts || ts.branch_id !== dev.branchId) throw unprocessable('Unknown till session for this branch');
  }
  if (s.status === 'completed' && !s.completed_at) throw unprocessable('completed_at is required');
  if (s.status === 'voided') {
    if (!s.voided_by || !s.voided_at) throw unprocessable('voided_by and voided_at are required');
    await cache.require(s.voided_by, 'pos.void_sale');
  }
  const at = s.completed_at ?? s.voided_at ?? new Date().toISOString();

  await checkApprovals(cache, s.approvals);
  const approvals = new Map(s.approvals.map((a) => [a.id, a]));
  const ageChecks = new Map(s.age_checks.map((a) => [a.id, a]));

  // -- lines
  const lineNos = new Set<number>();
  const productIds = [...new Set(s.lines.map((l) => l.product_id).filter((x): x is string => !!x))];
  const products = new Map((productIds.length ? await tx<{ id: string; min_age: number | null; track_stock: boolean; avg_cost_pence: number | null }[]>`
    SELECT id, min_age, track_stock, avg_cost_pence FROM products WHERE id IN ${tx(productIds)}` : []).map((p) => [p.id, p]));
  const scanned = [...new Set(s.lines.map((l) => l.barcode_scanned).filter((x): x is string => !!x))];
  const pmpBarcodes = new Map((scanned.length ? await tx<{ barcode: string; product_id: string; pmp_price_pence: number }[]>`
    SELECT barcode, product_id, pmp_price_pence FROM product_barcodes WHERE is_pmp AND barcode IN ${tx(scanned)}` : [])
    .map((b) => [b.barcode, b]));

  let subtotal = 0, discount = 0, total = 0, vat = 0, items = 0;
  const lineBase = new Map<string, number>();
  for (const l of s.lines) {
    if (lineNos.has(l.line_no)) throw unprocessable(`Duplicate line_no ${l.line_no}`);
    lineNos.add(l.line_no);
    const product = l.product_id ? products.get(l.product_id) : undefined;
    if (l.product_id && !product) throw unprocessable(`Unknown product on line ${l.line_no}`);

    const base = lineAmount(l.unit_price_pence, l.quantity);
    lineBase.set(l.id, base);
    if (l.line_total_pence !== base - l.line_discount_pence - l.promotion_discount_pence) {
      throw unprocessable(`Line ${l.line_no}: line_total must equal unit price × qty − discounts (${base - l.line_discount_pence - l.promotion_discount_pence})`);
    }
    const rate = await vatRate(tx, l.vat_code, at);
    if (Math.abs(rate - l.vat_rate_percent) > 0.001) throw unprocessable(`Line ${l.line_no}: VAT rate for ${l.vat_code} on that date is ${rate}%`);
    const expectedVat = vatFromGross(l.line_total_pence, rate);
    if (l.vat_pence !== expectedVat) throw unprocessable(`Line ${l.line_no}: VAT must be ${expectedVat}p`);

    // PMP: the scanned barcode decides; never charge above the printed price (the DB enforces it too).
    const pmp = l.barcode_scanned ? pmpBarcodes.get(l.barcode_scanned) : undefined;
    if (pmp && pmp.product_id === l.product_id && (!l.is_pmp || l.pmp_price_pence !== pmp.pmp_price_pence)) {
      throw unprocessable(`Line ${l.line_no}: barcode ${l.barcode_scanned} is price-marked at ${pmp.pmp_price_pence}p`);
    }

    if (l.is_voided) {
      if (!l.voided_by) throw unprocessable(`Line ${l.line_no}: voided_by is required`);
      await cache.require(l.voided_by, 'pos.void_line');
      continue;
    }
    if (product?.min_age && s.status === 'completed') {
      const check = l.age_check_id ? ageChecks.get(l.age_check_id) : undefined;
      if (!check || !PASSING_AGE_CHECKS.has(check.outcome) || check.required_age < product.min_age) {
        throw forbidden(`Line ${l.line_no}: age-restricted (${product.min_age}+) item sold without a passed Challenge 25 check`);
      }
    }
    subtotal += base;
    discount += l.line_discount_pence + l.promotion_discount_pence;
    total += l.line_total_pence;
    vat += l.vat_pence;
    items += l.quantity;
  }
  if (s.subtotal_pence !== subtotal || s.discount_pence !== discount || s.total_pence !== total || s.vat_pence !== vat) {
    throw unprocessable('Sale totals do not match its lines', { expected: { subtotal, discount, total, vat } });
  }

  // -- manual discounts: within the staff member's limits, or manager-approved
  const lineById = new Map(s.lines.map((l) => [l.id, l]));
  const manualByLine = new Map<string, number>();
  for (const d of s.discounts) {
    const perm: Permission = d.discount_type === 'price_override' ? 'pos.price_override' : 'pos.discount';
    const actor = await cache.require(d.staff_id, perm);
    const target = d.sale_line_id ? lineById.get(d.sale_line_id) : undefined;
    if (d.sale_line_id && !target) throw unprocessable(`Discount ${d.id} refers to an unknown line`);
    const baseAmount = target ? lineBase.get(target.id)! : subtotal;
    const pct = d.percent ?? (baseAmount > 0 ? (d.amount_pence * 100) / baseAmount : 100);
    const decision = d.discount_type === 'price_override'
      ? (actor.isOwner || (actor.limits.get('pos.price_override.max_percent') ?? -1) >= pct ? 'self_authorised' : 'needs_approval')
      : evaluateDiscount(pct, d.amount_pence, {
        maxPercent: actor.limits.get('pos.discount.max_percent'),
        maxAmountPence: actor.limits.get('pos.discount.max_amount_pence'),
      }, actor.isOwner);
    if (decision === 'needs_approval') needApproved(approvals, d.approval_id, perm, `Discount of ${d.amount_pence}p`);
    if (d.sale_line_id) manualByLine.set(d.sale_line_id, (manualByLine.get(d.sale_line_id) ?? 0) + d.amount_pence);
  }
  const manualTotal = s.discounts.reduce((a, d) => a + d.amount_pence, 0);
  const lineDiscTotal = s.lines.filter((l) => !l.is_voided).reduce((a, l) => a + l.line_discount_pence, 0);
  if (manualTotal !== lineDiscTotal) {
    throw unprocessable('Every manual line discount must have a matching sale_discounts record', { discounts: manualTotal, lines: lineDiscTotal });
  }

  // -- payments
  const approvedPayments = s.payments.filter((p) => p.status === 'approved');
  const paid = approvedPayments.reduce((a, p) => a + p.amount_pence, 0);
  if (s.status === 'completed' && paid !== s.total_pence) throw unprocessable(`Payments (${paid}p) must equal the total (${s.total_pence}p)`);
  if (s.status === 'voided' && paid !== 0) throw unprocessable('A voided sale cannot have approved payments');
  for (const p of s.payments) {
    if (p.tendered_pence != null && p.method === 'cash' && p.change_pence != null && p.tendered_pence - p.amount_pence !== p.change_pence) {
      throw unprocessable('Cash change does not match the amount tendered');
    }
  }
  if (s.customer_id) {
    const [c] = await tx`SELECT 1 FROM customers WHERE id = ${s.customer_id}`;
    if (!c) throw unprocessable('Unknown customer');
  }

  // -- store it (sale first; ON CONFLICT makes concurrent retries safe)
  const inserted = await tx`
    INSERT INTO sales (tenant_id, id, branch_id, device_id, till_session_id, staff_id, customer_id, price_level_id, channel,
                       receipt_number, status, is_training, subtotal_pence, discount_pence, total_pence, vat_pence, item_count,
                       started_at, completed_at, voided_at, voided_by, void_reason, notes)
    VALUES (${dev.tenantId}, ${s.id}, ${dev.branchId}, ${dev.deviceId}, ${s.till_session_id ?? null}, ${s.staff_id},
            ${s.customer_id ?? null}, ${s.price_level_id ?? null}, ${s.channel}, ${s.receipt_number}, ${s.status}, ${s.is_training},
            ${s.subtotal_pence}, ${s.discount_pence}, ${s.total_pence}, ${s.vat_pence}, ${Math.round(items * 1000) / 1000},
            ${s.started_at ?? null}, ${s.completed_at ?? null}, ${s.voided_at ?? null}, ${s.voided_by ?? null},
            ${s.void_reason ?? null}, ${s.notes ?? null})
    ON CONFLICT (tenant_id, id) DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) return 'duplicate';

  if (s.age_checks.length) {
    await tx`INSERT INTO age_checks ${tx(s.age_checks.map((a) => ({
      tenant_id: dev.tenantId, id: a.id, branch_id: dev.branchId, sale_id: s.id, product_id: a.product_id ?? null,
      staff_id: a.staff_id, device_id: dev.deviceId, required_age: a.required_age, outcome: a.outcome, occurred_at: new Date(a.occurred_at),
    })) as never)}`;
  }
  await tx`INSERT INTO sale_lines ${tx(s.lines.map((l) => ({
    tenant_id: dev.tenantId, id: l.id, sale_id: s.id, line_no: l.line_no, product_id: l.product_id ?? null,
    barcode_scanned: l.barcode_scanned ?? null, description: l.description, quantity: l.quantity, unit_price_pence: l.unit_price_pence,
    price_level_id: l.price_level_id ?? null, is_pmp: l.is_pmp, pmp_price_pence: l.pmp_price_pence ?? null,
    line_discount_pence: l.line_discount_pence, promotion_id: l.promotion_id ?? null, promotion_discount_pence: l.promotion_discount_pence,
    line_total_pence: l.line_total_pence, vat_code: l.vat_code, vat_rate_percent: l.vat_rate_percent, vat_pence: l.vat_pence,
    unit_cost_pence: l.unit_cost_pence ?? (l.product_id ? products.get(l.product_id)?.avg_cost_pence ?? null : null),
    age_check_id: l.age_check_id ?? null, is_voided: l.is_voided, voided_by: l.voided_by ?? null, void_reason: l.void_reason ?? null,
    added_at: l.added_at ? new Date(l.added_at) : new Date(at),
  })) as never)}`;
  if (s.approvals.length) {
    await tx`INSERT INTO pos_approvals ${tx(s.approvals.map((a) => ({
      tenant_id: dev.tenantId, id: a.id, branch_id: dev.branchId, device_id: dev.deviceId, sale_id: s.id,
      sale_line_id: a.sale_line_id ?? null, action_code: a.action_code, requested_by: a.requested_by, approved_by: a.approved_by ?? null,
      outcome: a.outcome, value: a.value ?? null, reason: a.reason ?? null, occurred_at: new Date(a.occurred_at),
    })) as never)}`;
  }
  if (s.discounts.length) {
    await tx`INSERT INTO sale_discounts ${tx(s.discounts.map((d) => ({
      tenant_id: dev.tenantId, id: d.id, sale_id: s.id, sale_line_id: d.sale_line_id ?? null, discount_type: d.discount_type,
      percent: d.percent ?? null, amount_pence: d.amount_pence, reason_code: d.reason_code ?? null, staff_id: d.staff_id,
      approval_id: d.approval_id ?? null,
    })) as never)}`;
  }
  if (s.payments.length) {
    await tx`INSERT INTO sale_payments ${tx(s.payments.map((p) => ({
      tenant_id: dev.tenantId, id: p.id, sale_id: s.id, method: p.method, amount_pence: p.amount_pence,
      tendered_pence: p.tendered_pence ?? null, change_pence: p.change_pence ?? null, provider: p.provider ?? null,
      provider_txn_ref: p.provider_txn_ref ?? null, card_brand: p.card_brand ?? null, card_last4: p.card_last4 ?? null,
      auth_code: p.auth_code ?? null, status: p.status, occurred_at: new Date(p.occurred_at),
    })) as never)}`;
  }

  // -- side effects. Training-mode sales never touch stock, loyalty or reports.
  if (s.status === 'completed' && !s.is_training) {
    const movements: MovementInput[] = [];
    for (const l of s.lines) {
      const p = l.product_id ? products.get(l.product_id) : undefined;
      if (l.is_voided || !p?.track_stock) continue;
      movements.push({
        branchId: dev.branchId, productId: p.id, quantity: -l.quantity, movementType: 'sale',
        unitCostPence: l.unit_cost_pence ?? p.avg_cost_pence, referenceType: 'sale', referenceId: s.id,
        staffId: s.staff_id, deviceId: dev.deviceId, occurredAt: at,
      });
    }
    await postMovements(tx, dev.tenantId, movements);

    if (s.customer_id) {
      const points = Math.floor(s.total_pence / 100); // 1 point per whole £1
      if (points > 0) {
        await tx`INSERT INTO loyalty_transactions (tenant_id, customer_id, points, reason, sale_id, staff_id)
                 VALUES (${dev.tenantId}, ${s.customer_id}, ${points}, 'earn', ${s.id}, ${s.staff_id})`;
        await tx`UPDATE customers SET loyalty_points = loyalty_points + ${points} WHERE id = ${s.customer_id}`;
      }
    }
    await enqueueEvent(tx, dev.tenantId, 'sale.completed', 'sale', s.id, {
      sale_id: s.id, branch_id: dev.branchId, total_pence: s.total_pence, completed_at: s.completed_at,
    });
  }
  return 'created';
}

/** Validates and stores ONE refund from a device (idempotent). */
export async function ingestRefund(tx: Tx, dev: DeviceContext, r: RefundPayload): Promise<'created' | 'duplicate'> {
  const [exists] = await tx`SELECT 1 FROM refunds WHERE id = ${r.id}`;
  if (exists) return 'duplicate';
  const cache = new ActorCache(tx);
  const actor = await cache.require(r.staff_id, 'pos.refund');

  const total = r.lines.reduce((a, l) => a + l.amount_pence, 0);
  const vat = r.lines.reduce((a, l) => a + l.vat_pence, 0);
  if (total !== r.total_pence || vat !== r.vat_pence) throw unprocessable('Refund totals do not match its lines', { total, vat });

  let sale: { id: string; branch_id: string; status: string; is_training: boolean; completed_at: string } | undefined;
  const saleLines = new Map<string, { id: string; product_id: string | null; quantity: number; line_total_pence: number;
    vat_code: string; vat_rate_percent: number; refunded_qty: number; is_voided: boolean }>();
  if (r.original_sale_id) {
    [sale] = await tx`SELECT id, branch_id, status, is_training, completed_at FROM sales WHERE id = ${r.original_sale_id} FOR UPDATE`;
    if (!sale) throw unprocessable('Original sale not found');
    if (sale.is_training) throw unprocessable('Training sales cannot be refunded');
    if (!['completed', 'partially_refunded'].includes(sale.status)) throw conflict(`Sale is ${sale.status}`);
    const rows = await tx<{ id: string; product_id: string | null; quantity: number; line_total_pence: number; vat_code: string;
      vat_rate_percent: number; refunded_qty: number; is_voided: boolean }[]>`
      SELECT sl.id, sl.product_id, sl.quantity, sl.line_total_pence, sl.vat_code, sl.vat_rate_percent, sl.is_voided,
             COALESCE((SELECT sum(rl.quantity) FROM refund_lines rl WHERE rl.tenant_id = sl.tenant_id AND rl.sale_line_id = sl.id), 0) AS refunded_qty
      FROM sale_lines sl WHERE sl.sale_id = ${r.original_sale_id}`;
    for (const row of rows) saleLines.set(row.id, row);
  }

  // Unreceipted refunds always need a manager; receipted ones only when over the limit.
  const overLimit = !r.original_sale_id || (!actor.isOwner &&
    (actor.limits.get('pos.refund.max_amount_pence') ?? -1) < r.total_pence);
  if (!r.original_sale_id) await cache.require(r.staff_id, 'pos.refund_unreceipted');
  if (r.approval) await checkApprovals(cache, [r.approval]);
  if (overLimit) {
    needApproved(new Map(r.approval ? [[r.approval.id, r.approval]] : []), r.approval?.id,
      r.original_sale_id ? 'pos.refund' : 'pos.refund_unreceipted', `Refund of ${r.total_pence}p`);
  }

  const movements: MovementInput[] = [];
  const productIds = [...new Set(r.lines.map((l) => l.product_id).filter((x): x is string => !!x))];
  const products = new Map((productIds.length ? await tx<{ id: string; track_stock: boolean; avg_cost_pence: number | null }[]>`
    SELECT id, track_stock, avg_cost_pence FROM products WHERE id IN ${tx(productIds)}` : []).map((p) => [p.id, p]));
  for (const l of r.lines) {
    let rate: number;
    let productId = l.product_id ?? null;
    if (r.original_sale_id) {
      const sl = l.sale_line_id ? saleLines.get(l.sale_line_id) : undefined;
      if (!sl || sl.is_voided) throw unprocessable('Each refund line must point at a line of the original sale');
      if (sl.refunded_qty + l.quantity > sl.quantity + 1e-9) throw conflict(`Only ${sl.quantity - sl.refunded_qty} left to refund on that line`);
      const maxAmount = Math.ceil((sl.line_total_pence * l.quantity) / sl.quantity);
      if (l.amount_pence > maxAmount) throw unprocessable(`Refund line amount exceeds what was paid (${maxAmount}p)`);
      if (l.vat_code !== sl.vat_code) throw unprocessable('Refund VAT code must match the original sale line');
      rate = sl.vat_rate_percent;
      sl.refunded_qty += l.quantity;
      productId = sl.product_id;
    } else {
      rate = await vatRate(tx, l.vat_code, r.occurred_at);
    }
    if (l.vat_pence !== vatFromGross(l.amount_pence, rate)) throw unprocessable(`Refund line VAT must be ${vatFromGross(l.amount_pence, rate)}p`);
    if (productId && !products.has(productId)) {
      const [p] = await tx<{ id: string; track_stock: boolean; avg_cost_pence: number | null }[]>`
        SELECT id, track_stock, avg_cost_pence FROM products WHERE id = ${productId}`;
      if (!p) throw unprocessable('Unknown product on refund line');
      products.set(p.id, p);
    }
    const p = productId ? products.get(productId) : undefined;
    l.product_id = productId;
    if (p?.track_stock) {
      const base = { branchId: dev.branchId, productId: p.id, unitCostPence: p.avg_cost_pence, referenceType: 'refund',
        referenceId: r.id, staffId: r.staff_id, deviceId: dev.deviceId, occurredAt: r.occurred_at };
      movements.push({ ...base, quantity: l.quantity, movementType: 'refund' });
      // Damaged returns come back in and straight out as waste, so waste reports stay honest.
      if (!l.restock) movements.push({ ...base, quantity: -l.quantity, movementType: 'waste', reasonCode: 'damaged', reason: 'Returned damaged' });
    }
  }

  if (r.till_session_id) {
    const [ts] = await tx<{ branch_id: string }[]>`SELECT branch_id FROM till_sessions WHERE id = ${r.till_session_id}`;
    if (!ts || ts.branch_id !== dev.branchId) throw unprocessable('Unknown till session for this branch');
  }
  if (r.approval) {
    await tx`
      INSERT INTO pos_approvals (tenant_id, id, branch_id, device_id, sale_id, action_code, requested_by, approved_by, outcome, value, reason, occurred_at)
      VALUES (${dev.tenantId}, ${r.approval.id}, ${dev.branchId}, ${dev.deviceId}, ${r.original_sale_id ?? null}, ${r.approval.action_code},
              ${r.approval.requested_by}, ${r.approval.approved_by ?? null}, ${r.approval.outcome}, ${r.approval.value ?? r.total_pence},
              ${r.approval.reason ?? null}, ${new Date(r.approval.occurred_at)})
      ON CONFLICT (tenant_id, id) DO NOTHING`;
  }
  const inserted = await tx`
    INSERT INTO refunds (tenant_id, id, branch_id, original_sale_id, till_session_id, device_id, staff_id, approval_id, reason_code,
                         reason, refund_method, total_pence, vat_pence, occurred_at)
    VALUES (${dev.tenantId}, ${r.id}, ${dev.branchId}, ${r.original_sale_id ?? null}, ${r.till_session_id ?? null}, ${dev.deviceId},
            ${r.staff_id}, ${r.approval?.id ?? null}, ${r.reason_code}, ${r.reason ?? null}, ${r.refund_method}, ${r.total_pence},
            ${r.vat_pence}, ${new Date(r.occurred_at)})
    ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`;
  if (inserted.length === 0) return 'duplicate';
  await tx`INSERT INTO refund_lines ${tx(r.lines.map((l) => ({
    tenant_id: dev.tenantId, id: l.id, refund_id: r.id, sale_line_id: l.sale_line_id ?? null, product_id: l.product_id ?? null,
    quantity: l.quantity, amount_pence: l.amount_pence, vat_code: l.vat_code, vat_pence: l.vat_pence, restock: l.restock,
  })) as never)}`;
  await postMovements(tx, dev.tenantId, movements);

  if (sale) {
    const fully = [...saleLines.values()].filter((sl) => !sl.is_voided).every((sl) => sl.refunded_qty >= sl.quantity - 1e-9);
    await tx`UPDATE sales SET status = ${fully ? 'refunded' : 'partially_refunded'} WHERE id = ${sale.id}`;
  }
  await enqueueEvent(tx, dev.tenantId, 'refund.created', 'refund', r.id, {
    refund_id: r.id, branch_id: dev.branchId, total_pence: r.total_pence, original_sale_id: r.original_sale_id ?? null,
  });
  return 'created';
}

export function toOutcome(id: string, err: unknown): SyncOutcome {
  if (err instanceof HttpError) return { id, status: 'rejected', error: err.code, message: err.message, details: err.details };
  const pg = err as { code?: string; message?: string; constraint_name?: string };
  if (pg?.code === '23505') return { id, status: 'rejected', error: 'duplicate', message: 'Receipt number or id already used', details: { constraint: pg.constraint_name } };
  if (pg?.code?.startsWith('23')) return { id, status: 'rejected', error: 'constraint', message: pg.message ?? 'Constraint violated', details: { constraint: pg.constraint_name } };
  throw err;
}
