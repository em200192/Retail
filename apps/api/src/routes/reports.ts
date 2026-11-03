import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, tenantTx } from '../app.ts';
import { can, requireBranchAccess, requirePermission } from '../lib/authz.ts';
import type { Tx } from '../lib/db.ts';
import { conflict, unprocessable } from '../lib/errors.ts';
import { isoDate, parse, uuid } from '../lib/validate.ts';

const range = z.object({ branch_id: uuid, from: isoDate, to: isoDate });

/** MTD 9-box figures for a period, from the raw ledgers (not the dashboard aggregates). */
export async function computeVatBoxes(tx: Tx, from: string, to: string) {
  const [sales] = await tx<{ vat: number; gross: number }[]>`
    SELECT COALESCE(sum(sl.vat_pence),0) AS vat, COALESCE(sum(sl.line_total_pence),0) AS gross
    FROM sale_lines sl JOIN sales s ON s.tenant_id = sl.tenant_id AND s.id = sl.sale_id
    JOIN branches b ON b.tenant_id = s.tenant_id AND b.id = s.branch_id
    WHERE NOT s.is_training AND NOT sl.is_voided AND s.status IN ('completed','partially_refunded','refunded')
      AND (s.completed_at AT TIME ZONE b.timezone)::date BETWEEN ${from}::date AND ${to}::date`;
  const [refunds] = await tx<{ vat: number; gross: number }[]>`
    SELECT COALESCE(sum(r.vat_pence),0) AS vat, COALESCE(sum(r.total_pence),0) AS gross
    FROM refunds r JOIN branches b ON b.tenant_id = r.tenant_id AND b.id = r.branch_id
    WHERE (r.occurred_at AT TIME ZONE b.timezone)::date BETWEEN ${from}::date AND ${to}::date`;
  const [exp] = await tx<{ vat: number; net: number }[]>`
    SELECT COALESCE(sum(CASE WHEN c.vat_reclaimable THEN e.vat_pence ELSE 0 END),0) AS vat,
           COALESCE(sum(e.net_pence + CASE WHEN c.vat_reclaimable THEN 0 ELSE e.vat_pence END),0) AS net
    FROM expenses e JOIN expense_categories c ON c.tenant_id = e.tenant_id AND c.id = e.category_id
    WHERE e.incurred_on BETWEEN ${from}::date AND ${to}::date`;
  const [inv] = await tx<{ vat: number; net: number }[]>`
    SELECT COALESCE(sum(vat_pence),0) AS vat, COALESCE(sum(subtotal_pence),0) AS net
    FROM supplier_invoices WHERE status = 'posted' AND invoice_date BETWEEN ${from}::date AND ${to}::date`;
  const box1 = sales!.vat - refunds!.vat;
  const box4 = exp!.vat + inv!.vat;
  return {
    box1_vat_due_sales_pence: box1,
    box2_vat_due_acquisitions_pence: 0,
    box3_total_vat_due_pence: box1,
    box4_vat_reclaimed_pence: box4,
    box5_net_vat_pence: Math.abs(box1 - box4),
    box6_total_sales_ex_vat_pence: (sales!.gross - sales!.vat) - (refunds!.gross - refunds!.vat),
    box7_total_purchases_ex_vat_pence: exp!.net + inv!.net,
    box8_supplies_ex_vat_pence: 0,
    box9_acquisitions_ex_vat_pence: 0,
    direction: box1 >= box4 ? 'payable' : 'repayable',
  };
}

