import { buildSalePayload, lineAmount, uuidv7, vatFromGross } from '@retail/shared';
import { describe, expect, it } from 'vitest';
import {
  addAgeCheck, addItem, type Basket, discountRecords, newBasket, passingAgeCheck, priceOf, setBasketDiscount, setLineDiscount,
  setQuantity, toSaleInput, voidLine,
} from '../src/logic/basket.ts';
import { discountDecision, eligibleApprovers } from '../src/logic/permissions.ts';
import { resolveScan, type ScannedItem } from '../src/logic/pricing.ts';
import { catalog } from './fixtures.ts';

const c = catalog();
const scan = (code: string) => resolveScan(c, code, { priceLevelId: null }) as ScannedItem;
const sam = c.staff.find((s) => s.id === 'sam')!;

/** The same arithmetic checks apps/api/src/services/sync.ts runs on a pushed sale. */
function serverChecks(p: ReturnType<typeof buildSalePayload>) {
  let subtotal = 0, discount = 0, total = 0, vat = 0;
  for (const l of p.lines) {
    const base = lineAmount(l.unit_price_pence, l.quantity);
    expect(l.line_total_pence).toBe(base - l.line_discount_pence - l.promotion_discount_pence);
    expect(l.vat_pence).toBe(vatFromGross(l.line_total_pence, l.vat_rate_percent));
    if (l.is_pmp) expect(l.unit_price_pence).toBeLessThanOrEqual(l.pmp_price_pence!);
    if (l.is_voided) continue;
    subtotal += base; discount += l.line_discount_pence + l.promotion_discount_pence; total += l.line_total_pence; vat += l.vat_pence;
  }
  expect({ subtotal, discount, total, vat }).toEqual({ subtotal: p.subtotal_pence, discount: p.discount_pence, total: p.total_pence, vat: p.vat_pence });
  const manual = p.discounts.reduce((a, d) => a + d.amount_pence, 0);
  const lineDisc = p.lines.filter((l) => !l.is_voided).reduce((a, l) => a + l.line_discount_pence, 0);
  expect(manual).toBe(lineDisc);
  for (const d of p.discounts) expect(d.amount_pence).toBeGreaterThan(0);
  expect(p.payments.filter((x) => x.status === 'approved').reduce((a, x) => a + x.amount_pence, 0)).toBe(p.total_pence);
}

function pay(b: Basket) {
  const total = priceOf(b).totals.total;
  const at = new Date().toISOString();
  return buildSalePayload(toSaleInput(b, {
    receiptNumber: 'MAN1-1-7', staffId: 'sam', tillSessionId: null, isTraining: false, completedAt: at,
    payments: total > 0 ? [{ id: uuidv7(), method: 'cash', amountPence: total, tenderedPence: 2000, changePence: 2000 - total, occurredAt: at }] : [],
  }));
}

describe('basket', () => {
  it('merges a repeat scan of the same item into one line', () => {
    let b = newBasket();
    b = addItem(b, scan('5449000000996')).basket;
    b = addItem(b, scan('5449000000996')).basket;
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]!.quantity).toBe(2);
    expect(priceOf(b).totals.total).toBe(330);
  });

  it('keeps voided lines on the sale but does not charge them', () => {
    let b = newBasket();
    const r = addItem(b, scan('5000000000042'));
    b = addItem(r.basket, scan('5449000000996')).basket;
    b = voidLine(b, r.lineId, 'sam', 'Customer changed mind');
    const p = pay(b);
    expect(p.lines[0]).toMatchObject({ is_voided: true, voided_by: 'sam' });
    expect(p.total_pence).toBe(165);
    serverChecks(p);
  });

  it('builds a payload the server accepts: line + basket discounts, PMP, weighed goods', () => {
    let b = newBasket();
    const milk = addItem(b, scan('5000000000042'));
    b = setQuantity(milk.basket, milk.lineId, 3);
    b = addItem(b, scan('5449000000996')).basket;
    b = addItem(b, scan('2112345004551')).basket;
    b = setLineDiscount(b, milk.lineId, { id: uuidv7(), type: 'percent', value: 10, staffId: 'sam', approvalId: null, reasonCode: 'damaged' });
    b = setBasketDiscount(b, { id: uuidv7(), type: 'amount', value: 50, staffId: 'sam', approvalId: null, reasonCode: null });
    const p = pay(b);
    serverChecks(p);
    expect(p.lines[0]!.line_discount_pence).toBeGreaterThan(57); // 10% of 567 = 57 + its share of the 50p
    expect(p.discounts).toHaveLength(2);
    expect(p.discounts.find((d) => d.sale_line_id === null)!.amount_pence).toBe(50);
    expect(p.lines[2]).toMatchObject({ quantity: 0.455, unit_price_pence: 1200, line_total_pence: expect.any(Number) });
  });

  it('caps the basket discount at the basket value and drops records of voided lines', () => {
    let b = newBasket();
    const r = addItem(b, scan('5000000000042'));
    b = setLineDiscount(r.basket, r.lineId, { id: uuidv7(), type: 'amount', value: 20, staffId: 'sam', approvalId: null, reasonCode: null });
    b = addItem(b, scan('5449000000996')).basket;
    b = voidLine(b, r.lineId, 'sam', 'mistake');
    b = setBasketDiscount(b, { id: uuidv7(), type: 'amount', value: 10_000, staffId: 'owner', approvalId: null, reasonCode: null });
    expect(discountRecords(b)).toHaveLength(1);
    const p = pay(b);
    expect(p.total_pence).toBe(0);
    serverChecks(p);
  });

  it('reuses one passed Challenge 25 check for the rest of the sale', () => {
    let b = newBasket();
    expect(passingAgeCheck(b, 18)).toBeNull();
    b = addAgeCheck(b, { id: 'x', productId: null, staffId: 'sam', requiredAge: 18, outcome: 'refused', occurredAt: '' });
    expect(passingAgeCheck(b, 18)).toBeNull();
    b = addAgeCheck(b, { id: 'y', productId: null, staffId: 'sam', requiredAge: 18, outcome: 'looked_over_25', occurredAt: '' });
    expect(passingAgeCheck(b, 18)).toBe('y');
    expect(passingAgeCheck(b, 21)).toBeNull();
  });
});

describe('limits on the device', () => {
  it('needs approval for a cashier discount over 5% or £1', () => {
    expect(discountDecision(sam, 5, 50)).toBe('self_authorised');
    expect(discountDecision(sam, 10, 50)).toBe('needs_approval');
    expect(discountDecision(sam, 5, 150)).toBe('needs_approval');
    expect(discountDecision(c.staff.find((s) => s.id === 'owner')!, 100, 99999)).toBe('self_authorised');
  });

  it('lists approvers who hold pos.approve, are not the requester and are within their own cap', () => {
    expect(eligibleApprovers(c.staff, 'sam', 'pos.discount', { code: 'pos.discount.max_percent', value: 20 }).map((s) => s.id)).toEqual(['owner', 'mo']);
    expect(eligibleApprovers(c.staff, 'sam', 'pos.discount', { code: 'pos.discount.max_percent', value: 60 }).map((s) => s.id)).toEqual(['owner']);
    expect(eligibleApprovers(c.staff, 'mo', 'pos.discount').map((s) => s.id)).toEqual(['owner']);
  });
});
