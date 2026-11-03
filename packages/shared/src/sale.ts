import { apportion, lineAmount, vatFromGross } from './money.ts';

/**
 * Builds the sale payload for POST /v1/sync/push. This is THE implementation
 * of the sale arithmetic: the till uses it offline and the server validates
 * against the same rules (apps/api/src/services/sync.ts). Keep them in step.
 */

export type VatCode = 'S' | 'R' | 'Z' | 'E';

export interface BasketLine {
  id: string;                      // uuidv7, generated when the item is added
  productId: string | null;
  description: string;
  barcode: string | null;
  quantity: number;                // base units (case = N units; weighed = kg)
  unitPricePence: number;          // after PMP cap
  vatCode: VatCode;
  vatRatePercent: number;
  isPmp: boolean;
  pmpPricePence: number | null;
  lineDiscountPence?: number;      // manual line discount (not basket share)
  promotionId?: string | null;
  promotionDiscountPence?: number;
  unitCostPence?: number | null;
  ageCheckId?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
  addedAt?: string;
}

export interface PricedLine {
  line: BasketLine;
  base: number;                    // round(unit price × qty)
  basketShare: number;             // this line's part of the basket discount
  lineDiscount: number;            // manual + basket share
  promotionDiscount: number;
  total: number;
  vat: number;
}

export interface BasketTotals {
  subtotal: number;
  discount: number;
  total: number;
  vat: number;
  items: number;
  vatByCode: Record<string, { gross: number; vat: number }>;
}

export function priceBasket(lines: BasketLine[], basketDiscountPence = 0): { priced: PricedLine[]; totals: BasketTotals } {
  const live = lines.filter((l) => !l.voidedBy);
  const weights = live.map((l) => Math.max(lineAmount(l.unitPricePence, l.quantity) - (l.lineDiscountPence ?? 0) - (l.promotionDiscountPence ?? 0), 0));
  const maxBasket = weights.reduce((a, b) => a + b, 0);
  const shares = basketDiscountPence > 0 ? apportion(Math.min(basketDiscountPence, maxBasket), weights) : live.map(() => 0);
  let i = 0;
  const priced = lines.map((line) => {
    const base = lineAmount(line.unitPricePence, line.quantity);
    const basketShare = line.voidedBy ? 0 : shares[i++] ?? 0;
    const lineDiscount = (line.lineDiscountPence ?? 0) + basketShare;
    const promotionDiscount = line.promotionDiscountPence ?? 0;
    const total = Math.max(base - lineDiscount - promotionDiscount, 0);
    return { line, base, basketShare, lineDiscount, promotionDiscount, total, vat: vatFromGross(total, line.vatRatePercent) };
  });
  const totals: BasketTotals = { subtotal: 0, discount: 0, total: 0, vat: 0, items: 0, vatByCode: {} };
  for (const p of priced) {
    if (p.line.voidedBy) continue;
    totals.subtotal += p.base;
    totals.discount += p.lineDiscount + p.promotionDiscount;
    totals.total += p.total;
    totals.vat += p.vat;
    totals.items += p.line.quantity;
    const v = (totals.vatByCode[p.line.vatCode] ??= { gross: 0, vat: 0 });
    v.gross += p.total;
    v.vat += p.vat;
  }
  totals.items = Math.round(totals.items * 1000) / 1000;
  return { priced, totals };
}

export interface PaymentInput {
  id: string;
  method: 'cash' | 'card' | 'voucher' | 'loyalty_points' | 'account' | 'online_platform' | 'gift_card';
  amountPence: number;
  tenderedPence?: number | null;
  changePence?: number | null;
  provider?: string | null;
  providerTxnRef?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  authCode?: string | null;
  status?: 'approved' | 'declined' | 'voided';
  occurredAt: string;
}

export interface DiscountRecord {
  id: string;
  saleLineId: string | null;       // null = basket discount
  type: 'percent' | 'amount' | 'price_override';
  percent: number | null;
  amountPence: number;
  reasonCode: string | null;
  staffId: string;
  approvalId: string | null;
}

export interface ApprovalRecord {
  id: string;
  saleLineId?: string | null;
  actionCode: string;
  requestedBy: string;
  approvedBy: string | null;
  outcome: 'self_authorised' | 'approved' | 'denied';
  value?: number | null;
  reason?: string | null;
  occurredAt: string;
}

export interface AgeCheckRecord {
  id: string;
  productId: string | null;
  staffId: string;
  requiredAge: number;
  outcome: 'looked_over_25' | 'id_checked_ok' | 'refused' | 'id_not_available';
  occurredAt: string;
}

