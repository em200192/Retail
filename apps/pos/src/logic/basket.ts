import {
  type AgeCheckRecord, type ApprovalRecord, type BasketLine, type DiscountRecord, lineAmount, type PaymentInput,
  percentOf, priceBasket, type SaleInput, uuidv7,
} from '@retail/shared';
import type { ScannedItem } from './pricing.ts';

export interface DiscountSpec {
  id: string;                 // the sale_discounts record id
  type: 'percent' | 'amount';
  value: number;              // percent (e.g. 10) or pence
  staffId: string;
  approvalId: string | null;
  reasonCode: string | null;
}

export interface TillLine extends BasketLine {
  discount: DiscountSpec | null;
  minAge: number | null;
  embedded: 'price' | 'weight' | null;
  unitType: string;
}

export interface Basket {
  saleId: string;
  startedAt: string;
  priceLevelId: string | null;
  lines: TillLine[];
  basketDiscount: DiscountSpec | null;
  approvals: ApprovalRecord[];
  ageChecks: AgeCheckRecord[];
}

export function newBasket(now = new Date()): Basket {
  return { saleId: uuidv7(now.getTime()), startedAt: now.toISOString(), priceLevelId: null, lines: [], basketDiscount: null, approvals: [], ageChecks: [] };
}

export const liveLines = (b: Basket) => b.lines.filter((l) => !l.voidedBy);
export const isEmpty = (b: Basket) => liveLines(b).length === 0;

/** Adds a scanned item. A repeat scan of the same plain item bumps the quantity instead of adding a line. */
export function addItem(b: Basket, item: ScannedItem, opts: { ageCheckId?: string | null; now?: Date } = {}): { basket: Basket; lineId: string } {
  const now = opts.now ?? new Date();
  const same = b.lines.find((l) => !l.voidedBy && !l.discount && !l.embedded && !item.embedded
    && l.productId === item.product.id && l.barcode === item.barcode && l.unitPricePence === item.unitPricePence);
  if (same) {
    return { basket: { ...b, lines: b.lines.map((l) => (l === same ? { ...l, quantity: roundQty(l.quantity + item.quantity) } : l)) }, lineId: same.id };
  }
  const line: TillLine = {
    id: uuidv7(now.getTime()),
    productId: item.product.id,
    description: item.product.name,
    barcode: item.barcode,
    quantity: item.quantity,
    unitPricePence: item.unitPricePence,
    vatCode: item.vatCode,
    vatRatePercent: item.vatRatePercent,
    isPmp: item.isPmp,
    pmpPricePence: item.pmpPricePence,
    unitCostPence: item.product.avg_cost_pence,
    ageCheckId: opts.ageCheckId ?? null,
    addedAt: now.toISOString(),
    discount: null,
    minAge: item.product.min_age,
    embedded: item.embedded,
    unitType: item.product.unit_type,
  };
  return { basket: { ...b, lines: [...b.lines, line] }, lineId: line.id };
}

const roundQty = (q: number) => Math.round(q * 1000) / 1000;

export function setQuantity(b: Basket, lineId: string, qty: number): Basket {
  if (!(qty > 0)) throw new RangeError('quantity must be > 0 (void the line instead)');
  return { ...b, lines: b.lines.map((l) => (l.id === lineId ? { ...l, quantity: roundQty(qty) } : l)) };
}

/** Voided lines stay on the sale (loss prevention) but are not charged. */
export function voidLine(b: Basket, lineId: string, staffId: string, reason: string): Basket {
  return { ...b, lines: b.lines.map((l) => (l.id === lineId ? { ...l, voidedBy: staffId, voidReason: reason, discount: null } : l)) };
}

export function removeLine(b: Basket, lineId: string): Basket {
  return { ...b, lines: b.lines.filter((l) => l.id !== lineId) };
}

export function setLineDiscount(b: Basket, lineId: string, spec: DiscountSpec | null): Basket {
  return { ...b, lines: b.lines.map((l) => (l.id === lineId ? { ...l, discount: spec } : l)) };
}

export function setBasketDiscount(b: Basket, spec: DiscountSpec | null): Basket {
  return { ...b, basketDiscount: spec };
}

