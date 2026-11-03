import type { Tx } from '../lib/db.ts';

export interface ZReport {
  till_session_id: string;
  generated_at: string;
  opening_float_pence: number;
  sales: { count: number; gross_pence: number; discounts_pence: number; net_pence: number; vat_pence: number; items: number };
  voided_sales: { count: number; value_pence: number };
  voided_lines: { count: number; value_pence: number };
  payments: Record<string, number>;
  refunds: { count: number; total_pence: number; by_method: Record<string, number> };
  cash_movements: Record<string, { count: number; amount_pence: number }>;
  vat_by_code: Record<string, { gross_pence: number; vat_pence: number; net_pence: number }>;
  expected_cash_pence: number;
}

/** End-of-day snapshot for one till session. Training sales are excluded. */
export async function computeZReport(tx: Tx, sessionId: string): Promise<ZReport> {
  const [session] = await tx<{ opening_float_pence: number }[]>`
    SELECT opening_float_pence FROM till_sessions WHERE id = ${sessionId}`;
  const [s] = await tx<{ count: number; gross: number; disc: number; net: number; vat: number; items: number }[]>`
    SELECT count(*)::int AS count, COALESCE(sum(subtotal_pence),0) AS gross, COALESCE(sum(discount_pence),0) AS disc,
           COALESCE(sum(total_pence),0) AS net, COALESCE(sum(vat_pence),0) AS vat, COALESCE(sum(item_count),0) AS items
    FROM sales WHERE till_session_id = ${sessionId} AND NOT is_training
      AND status IN ('completed','partially_refunded','refunded')`;
  const [v] = await tx<{ count: number; value: number }[]>`
    SELECT count(*)::int AS count, COALESCE(sum(total_pence),0) AS value
    FROM sales WHERE till_session_id = ${sessionId} AND NOT is_training AND status = 'voided'`;
  const [vl] = await tx<{ count: number; value: number }[]>`
    SELECT count(*)::int AS count, COALESCE(sum(sl.line_total_pence),0) AS value
    FROM sale_lines sl JOIN sales s ON s.tenant_id = sl.tenant_id AND s.id = sl.sale_id
    WHERE s.till_session_id = ${sessionId} AND NOT s.is_training AND sl.is_voided`;
  const payments = await tx<{ method: string; amount: number }[]>`
    SELECT p.method, sum(p.amount_pence) AS amount
    FROM sale_payments p JOIN sales s ON s.tenant_id = p.tenant_id AND s.id = p.sale_id
    WHERE s.till_session_id = ${sessionId} AND NOT s.is_training AND p.status = 'approved'
      AND s.status IN ('completed','partially_refunded','refunded')
    GROUP BY p.method`;
  const refunds = await tx<{ method: string; count: number; total: number }[]>`
    SELECT refund_method AS method, count(*)::int AS count, sum(total_pence) AS total
    FROM refunds WHERE till_session_id = ${sessionId} GROUP BY refund_method`;
  const cash = await tx<{ movement_type: string; count: number; amount: number }[]>`
    SELECT movement_type, count(*)::int AS count, COALESCE(sum(amount_pence),0) AS amount
    FROM cash_movements WHERE till_session_id = ${sessionId} GROUP BY movement_type`;
  const vat = await tx<{ vat_code: string; gross: number; vat: number }[]>`
    SELECT sl.vat_code, sum(sl.line_total_pence) AS gross, sum(sl.vat_pence) AS vat
    FROM sale_lines sl JOIN sales s ON s.tenant_id = sl.tenant_id AND s.id = sl.sale_id
    WHERE s.till_session_id = ${sessionId} AND NOT s.is_training AND NOT sl.is_voided
      AND s.status IN ('completed','partially_refunded','refunded')
    GROUP BY sl.vat_code ORDER BY sl.vat_code`;

  const payMap = Object.fromEntries(payments.map((p) => [p.method, p.amount]));
  const cashMap = Object.fromEntries(cash.map((c) => [c.movement_type, { count: c.count, amount_pence: c.amount }]));
  const refundByMethod = Object.fromEntries(refunds.map((r) => [r.method, r.total]));
  const amt = (k: string) => cashMap[k]?.amount_pence ?? 0;
  const expected = (session?.opening_float_pence ?? 0) + (payMap.cash ?? 0) - (refundByMethod.cash ?? 0)
    + amt('paid_in') + amt('float_adjust') - amt('paid_out') - amt('cash_drop');

  return {
    till_session_id: sessionId,
    generated_at: new Date().toISOString(),
    opening_float_pence: session?.opening_float_pence ?? 0,
    sales: { count: s!.count, gross_pence: s!.gross, discounts_pence: s!.disc, net_pence: s!.net, vat_pence: s!.vat, items: s!.items },
    voided_sales: { count: v!.count, value_pence: v!.value },
    voided_lines: { count: vl!.count, value_pence: vl!.value },
    payments: payMap,
    refunds: {
      count: refunds.reduce((a, r) => a + r.count, 0), total_pence: refunds.reduce((a, r) => a + r.total, 0), by_method: refundByMethod,
    },
    cash_movements: cashMap,
    vat_by_code: Object.fromEntries(vat.map((r) => [r.vat_code, { gross_pence: r.gross, vat_pence: r.vat, net_pence: r.gross - r.vat }])),
    expected_cash_pence: expected,
  };
}