export async function reportRoutes(app: FastifyInstance, deps: Deps) {
  // Dashboards read ONLY the pre-aggregated tables (refreshed by the worker).
  app.get('/v1/reports/daily', async (req) => {
    const q = parse(range, req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'reports.sales');
      requireBranchAccess(actor, q.branch_id);
      const rows = await tx`
        SELECT * FROM daily_branch_summaries
        WHERE branch_id = ${q.branch_id} AND business_date BETWEEN ${q.from}::date AND ${q.to}::date
        ORDER BY business_date`;
      const financial = can(actor, 'reports.financial');
      return rows.map((r) => financial ? { ...r, gross_margin_pence: (r.net_sales_pence as number) - (r.cost_of_goods_pence as number) }
        : { ...r, cost_of_goods_pence: undefined, waste_cost_pence: undefined });
    });
  });

  app.get('/v1/reports/top-products', async (req) => {
    const q = parse(range.extend({ limit: z.coerce.number().int().min(1).max(200).default(20),
      order: z.enum(['revenue', 'quantity', 'margin']).default('revenue') }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'reports.sales');
      requireBranchAccess(actor, q.branch_id);
      if (q.order === 'margin') requirePermission(actor, 'reports.financial');
      const rows = await tx`
        SELECT d.product_id, p.name, sum(d.qty_sold) AS qty_sold, sum(d.net_sales_pence) AS net_sales_pence,
               sum(d.cost_pence) AS cost_pence, sum(d.net_sales_pence) - sum(d.cost_pence) AS margin_pence,
               sum(d.qty_wasted) AS qty_wasted, bool_or(d.was_out_of_stock) AS had_stockout
        FROM product_daily_sales d JOIN products p ON p.tenant_id = d.tenant_id AND p.id = d.product_id
        WHERE d.branch_id = ${q.branch_id} AND d.business_date BETWEEN ${q.from}::date AND ${q.to}::date
        GROUP BY d.product_id, p.name
        ORDER BY ${q.order === 'quantity' ? tx`qty_sold` : q.order === 'margin' ? tx`margin_pence` : tx`net_sales_pence`} DESC
        LIMIT ${q.limit}`;
      return can(actor, 'reports.financial') ? rows : rows.map(({ cost_pence, margin_pence, ...r }) => r);
    });
  });

  // Loss prevention: voids, no-sales, refunds, discounts per staff member.
  app.get('/v1/reports/staff-activity', async (req) => {
    const q = parse(range, req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'reports.staff');
      requireBranchAccess(actor, q.branch_id);
      return tx`
        SELECT s.id AS staff_id, s.display_name,
          (SELECT count(*) FROM sales x WHERE x.tenant_id = s.tenant_id AND x.staff_id = s.id AND x.branch_id = ${q.branch_id}
             AND NOT x.is_training AND x.completed_at::date BETWEEN ${q.from}::date AND ${q.to}::date)::int AS sales,
          (SELECT COALESCE(sum(x.total_pence),0) FROM sales x WHERE x.tenant_id = s.tenant_id AND x.staff_id = s.id AND x.branch_id = ${q.branch_id}
             AND NOT x.is_training AND x.status <> 'voided' AND x.completed_at::date BETWEEN ${q.from}::date AND ${q.to}::date) AS sales_pence,
          (SELECT count(*) FROM sale_lines l JOIN sales x ON x.tenant_id = l.tenant_id AND x.id = l.sale_id
             WHERE l.tenant_id = s.tenant_id AND l.voided_by = s.id AND x.branch_id = ${q.branch_id}
             AND l.added_at::date BETWEEN ${q.from}::date AND ${q.to}::date)::int AS voided_lines,
          (SELECT count(*) FROM cash_movements c JOIN till_sessions t ON t.tenant_id = c.tenant_id AND t.id = c.till_session_id
             WHERE c.tenant_id = s.tenant_id AND c.staff_id = s.id AND c.movement_type = 'no_sale' AND t.branch_id = ${q.branch_id}
             AND c.occurred_at::date BETWEEN ${q.from}::date AND ${q.to}::date)::int AS no_sales,
          (SELECT COALESCE(sum(r.total_pence),0) FROM refunds r WHERE r.tenant_id = s.tenant_id AND r.staff_id = s.id
             AND r.branch_id = ${q.branch_id} AND r.occurred_at::date BETWEEN ${q.from}::date AND ${q.to}::date) AS refunds_pence,
          (SELECT COALESCE(sum(d.amount_pence),0) FROM sale_discounts d WHERE d.tenant_id = s.tenant_id AND d.staff_id = s.id
             AND d.created_at::date BETWEEN ${q.from}::date AND ${q.to}::date) AS discounts_pence
        FROM staff s ORDER BY s.display_name`;
    });
  });

  app.get('/v1/reports/vat', async (req) => {
    const q = parse(z.object({ from: isoDate, to: isoDate }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'reports.financial');
      return { period_start: q.from, period_end: q.to, ...(await computeVatBoxes(tx, q.from, q.to)) };
    });
  });

  // Save / refresh a DRAFT VAT return. Submission to HMRC is a later integration.
  app.post('/v1/vat-returns', async (req, reply) => {
    const body = parse(z.object({ period_start: isoDate, period_end: isoDate, due_date: isoDate.nullish() }), req.body);
    if (body.period_end <= body.period_start) throw unprocessable('period_end must be after period_start');
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'finance.vat');
      const [existing] = await tx<{ status: string }[]>`SELECT status FROM vat_returns WHERE period_start = ${body.period_start}`;
      if (existing && !['draft', 'ready'].includes(existing.status)) throw conflict(`This VAT return is already ${existing.status}`);
      const { direction, ...boxes } = await computeVatBoxes(tx, body.period_start, body.period_end);
      const [r] = await tx`
        INSERT INTO vat_returns ${tx({ tenant_id: tenantId, ...body, due_date: body.due_date ?? null, ...boxes } as never)}
        ON CONFLICT (tenant_id, period_start) DO UPDATE SET
          period_end = EXCLUDED.period_end, due_date = EXCLUDED.due_date,
          box1_vat_due_sales_pence = EXCLUDED.box1_vat_due_sales_pence, box3_total_vat_due_pence = EXCLUDED.box3_total_vat_due_pence,
          box4_vat_reclaimed_pence = EXCLUDED.box4_vat_reclaimed_pence, box5_net_vat_pence = EXCLUDED.box5_net_vat_pence,
          box6_total_sales_ex_vat_pence = EXCLUDED.box6_total_sales_ex_vat_pence,
          box7_total_purchases_ex_vat_pence = EXCLUDED.box7_total_purchases_ex_vat_pence
        RETURNING *`;
      return { ...r, direction };
    });
    return reply.status(201).send(row);
  });
}
