import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, tenantTx } from '../app.ts';
import { authoriseAction, requireBranchAccess, requireBranchExists, requirePermission } from '../lib/authz.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { postMovements } from '../lib/stock.ts';
import { idParam, isoDate, parse, pence, uuid } from '../lib/validate.ts';

const approval = z.object({ approver_staff_id: uuid, approver_pin: z.string().regex(/^\d{4,8}$/) }).nullish();
const reasonCode = z.enum(['expired', 'damaged', 'spoiled', 'theft_known', 'sampling', 'count_correction', 'supplier_short', 'other']);

export async function stockRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/v1/stock', async (req) => {
    const q = parse(z.object({ branch_id: uuid, q: z.string().optional(), only_low: z.coerce.boolean().default(false) }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'stock.view');
      requireBranchAccess(actor, q.branch_id);
      return tx`
        SELECT p.id AS product_id, p.name, p.sku, p.category_id,
               COALESCE(a.on_hand, 0) AS on_hand, COALESCE(a.reserved, 0) AS reserved, COALESCE(a.available, 0) AS available,
               COALESCE(pbs.reorder_point, p.reorder_point) AS reorder_point,
               COALESCE(pbs.reorder_qty, p.reorder_qty) AS reorder_qty, pbs.shelf_location
        FROM products p
        LEFT JOIN v_stock_availability a ON a.tenant_id = p.tenant_id AND a.product_id = p.id AND a.branch_id = ${q.branch_id}
        LEFT JOIN product_branch_settings pbs ON pbs.tenant_id = p.tenant_id AND pbs.product_id = p.id AND pbs.branch_id = ${q.branch_id}
        WHERE p.track_stock AND p.archived_at IS NULL AND COALESCE(pbs.is_ranged, true)
          ${q.q ? tx`AND p.name ILIKE ${'%' + q.q + '%'}` : tx``}
          ${q.only_low ? tx`AND COALESCE(pbs.reorder_point, p.reorder_point) IS NOT NULL
                            AND COALESCE(a.on_hand, 0) <= COALESCE(pbs.reorder_point, p.reorder_point)` : tx``}
        ORDER BY p.name`;
    });
  });

  app.get('/v1/stock/low', async (req) => {
    const q = parse(z.object({ branch_id: uuid }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'stock.view');
      requireBranchAccess(actor, q.branch_id);
      return tx`SELECT * FROM v_low_stock WHERE branch_id = ${q.branch_id} ORDER BY quantity - reorder_point, name`;
    });
  });

  app.get('/v1/stock/expiring', async (req) => {
    const q = parse(z.object({ branch_id: uuid }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'stock.view');
      requireBranchAccess(actor, q.branch_id);
      return tx`SELECT * FROM v_expiring_soon WHERE branch_id = ${q.branch_id} ORDER BY expiry_date, name`;
    });
  });

  app.get('/v1/stock/movements', async (req) => {
    const q = parse(z.object({ branch_id: uuid, product_id: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'stock.view');
      requireBranchAccess(actor, q.branch_id);
      return tx`
        SELECT * FROM stock_movements WHERE branch_id = ${q.branch_id}
          ${q.product_id ? tx`AND product_id = ${q.product_id}` : tx``}
        ORDER BY occurred_at DESC, created_at DESC LIMIT ${q.limit}`;
    });
  });

  // Manual correction: a NEW signed movement (never an edit). Over the
  // stock.adjust.max_qty limit needs a manager PIN.
  app.post('/v1/stock/adjustments', async (req, reply) => {
    const body = parse(z.object({
      branch_id: uuid, product_id: uuid, quantity: z.number().refine((n) => n !== 0, 'quantity cannot be 0'),
      reason_code: reasonCode.default('count_correction'), reason: z.string().nullish(), approval,
    }), req.body);
    const out = await tenantTx(deps, req, async ({ tx, actor, tenantId, auth }) => {
      requirePermission(actor, 'stock.adjust');
      requireBranchAccess(actor, body.branch_id);
      await requireBranchExists(tx, body.branch_id);
      const auth_ = await authoriseAction(tx, {
        actor, branchId: body.branch_id, deviceId: auth.did ?? null, actionCode: 'stock.adjust',
        limitCode: 'stock.adjust.max_qty', value: Math.abs(body.quantity), reason: body.reason, approval: body.approval,
      });
      const [p] = await tx<{ avg_cost_pence: number | null }[]>`SELECT avg_cost_pence FROM products WHERE id = ${body.product_id}`;
      if (!p) throw notFound('Product');
      await postMovements(tx, tenantId, [{
        branchId: body.branch_id, productId: body.product_id, quantity: body.quantity, movementType: 'adjustment',
        reasonCode: body.reason_code, reason: body.reason, unitCostPence: p.avg_cost_pence, staffId: actor.staffId,
        deviceId: auth.did ?? null, referenceType: 'pos_approval', referenceId: auth_.approvalId,
      }]);
      const [level] = await tx`SELECT quantity FROM stock_levels WHERE branch_id = ${body.branch_id} AND product_id = ${body.product_id}`;
      return { on_hand: level?.quantity ?? 0, approval: auth_ };
    });
    return reply.status(201).send(out);
  });

  // Waste (expired, damaged ...) always needs a reason code.
  app.post('/v1/stock/waste', async (req, reply) => {
    const body = parse(z.object({
      branch_id: uuid, product_id: uuid, quantity: z.number().positive(), reason_code: reasonCode, reason: z.string().nullish(),
      batch_id: uuid.nullish(),
    }), req.body);
    const out = await tenantTx(deps, req, async ({ tx, actor, tenantId, auth }) => {
      requirePermission(actor, 'stock.waste');
      requireBranchAccess(actor, body.branch_id);
      const [p] = await tx<{ avg_cost_pence: number | null }[]>`SELECT avg_cost_pence FROM products WHERE id = ${body.product_id}`;
      if (!p) throw notFound('Product');
      if (body.batch_id) {
        const [b] = await tx`
          UPDATE stock_batches SET qty_remaining = GREATEST(qty_remaining - ${body.quantity}, 0)
          WHERE id = ${body.batch_id} AND product_id = ${body.product_id} AND branch_id = ${body.branch_id} RETURNING id`;
        if (!b) throw notFound('Batch');
      }
      await postMovements(tx, tenantId, [{
        branchId: body.branch_id, productId: body.product_id, quantity: -body.quantity, movementType: 'waste',
        reasonCode: body.reason_code, reason: body.reason, unitCostPence: p.avg_cost_pence, batchId: body.batch_id,
        staffId: actor.staffId, deviceId: auth.did ?? null,
      }]);
      return { ok: true, cost_pence: Math.round((p.avg_cost_pence ?? 0) * body.quantity) };
    });
    return reply.status(201).send(out);
  });

  // Simple goods-in without an invoice (e.g. cash & carry run). Invoices use /v1/invoices/:id/post.
  app.post('/v1/stock/receipts', async (req, reply) => {
    const body = parse(z.object({
      branch_id: uuid,
      lines: z.array(z.object({
        product_id: uuid, quantity: z.number().positive(), unit_cost_pence: pence.nullish(),
        expiry_date: isoDate.nullish(), batch_code: z.string().nullish(),
      })).min(1),
      opening: z.boolean().default(false),  // opening balance when the shop starts using the system
    }), req.body);
    const out = await tenantTx(deps, req, async ({ tx, actor, tenantId, auth }) => {
      requirePermission(actor, 'stock.adjust');
      requireBranchAccess(actor, body.branch_id);
      await requireBranchExists(tx, body.branch_id);
      const movements = [];
      for (const l of body.lines) {
        const [p] = await tx<{ track_expiry: boolean }[]>`SELECT track_expiry FROM products WHERE id = ${l.product_id}`;
        if (!p) throw notFound('Product');
        let batchId: string | null = null;
        if (p.track_expiry && l.expiry_date) {
          const [b] = await tx<{ id: string }[]>`
            INSERT INTO stock_batches (tenant_id, branch_id, product_id, batch_code, expiry_date, qty_received, qty_remaining, unit_cost_pence)
            VALUES (${tenantId}, ${body.branch_id}, ${l.product_id}, ${l.batch_code ?? null}, ${l.expiry_date},
                    ${l.quantity}, ${l.quantity}, ${l.unit_cost_pence ?? null}) RETURNING id`;
          batchId = b!.id;
        }
        if (l.unit_cost_pence != null) await updateCosts(tx, body.branch_id, l.product_id, l.quantity, l.unit_cost_pence);
        movements.push({
          branchId: body.branch_id, productId: l.product_id, quantity: l.quantity,
          movementType: body.opening ? 'opening' as const : 'receipt' as const,
          unitCostPence: l.unit_cost_pence ?? null, batchId, staffId: actor.staffId, deviceId: auth.did ?? null,
        });
      }
      await postMovements(tx, tenantId, movements);
      return { ok: true, lines: movements.length };
    });
    return reply.status(201).send(out);
  });

  // ------------------------------------------------------------ transfers
  app.post('/v1/stock/transfers', async (req, reply) => {
    const body = parse(z.object({
      from_branch_id: uuid, to_branch_id: uuid, notes: z.string().nullish(),
      lines: z.array(z.object({ product_id: uuid, quantity: z.number().positive() })).min(1),
    }), req.body);
    const out = await tenantTx(deps, req, async ({ tx, actor, tenantId, auth }) => {
      requirePermission(actor, 'stock.transfer');
      requireBranchAccess(actor, body.from_branch_id);
      if (body.from_branch_id === body.to_branch_id) throw unprocessable('Choose two different branches');
      await requireBranchExists(tx, body.to_branch_id);
      const [t] = await tx<{ id: string }[]>`
        INSERT INTO stock_transfers (tenant_id, from_branch_id, to_branch_id, status, created_by, sent_at, notes)
        VALUES (${tenantId}, ${body.from_branch_id}, ${body.to_branch_id}, 'in_transit', ${actor.staffId}, now(), ${body.notes ?? null})
        RETURNING *`;
      await tx`INSERT INTO stock_transfer_lines ${tx(body.lines.map((l) => ({
        tenant_id: tenantId, transfer_id: t!.id, product_id: l.product_id, qty_sent: l.quantity })) as never)}`;
      await postMovements(tx, tenantId, body.lines.map((l) => ({
        branchId: body.from_branch_id, productId: l.product_id, quantity: -l.quantity, movementType: 'transfer_out' as const,
        referenceType: 'transfer', referenceId: t!.id, staffId: actor.staffId, deviceId: auth.did ?? null,
      })));
      return t;
    });
    return reply.status(201).send(out);
  });

  app.post('/v1/stock/transfers/:id/receive', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      lines: z.array(z.object({ product_id: uuid, quantity_received: z.number().nonnegative() })).optional(),
    }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId, auth }) => {
      requirePermission(actor, 'stock.transfer');
      const [t] = await tx<{ id: string; to_branch_id: string; status: string }[]>`
        SELECT id, to_branch_id, status FROM stock_transfers WHERE id = ${id} FOR UPDATE`;
      if (!t) throw notFound('Transfer');
      requireBranchAccess(actor, t.to_branch_id);
      if (t.status !== 'in_transit') throw conflict(`Transfer is ${t.status}`);
      const lines = await tx<{ id: string; product_id: string; qty_sent: number }[]>`
        SELECT id, product_id, qty_sent FROM stock_transfer_lines WHERE transfer_id = ${id}`;
      const received = new Map(body.lines?.map((l) => [l.product_id, l.quantity_received]));
      const movements = [];
      for (const l of lines) {
        const qty = received.get(l.product_id) ?? l.qty_sent;
        await tx`UPDATE stock_transfer_lines SET qty_received = ${qty} WHERE id = ${l.id}`;
        if (qty > 0) movements.push({
          branchId: t.to_branch_id, productId: l.product_id, quantity: qty, movementType: 'transfer_in' as const,
          referenceType: 'transfer', referenceId: id, staffId: actor.staffId, deviceId: auth.did ?? null,
        });
      }
      await postMovements(tx, tenantId, movements);
      const [done] = await tx`
        UPDATE stock_transfers SET status = 'received', received_at = now(), received_by = ${actor.staffId}
        WHERE id = ${id} RETURNING *`;
      return done;
    });
  });

  // ------------------------------------------------------------ stocktakes
  app.post('/v1/stocktakes', async (req, reply) => {
    const body = parse(z.object({ branch_id: uuid, scope: z.enum(['full', 'category', 'spot']).default('spot'),
      category_id: uuid.nullish() }), req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'stock.count');
      requireBranchAccess(actor, body.branch_id);
      const [s] = await tx`
        INSERT INTO stocktakes (tenant_id, branch_id, scope, category_id, started_by)
        VALUES (${tenantId}, ${body.branch_id}, ${body.scope}, ${body.category_id ?? null}, ${actor.staffId}) RETURNING *`;
      return s;
    });
    return reply.status(201).send(row);
  });

  // Count a product. Expected qty is snapshotted at the moment of counting.
  app.post('/v1/stocktakes/:id/counts', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ product_id: uuid, counted_qty: z.number().nonnegative() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'stock.count');
      const [s] = await tx<{ branch_id: string; status: string }[]>`SELECT branch_id, status FROM stocktakes WHERE id = ${id}`;
      if (!s) throw notFound('Stocktake');
      if (s.status !== 'in_progress') throw conflict('Stocktake is closed');
      requireBranchAccess(actor, s.branch_id);
      const [line] = await tx`
        INSERT INTO stocktake_lines (tenant_id, stocktake_id, product_id, expected_qty, counted_qty, counted_by)
        VALUES (${tenantId}, ${id}, ${body.product_id},
                COALESCE((SELECT quantity FROM stock_levels WHERE branch_id = ${s.branch_id} AND product_id = ${body.product_id}), 0),
                ${body.counted_qty}, ${actor.staffId})
        ON CONFLICT (tenant_id, stocktake_id, product_id)
        DO UPDATE SET counted_qty = EXCLUDED.counted_qty, expected_qty = EXCLUDED.expected_qty,
                      counted_by = EXCLUDED.counted_by, counted_at = now()
        RETURNING *`;
      return line;
    });
  });

  // Completing posts one 'stocktake' movement per variance.
  app.post('/v1/stocktakes/:id/complete', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor, tenantId, auth }) => {
      requirePermission(actor, 'stock.count');
      const [s] = await tx<{ branch_id: string; status: string }[]>`
        SELECT branch_id, status FROM stocktakes WHERE id = ${id} FOR UPDATE`;
      if (!s) throw notFound('Stocktake');
      if (s.status !== 'in_progress') throw conflict('Stocktake is closed');
      requireBranchAccess(actor, s.branch_id);
      const lines = await tx<{ product_id: string; variance_qty: number; avg_cost_pence: number | null }[]>`
        SELECT l.product_id, l.variance_qty, p.avg_cost_pence
        FROM stocktake_lines l JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
        WHERE l.stocktake_id = ${id} AND l.variance_qty <> 0`;
      await postMovements(tx, tenantId, lines.map((l) => ({
        branchId: s.branch_id, productId: l.product_id, quantity: l.variance_qty, movementType: 'stocktake' as const,
        reasonCode: 'count_correction', unitCostPence: l.avg_cost_pence, referenceType: 'stocktake', referenceId: id,
        staffId: actor.staffId, deviceId: auth.did ?? null,
      })));
      const [done] = await tx`UPDATE stocktakes SET status = 'completed', completed_at = now() WHERE id = ${id} RETURNING *`;
      const varianceValue = lines.reduce((sum, l) => sum + Math.round(l.variance_qty * (l.avg_cost_pence ?? 0)), 0);
      return { ...done, lines_with_variance: lines.length, variance_value_pence: varianceValue };
    });
  });
}

/** Weighted-average cost, updated whenever stock is received at a known cost. */
export async function updateCosts(tx: import('../lib/db.ts').Tx, branchId: string, productId: string, qty: number, unitCostPence: number) {
  await tx`
    UPDATE products p SET
      last_cost_pence = ${unitCostPence},
      avg_cost_pence = CASE
        WHEN p.avg_cost_pence IS NULL OR COALESCE(sl.quantity, 0) <= 0 THEN ${unitCostPence}
        ELSE round((p.avg_cost_pence * sl.quantity + ${unitCostPence}::numeric * ${qty}) / (sl.quantity + ${qty}))::bigint
      END
    FROM (SELECT (SELECT quantity FROM stock_levels WHERE branch_id = ${branchId} AND product_id = ${productId}) AS quantity) sl
    WHERE p.id = ${productId}`;
}