export interface SaleInput {
  id: string;
  receiptNumber: string;
  staffId: string;
  tillSessionId?: string | null;
  customerId?: string | null;
  priceLevelId?: string | null;
  isTraining?: boolean;
  status?: 'completed' | 'voided';
  lines: BasketLine[];
  basketDiscountPence?: number;
  payments: PaymentInput[];
  discounts?: DiscountRecord[];
  approvals?: ApprovalRecord[];
  ageChecks?: AgeCheckRecord[];
  startedAt?: string | null;
  completedAt?: string | null;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
}

/** Wire format accepted by POST /v1/sync/push (snake_case, matches the DB). */
export function buildSalePayload(s: SaleInput) {
  const { priced, totals } = priceBasket(s.lines, s.basketDiscountPence ?? 0);
  const at = s.completedAt ?? s.voidedAt ?? new Date().toISOString();
  return {
    id: s.id,
    till_session_id: s.tillSessionId ?? null,
    staff_id: s.staffId,
    customer_id: s.customerId ?? null,
    price_level_id: s.priceLevelId ?? null,
    channel: 'pos' as const,
    receipt_number: s.receiptNumber,
    status: s.status ?? 'completed',
    is_training: s.isTraining ?? false,
    subtotal_pence: totals.subtotal,
    discount_pence: totals.discount,
    total_pence: totals.total,
    vat_pence: totals.vat,
    started_at: s.startedAt ?? at,
    completed_at: s.status === 'voided' ? null : at,
    voided_at: s.voidedAt ?? null,
    voided_by: s.voidedBy ?? null,
    void_reason: s.voidReason ?? null,
    lines: priced.map((p, idx) => ({
      id: p.line.id,
      line_no: idx + 1,
      product_id: p.line.productId,
      barcode_scanned: p.line.barcode,
      description: p.line.description,
      quantity: p.line.quantity,
      unit_price_pence: p.line.unitPricePence,
      is_pmp: p.line.isPmp,
      pmp_price_pence: p.line.pmpPricePence,
      line_discount_pence: p.lineDiscount,
      promotion_id: p.line.promotionId ?? null,
      promotion_discount_pence: p.promotionDiscount,
      line_total_pence: p.total,
      vat_code: p.line.vatCode,
      vat_rate_percent: p.line.vatRatePercent,
      vat_pence: p.vat,
      unit_cost_pence: p.line.unitCostPence ?? null,
      age_check_id: p.line.ageCheckId ?? null,
      is_voided: !!p.line.voidedBy,
      voided_by: p.line.voidedBy ?? null,
      void_reason: p.line.voidReason ?? null,
      added_at: p.line.addedAt ?? at,
    })),
    payments: s.payments.map((p) => ({
      id: p.id, method: p.method, amount_pence: p.amountPence, tendered_pence: p.tenderedPence ?? null,
      change_pence: p.changePence ?? null, provider: p.provider ?? null, provider_txn_ref: p.providerTxnRef ?? null,
      card_brand: p.cardBrand ?? null, card_last4: p.cardLast4 ?? null, auth_code: p.authCode ?? null,
      status: p.status ?? 'approved', occurred_at: p.occurredAt,
    })),
    discounts: (s.discounts ?? []).map((d) => ({
      id: d.id, sale_line_id: d.saleLineId, discount_type: d.type, percent: d.percent, amount_pence: d.amountPence,
      reason_code: d.reasonCode, staff_id: d.staffId, approval_id: d.approvalId,
    })),
    approvals: (s.approvals ?? []).map((a) => ({
      id: a.id, sale_line_id: a.saleLineId ?? null, action_code: a.actionCode, requested_by: a.requestedBy,
      approved_by: a.approvedBy, outcome: a.outcome, value: a.value ?? null, reason: a.reason ?? null, occurred_at: a.occurredAt,
    })),
    age_checks: (s.ageChecks ?? []).map((a) => ({
      id: a.id, product_id: a.productId, staff_id: a.staffId, required_age: a.requiredAge, outcome: a.outcome, occurred_at: a.occurredAt,
    })),
  };
}
export type SalePayload = ReturnType<typeof buildSalePayload>;

/** Smallest UK note/coin amounts at or above `total`, for quick-cash buttons. */
export function quickCashOptions(totalPence: number): number[] {
  const notes = [500, 1000, 2000, 5000];
  const opts = new Set<number>([totalPence]);
  opts.add(Math.ceil(totalPence / 100) * 100);
  for (const n of notes) if (n >= totalPence) opts.add(Math.ceil(totalPence / n) * n);
  return [...opts].filter((v) => v >= totalPence).sort((a, b) => a - b).slice(0, 4);
}
