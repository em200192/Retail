import { uuidv7, vatFromGross, type VatCode } from '@retail/shared';

/** The parts of GET /v1/sales/:id the refund screen uses. */
export interface SaleDetail {
  id: string;
  receipt_number: string;
  status: string;
  is_training: boolean;
  total_pence: number;
  completed_at: string | null;
  lines: {
    id: string; line_no: number; product_id: string | null; description: string; quantity: number; unit_price_pence: number;
    line_total_pence: number; vat_code: VatCode; vat_rate_percent: number; is_voided: boolean;
  }[];
  refunds: { lines: { sale_line_id: string | null; quantity: number; amount_pence: number }[] }[];
}

export interface RefundableLine {
  saleLineId: string;
  productId: string | null;
  description: string;
  soldQty: number;
  refundedQty: number;
  refundedPence: number;
  remainingQty: number;
  lineTotalPence: number;
  vatCode: VatCode;
  vatRatePercent: number;
}

export function refundableLines(sale: SaleDetail): RefundableLine[] {
  return sale.lines.filter((l) => !l.is_voided).map((l) => {
    let qty = 0, pence = 0;
    for (const r of sale.refunds ?? []) for (const rl of r.lines ?? []) {
      if (rl.sale_line_id === l.id) { qty += Number(rl.quantity); pence += Number(rl.amount_pence); }
    }
    qty = Math.round(qty * 1000) / 1000;
    return {
      saleLineId: l.id, productId: l.product_id, description: l.description, soldQty: Number(l.quantity), refundedQty: qty,
      refundedPence: pence, remainingQty: Math.max(0, Math.round((Number(l.quantity) - qty) * 1000) / 1000),
      lineTotalPence: l.line_total_pence, vatCode: l.vat_code, vatRatePercent: Number(l.vat_rate_percent),
    };
  });
}

/**
 * What to refund for `qty` of a line: the paid line total pro rata. The
 * server caps each refund line at ceil(line_total × qty / sold_qty); the final
 * refund of a line returns whatever is left so the pennies add up.
 */
export function refundAmount(line: RefundableLine, qty: number): number {
  if (!(qty > 0) || qty > line.remainingQty + 1e-9) throw new RangeError('quantity is more than can be refunded');
  const cap = Math.ceil((line.lineTotalPence * qty) / line.soldQty);
  if (Math.abs(qty - line.remainingQty) < 1e-9) return Math.min(line.lineTotalPence - line.refundedPence, cap);
  return Math.min(Math.floor((line.lineTotalPence * qty) / line.soldQty), cap);
}

export interface RefundPick { line: RefundableLine; qty: number; restock: boolean }

export function buildRefundPayload(opts: {
  saleId: string | null; tillSessionId: string | null; staffId: string; reasonCode: string; reason?: string | null;
  method: 'cash' | 'card'; picks: RefundPick[]; approval?: Record<string, unknown> | null; occurredAt?: string;
}) {
  const lines = opts.picks.filter((p) => p.qty > 0).map((p) => {
    const amount = refundAmount(p.line, p.qty);
    return {
      id: uuidv7(), sale_line_id: p.line.saleLineId, product_id: p.line.productId, quantity: p.qty, amount_pence: amount,
      vat_code: p.line.vatCode, vat_pence: vatFromGross(amount, p.line.vatRatePercent), restock: p.restock,
    };
  });
  if (lines.length === 0) throw new RangeError('pick at least one item to refund');
  return {
    id: uuidv7(),
    original_sale_id: opts.saleId,
    till_session_id: opts.tillSessionId,
    staff_id: opts.staffId,
    approval: opts.approval ?? null,
    reason_code: opts.reasonCode,
    reason: opts.reason ?? null,
    refund_method: opts.method,
    total_pence: lines.reduce((a, l) => a + l.amount_pence, 0),
    vat_pence: lines.reduce((a, l) => a + l.vat_pence, 0),
    occurred_at: opts.occurredAt ?? new Date().toISOString(),
    lines,
  };
}
export type RefundPayload = ReturnType<typeof buildRefundPayload>;