export function addApproval(b: Basket, a: ApprovalRecord): Basket {
  return { ...b, approvals: [...b.approvals, a] };
}

export function addAgeCheck(b: Basket, a: AgeCheckRecord): Basket {
  return { ...b, ageChecks: [...b.ageChecks, a] };
}

/** One passed Challenge 25 check covers every restricted item of the same or lower age in this sale. */
export function passingAgeCheck(b: Basket, minAge: number): string | null {
  const ok = b.ageChecks.find((a) => (a.outcome === 'looked_over_25' || a.outcome === 'id_checked_ok') && a.requiredAge >= minAge);
  return ok?.id ?? null;
}

/** Manual line discount in pence for the line's current quantity, never more than the line itself. */
export function lineDiscountPence(l: TillLine): number {
  if (!l.discount || l.voidedBy) return 0;
  const base = lineAmount(l.unitPricePence, l.quantity);
  const amt = l.discount.type === 'percent' ? percentOf(base, l.discount.value) : l.discount.value;
  return Math.max(0, Math.min(amt, base));
}

/** Basket discount in pence, applied after line discounts. */
export function basketDiscountPence(b: Basket): number {
  const spec = b.basketDiscount;
  if (!spec) return 0;
  const after = liveLines(b).reduce((a, l) => a + lineAmount(l.unitPricePence, l.quantity) - lineDiscountPence(l), 0);
  const amt = spec.type === 'percent' ? percentOf(after, spec.value) : spec.value;
  return Math.max(0, Math.min(amt, after));
}

/** Lines in the shape the shared sale builder expects (line discount resolved to pence). */
export function wireLines(b: Basket): BasketLine[] {
  return b.lines.map((l) => {
    const { discount: _d, minAge: _m, embedded: _e, unitType: _u, ...rest } = l;
    return { ...rest, lineDiscountPence: lineDiscountPence(l) };
  });
}

export function priceOf(b: Basket) {
  return priceBasket(wireLines(b), basketDiscountPence(b));
}

/** The sale_discounts audit records. Their total must equal Σ line discounts (incl. basket shares). */
export function discountRecords(b: Basket): DiscountRecord[] {
  const out: DiscountRecord[] = [];
  for (const l of liveLines(b)) {
    const amt = lineDiscountPence(l);
    if (!l.discount || amt <= 0) continue;
    out.push({
      id: l.discount.id, saleLineId: l.id, type: l.discount.type, percent: l.discount.type === 'percent' ? l.discount.value : null,
      amountPence: amt, reasonCode: l.discount.reasonCode, staffId: l.discount.staffId, approvalId: l.discount.approvalId,
    });
  }
  const bd = b.basketDiscount;
  if (bd) {
    // The amount actually spread over the lines (priceBasket caps it at the basket value).
    const applied = priceOf(b).priced.reduce((a, p) => a + p.basketShare, 0);
    if (applied > 0) {
      out.push({ id: bd.id, saleLineId: null, type: bd.type, percent: bd.type === 'percent' ? bd.value : null, amountPence: applied,
        reasonCode: bd.reasonCode, staffId: bd.staffId, approvalId: bd.approvalId });
    }
  }
  return out;
}

/** Percent that a discount represents, the way the server evaluates it against limits. */
export function discountPercent(basePence: number, spec: Pick<DiscountSpec, 'type' | 'value'>, amountPence: number): number {
  if (spec.type === 'percent') return spec.value;
  return basePence > 0 ? (amountPence * 100) / basePence : 100;
}

export function toSaleInput(b: Basket, opts: {
  receiptNumber: string; staffId: string; tillSessionId: string | null; isTraining: boolean; payments: PaymentInput[]; completedAt: string;
}): SaleInput {
  return {
    id: b.saleId,
    receiptNumber: opts.receiptNumber,
    staffId: opts.staffId,
    tillSessionId: opts.tillSessionId,
    priceLevelId: b.priceLevelId,
    isTraining: opts.isTraining,
    lines: wireLines(b),
    basketDiscountPence: basketDiscountPence(b),
    payments: opts.payments,
    discounts: discountRecords(b),
    approvals: b.approvals,
    ageChecks: b.ageChecks,
    startedAt: b.startedAt,
    completedAt: opts.completedAt,
  };
}
