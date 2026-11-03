import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, requirePosToken, tenantTx } from '../app.ts';
import { LIMITS, PERMISSIONS } from '@retail/shared';
import { authoriseAction, can, requireBranchAccess, requirePermission, verifyApprover } from '../lib/authz.ts';
import { conflict, forbidden, notFound } from '../lib/errors.ts';
import { enqueueEvent } from '../lib/outbox.ts';
import { postMovements } from '../lib/stock.ts';
import { idParam, isoDate, parse, pence, uuid } from '../lib/validate.ts';
import { computeZReport } from '../services/zreport.ts';

const approval = z.object({ approver_staff_id: uuid, approver_pin: z.string().regex(/^\d{4,8}$/) }).nullish();

export async function posRoutes(app: FastifyInstance, deps: Deps) {
  // The till asks a manager to approve an over-limit action (discount, refund,
  // void...) while it is online: checks the approver's PIN and authority. The
  // approval itself travels with the sale/refund in /v1/sync/push. Offline the
  // till records the approval without this check (the sync rules still apply).
  app.post('/v1/pos/verify-approval', async (req) => {
    const pos = requirePosToken(req);
    const body = parse(z.object({
      action_code: z.enum(PERMISSIONS), limit_code: z.enum(LIMITS).optional(), value: z.number().nonnegative().default(0),
      approver_staff_id: uuid, approver_pin: z.string().regex(/^\d{4,8}$/),
    }), req.body);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      const approver = await verifyApprover(tx, { actor, actionCode: body.action_code, limitCode: body.limit_code, value: body.value,
        approval: { approver_staff_id: body.approver_staff_id, approver_pin: body.approver_pin } });
      if (!approver.isOwner && !approver.branchIds.has(pos.bid)) throw forbidden('The approver does not work at this branch');
      const [s] = await tx<{ display_name: string }[]>`SELECT display_name FROM staff WHERE id = ${approver.staffId}`;
      return { approved_by: approver.staffId, display_name: s?.display_name ?? null, outcome: 'approved' as const };
    });
  });

  // Open a till (start of shift). The device may supply the id (offline-safe).
  app.post('/v1/till-sessions', async (req, reply) => {
    const body = parse(z.object({ id: uuid.optional(), till_id: uuid, opening_float_pence: pence.default(0) }), req.body);
    const out = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'pos.open_till');
      const [till] = await tx<{ branch_id: string; is_active: boolean }[]>`SELECT branch_id, is_active FROM tills WHERE id = ${body.till_id}`;
      if (!till || !till.is_active) throw notFound('Till');
      requireBranchAccess(actor, till.branch_id);
      if (body.id) {
        const [existing] = await tx`SELECT * FROM till_sessions WHERE id = ${body.id}`;
        if (existing) return { session: existing, created: false };
      }
      const [open] = await tx`SELECT id FROM till_sessions WHERE till_id = ${body.till_id} AND status = 'open'`;
      if (open) throw conflict('This till is already open', { till_session_id: open.id });
      const [s] = await tx`
        INSERT INTO till_sessions (tenant_id, id, till_id, branch_id, opened_by, opening_float_pence)
        VALUES (${tenantId}, ${body.id ?? tx`gen_random_uuid()`}, ${body.till_id}, ${till.branch_id}, ${actor.staffId}, ${body.opening_float_pence})
        RETURNING *`;
      return { session: s, created: true };
    });
    return reply.status(out.created ? 201 : 200).send(out.session);
  });

  app.get('/v1/till-sessions', async (req) => {
    const q = parse(z.object({ branch_id: uuid, status: z.enum(['open', 'closed']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requireBranchAccess(actor, q.branch_id);
      requirePermission(actor, 'pos.z_report');
      return tx`
        SELECT s.id, s.till_id, t.name AS till_name, s.status, s.opened_at, s.closed_at, s.opening_float_pence,
               s.expected_cash_pence, s.counted_cash_pence, s.variance_pence,
               o.display_name AS opened_by_name, c.display_name AS closed_by_name,
               (s.z_report->'sales'->>'net_pence')::bigint AS net_sales_pence
        FROM till_sessions s JOIN tills t ON t.tenant_id = s.tenant_id AND t.id = s.till_id
        JOIN staff o ON o.tenant_id = s.tenant_id AND o.id = s.opened_by
        LEFT JOIN staff c ON c.tenant_id = s.tenant_id AND c.id = s.closed_by
        WHERE s.branch_id = ${q.branch_id} ${q.status ? tx`AND s.status = ${q.status}` : tx``}
        ORDER BY s.opened_at DESC LIMIT ${q.limit}`;
    });
  });

  app.get('/v1/expense-categories', async (req) =>
    tenantTx(deps, req, async ({ tx }) => tx`SELECT id, name, vat_reclaimable FROM expense_categories WHERE is_active ORDER BY name`));

  app.get('/v1/till-sessions/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      const [s] = await tx<{ branch_id: string }[]>`SELECT * FROM till_sessions WHERE id = ${id}`;
      if (!s) throw notFound('Till session');
      requireBranchAccess(actor, s.branch_id);
      return s;
    });
  });

  // No sale / paid out / paid in / cash drop. Limits per shift and per amount.
  app.post('/v1/till-sessions/:id/cash-movements', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      movement_type: z.enum(['no_sale', 'paid_in', 'paid_out', 'cash_drop', 'float_adjust']),
      amount_pence: pence.default(0), reason: z.string().nullish(), approval,
      expense: z.object({ category_id: uuid, description: z.string().min(1), vat_pence: pence.default(0) }).nullish(),
    }), req.body);
    const out = await tenantTx(deps, req, async ({ tx, actor, tenantId, auth }) => {
      const [s] = await tx<{ branch_id: string; status: string }[]>`SELECT branch_id, status FROM till_sessions WHERE id = ${id}`;
      if (!s) throw notFound('Till session');
      if (s.status !== 'open') throw conflict('Till session is closed');
      requireBranchAccess(actor, s.branch_id);
      let approvedBy: string | null = null;
      const common = { actor, branchId: s.branch_id, deviceId: auth.did ?? null, reason: body.reason, approval: body.approval };
      if (body.movement_type === 'no_sale') {
        requirePermission(actor, 'pos.no_sale');
        const [cnt] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM cash_movements
          WHERE till_session_id = ${id} AND staff_id = ${actor.staffId} AND movement_type = 'no_sale'`;
        const r = await authoriseAction(tx, { ...common, actionCode: 'pos.no_sale', limitCode: 'pos.no_sale.max_per_shift',
          value: (cnt?.n ?? 0) + 1 });
        if (r.outcome === 'approved') approvedBy = body.approval!.approver_staff_id;
      } else if (body.movement_type === 'paid_out') {
        requirePermission(actor, 'pos.paid_out');
        const r = await authoriseAction(tx, { ...common, actionCode: 'pos.paid_out', limitCode: 'pos.paid_out.max_amount_pence', value: body.amount_pence });
        if (r.outcome === 'approved') approvedBy = body.approval!.approver_staff_id;
      } else if (body.movement_type === 'paid_in') {
        requirePermission(actor, 'pos.sell');
      } else {
        requirePermission(actor, 'pos.close_till');
      }
      const [m] = await tx<{ id: string }[]>`
        INSERT INTO cash_movements (tenant_id, till_session_id, movement_type, amount_pence, reason, staff_id, approved_by)
        VALUES (${tenantId}, ${id}, ${body.movement_type}, ${body.amount_pence}, ${body.reason ?? null}, ${actor.staffId}, ${approvedBy})
        RETURNING *`;
      // A paid-out for a business cost becomes an expense record straight away.
      if (body.movement_type === 'paid_out' && body.expense) {
        await tx`
          INSERT INTO expenses (tenant_id, branch_id, category_id, description, net_pence, vat_pence, total_pence, incurred_on,
                                payment_method, cash_movement_id, created_by)
          VALUES (${tenantId}, ${s.branch_id}, ${body.expense.category_id}, ${body.expense.description},
                  ${body.amount_pence - body.expense.vat_pence}, ${body.expense.vat_pence}, ${body.amount_pence}, CURRENT_DATE,
                  'till_paid_out', ${m!.id}, ${actor.staffId})`;
      }
      return m;
    });
    return reply.status(201).send(out);
  });

  app.get('/v1/till-sessions/:id/z-report', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'pos.z_report');
      const [s] = await tx<{ branch_id: string; z_report: unknown }[]>`SELECT branch_id, z_report FROM till_sessions WHERE id = ${id}`;
      if (!s) throw notFound('Till session');
      requireBranchAccess(actor, s.branch_id);
      return s.z_report ?? computeZReport(tx, id);
    });
  });

  // Cash up: count the drawer, freeze the Z report, record the variance.
  app.post('/v1/till-sessions/:id/close', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ counted_cash_pence: pence, notes: z.string().nullish() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'pos.close_till');
      const [s] = await tx<{ branch_id: string; status: string }[]>`
        SELECT branch_id, status FROM till_sessions WHERE id = ${id} FOR UPDATE`;
      if (!s) throw notFound('Till session');
      if (s.status !== 'open') throw conflict('Till session is already closed');
      requireBranchAccess(actor, s.branch_id);
      const z = await computeZReport(tx, id);
      const [closed] = await tx<{ variance_pence: number }[]>`
        UPDATE till_sessions SET status = 'closed', closed_by = ${actor.staffId}, closed_at = now(),
               expected_cash_pence = ${z.expected_cash_pence}, counted_cash_pence = ${body.counted_cash_pence},
               z_report = ${tx.json(z as never)}, notes = ${body.notes ?? null}
        WHERE id = ${id} RETURNING *`;
      if (closed!.variance_pence !== 0) {
        await enqueueEvent(tx, tenantId, 'notify.cash_variance', 'till_session', id, {
          branch_id: s.branch_id, variance_pence: closed!.variance_pence, closed_by: actor.staffId,
        });
      }
      return closed;
    });
  });

  // ------------------------------------------------------------ sales
  app.get('/v1/sales', async (req) => {
    const q = parse(z.object({
      branch_id: uuid, from: isoDate.optional(), to: isoDate.optional(), till_session_id: uuid.optional(),
      receipt_number: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requireBranchAccess(actor, q.branch_id);
      const own = !can(actor, 'reports.sales');
      if (own) requirePermission(actor, 'pos.sell');
      return tx`
        SELECT id, receipt_number, status, channel, staff_id, customer_id, total_pence, vat_pence, discount_pence, item_count,
               is_training, completed_at, till_session_id
        FROM sales WHERE branch_id = ${q.branch_id}
          ${own ? tx`AND staff_id = ${actor.staffId}` : tx``}
          ${q.from ? tx`AND completed_at >= ${q.from}::date` : tx``}
          ${q.to ? tx`AND completed_at < ${q.to}::date + 1` : tx``}
          ${q.till_session_id ? tx`AND till_session_id = ${q.till_session_id}` : tx``}
          ${q.receipt_number ? tx`AND receipt_number = ${q.receipt_number}` : tx``}
        ORDER BY completed_at DESC NULLS LAST LIMIT ${q.limit}`;
    });
  });

  app.get('/v1/sales/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      const [sale] = await tx<{ branch_id: string; staff_id: string }[]>`SELECT * FROM sales WHERE id = ${id}`;
      if (!sale) throw notFound('Sale');
      requireBranchAccess(actor, sale.branch_id);
      if (!can(actor, 'reports.sales') && !can(actor, 'pos.refund') && sale.staff_id !== actor.staffId) throw forbidden('Not your sale');
      const [lines, payments, discounts, refunds] = await Promise.all([
        tx`SELECT * FROM sale_lines WHERE sale_id = ${id} ORDER BY line_no`,
        tx`SELECT * FROM sale_payments WHERE sale_id = ${id} ORDER BY occurred_at`,
        tx`SELECT * FROM sale_discounts WHERE sale_id = ${id}`,
        tx`SELECT r.*, COALESCE((SELECT jsonb_agg(rl) FROM refund_lines rl WHERE rl.tenant_id = r.tenant_id AND rl.refund_id = r.id), '[]') AS lines
           FROM refunds r WHERE original_sale_id = ${id} ORDER BY occurred_at`,
      ]);
      return { ...sale, lines, payments, discounts, refunds };
    });
  });

  // Void a completed sale (online only, e.g. wrong card taken). Stock goes back.
  app.post('/v1/sales/:id/void', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ reason: z.string().min(1), approval }), req.body);
    const pos = requirePosToken(req);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'pos.void_sale');
      const [sale] = await tx<{ branch_id: string; status: string; is_training: boolean; total_pence: number }[]>`
        SELECT branch_id, status, is_training, total_pence FROM sales WHERE id = ${id} FOR UPDATE`;
      if (!sale) throw notFound('Sale');
      requireBranchAccess(actor, sale.branch_id);
      if (sale.status !== 'completed') throw conflict(`Only completed sales can be voided (this one is ${sale.status})`);
      const [r] = await tx`SELECT 1 FROM refunds WHERE original_sale_id = ${id}`;
      if (r) throw conflict('This sale has refunds; refund it instead');
      await authoriseAction(tx, { actor, branchId: sale.branch_id, deviceId: pos.did, actionCode: 'pos.void_sale',
        value: sale.total_pence, reason: body.reason, approval: body.approval, saleId: id });
      if (!sale.is_training) {
        const lines = await tx<{ product_id: string; quantity: number; unit_cost_pence: number | null }[]>`
          SELECT sl.product_id, sl.quantity, sl.unit_cost_pence FROM sale_lines sl
          JOIN products p ON p.tenant_id = sl.tenant_id AND p.id = sl.product_id
          WHERE sl.sale_id = ${id} AND NOT sl.is_voided AND p.track_stock`;
        await postMovements(tx, tenantId, lines.map((l) => ({
          branchId: sale.branch_id, productId: l.product_id, quantity: l.quantity, movementType: 'adjustment' as const,
          reasonCode: 'other', reason: 'Sale voided', unitCostPence: l.unit_cost_pence, referenceType: 'sale', referenceId: id,
          staffId: actor.staffId, deviceId: pos.did,
        })));
      }
      await tx`UPDATE sale_payments SET status = 'voided' WHERE sale_id = ${id} AND status = 'approved'`;
      const [voided] = await tx`
        UPDATE sales SET status = 'voided', voided_at = now(), voided_by = ${actor.staffId}, void_reason = ${body.reason}
        WHERE id = ${id} RETURNING id, status, voided_at, void_reason`;
      await enqueueEvent(tx, tenantId, 'sale.voided', 'sale', id, { sale_id: id, branch_id: sale.branch_id });
      return voided;
    });
  });
}
