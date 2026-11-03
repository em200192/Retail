import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, tenantTx } from '../app.ts';
import { can, requireAnyPermission, requireBranchAccess, requireBranchExists, requirePermission } from '../lib/authz.ts';
import type { Tx } from '../lib/db.ts';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors.ts';
import { enqueueEvent } from '../lib/outbox.ts';
import { idParam, isoDate, parse, pence, uuid } from '../lib/validate.ts';
import { storageKeyFor } from '../integrations/files.ts';
import { ocrInvoiceSchema } from '../integrations/ocr.ts';
import { applyExtraction, postInvoice } from '../services/invoices.ts';

const supplierSchema = z.object({
  name: z.string().min(1), global_supplier_id: uuid.nullish(), account_number: z.string().nullish(),
  contact_name: z.string().nullish(), email: z.string().email().nullish(), phone: z.string().nullish(),
  website: z.string().nullish(), vat_number: z.string().nullish(),
  order_method: z.enum(['email', 'portal', 'phone', 'edi', 'in_person']).optional(),
  order_days: z.array(z.number().int().min(1).max(7)).nullish(), lead_time_days: z.number().int().min(0).nullish(),
  min_order_pence: pence.nullish(), is_active: z.boolean().optional(), notes: z.string().nullish(),
});

/** One open shopping list per branch; created on demand. */
async function openList(tx: Tx, tenantId: string, branchId: string, staffId: string): Promise<string> {
  const [l] = await tx<{ id: string }[]>`SELECT id FROM purchase_lists WHERE branch_id = ${branchId} AND status = 'open'`;
  if (l) return l.id;
  const [created] = await tx<{ id: string }[]>`
    INSERT INTO purchase_lists (tenant_id, branch_id, name, created_by)
    VALUES (${tenantId}, ${branchId}, ${'Shopping list ' + new Date().toISOString().slice(0, 10)}, ${staffId})
    ON CONFLICT DO NOTHING RETURNING id`;
  if (created) return created.id;
  const [again] = await tx<{ id: string }[]>`SELECT id FROM purchase_lists WHERE branch_id = ${branchId} AND status = 'open'`;
  return again!.id;
}

async function preferredSupplier(tx: Tx, productId: string): Promise<{ supplier_id: string; case_cost_pence: number | null; pack_size: number } | undefined> {
  const [s] = await tx<{ supplier_id: string; case_cost_pence: number | null; pack_size: number }[]>`
    SELECT supplier_id, case_cost_pence, pack_size FROM supplier_products
    WHERE product_id = ${productId} ORDER BY is_preferred DESC, last_cost_at DESC NULLS LAST LIMIT 1`;
  return s;
}

export async function purchasingRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------ suppliers
  app.get('/v1/suppliers', async (req) =>
    tenantTx(deps, req, async ({ tx, actor }) => {
      requireAnyPermission(actor, 'suppliers.manage', 'purchasing.order', 'invoices.approve', 'purchasing.manage_list');
      return tx`SELECT * FROM suppliers ORDER BY is_active DESC, name`;
    }));

  app.get('/v1/global-suppliers', async (req) =>
    tenantTx(deps, req, async ({ tx }) => tx`SELECT id, name, website FROM global_suppliers WHERE is_active ORDER BY name`));

  app.post('/v1/suppliers', async (req, reply) => {
    const body = parse(supplierSchema, req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'suppliers.manage');
      const [s] = await tx`INSERT INTO suppliers ${tx({ ...body, tenant_id: tenantId } as never)} RETURNING *`;
      return s;
    });
    return reply.status(201).send(row);
  });

  app.patch('/v1/suppliers/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(supplierSchema.partial(), req.body);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'suppliers.manage');
      const [s] = await tx`UPDATE suppliers SET ${tx(body as never)} WHERE id = ${id} RETURNING *`;
      if (!s) throw notFound('Supplier');
      return s;
    });
  });

  app.get('/v1/suppliers/:id/products', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requireAnyPermission(actor, 'suppliers.manage', 'purchasing.order', 'invoices.approve');
      return tx`
        SELECT sp.*, p.name AS product_name FROM supplier_products sp
        JOIN products p ON p.tenant_id = sp.tenant_id AND p.id = sp.product_id
        WHERE sp.supplier_id = ${id} ORDER BY p.name`;
    });
  });

  app.post('/v1/suppliers/:id/products', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ product_id: uuid, supplier_code: z.string().min(1), supplier_description: z.string().nullish(),
      pack_size: z.number().positive().default(1), case_cost_pence: pence.nullish(), is_preferred: z.boolean().default(false) }), req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'suppliers.manage');
      if (body.is_preferred) await tx`UPDATE supplier_products SET is_preferred = false WHERE product_id = ${body.product_id}`;
      const [sp] = await tx`
        INSERT INTO supplier_products ${tx({ ...body, tenant_id: tenantId, supplier_id: id, match_source: 'manual',
          last_cost_at: body.case_cost_pence != null ? new Date() : null } as never)}
        ON CONFLICT (tenant_id, supplier_id, supplier_code) DO UPDATE SET product_id = EXCLUDED.product_id,
          pack_size = EXCLUDED.pack_size, case_cost_pence = EXCLUDED.case_cost_pence, is_preferred = EXCLUDED.is_preferred,
          match_source = 'manual'
        RETURNING *`;
      return sp;
    });
    return reply.status(201).send(row);
  });

  // ------------------------------------------------------------ staff "we need" requests
  app.post('/v1/purchase-requests', async (req, reply) => {
    const body = parse(z.object({
      branch_id: uuid, product_id: uuid.nullish(), free_text: z.string().nullish(), quantity: z.number().positive().nullish(),
      priority: z.enum(['urgent', 'normal', 'low']).default('normal'), note: z.string().nullish(),
    }).refine((b) => b.product_id || b.free_text, 'Give a product or describe what is needed'), req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'purchasing.request');
      requireBranchAccess(actor, body.branch_id);
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO purchase_requests ${tx({ ...body, tenant_id: tenantId, requested_by: actor.staffId } as never)} RETURNING *`;
      await enqueueEvent(tx, tenantId, 'notify.purchase_request', 'purchase_request', r!.id,
        { branch_id: body.branch_id, priority: body.priority, requested_by: actor.staffId });
      return r;
    });
    return reply.status(201).send(row);
  });

  app.get('/v1/purchase-requests', async (req) => {
    const q = parse(z.object({ branch_id: uuid, status: z.string().optional() }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requireBranchAccess(actor, q.branch_id);
      const all = can(actor, 'purchasing.manage_list');
      if (!all) requirePermission(actor, 'purchasing.request');
      return tx`
        SELECT r.*, p.name AS product_name, s.display_name AS requested_by_name
        FROM purchase_requests r
        LEFT JOIN products p ON p.tenant_id = r.tenant_id AND p.id = r.product_id
        JOIN staff s ON s.tenant_id = r.tenant_id AND s.id = r.requested_by
        WHERE r.branch_id = ${q.branch_id}
          ${all ? tx`` : tx`AND r.requested_by = ${actor.staffId}`}
          ${q.status ? tx`AND r.status = ${q.status}` : tx``}
        ORDER BY (r.priority = 'urgent') DESC, r.created_at DESC`;
    });
  });

  app.post('/v1/purchase-requests/:id/review', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().nullish(),
      quantity: z.number().positive().optional() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'purchasing.manage_list');
      const [r] = await tx<{ branch_id: string; status: string; product_id: string | null; free_text: string | null; quantity: number | null }[]>`
        SELECT branch_id, status, product_id, free_text, quantity FROM purchase_requests WHERE id = ${id} FOR UPDATE`;
      if (!r) throw notFound('Request');
      requireBranchAccess(actor, r.branch_id);
      if (r.status !== 'pending') throw conflict(`Request is already ${r.status}`);
      let itemId: string | null = null;
      if (body.decision === 'approve') {
        const listId = await openList(tx, tenantId, r.branch_id, actor.staffId);
        const sup = r.product_id ? await preferredSupplier(tx, r.product_id) : undefined;
        const [item] = await tx<{ id: string }[]>`
          INSERT INTO purchase_list_items (tenant_id, purchase_list_id, product_id, free_text, supplier_id, quantity, source,
                                           purchase_request_id, status, added_by, estimated_unit_cost_pence)
          VALUES (${tenantId}, ${listId}, ${r.product_id}, ${r.free_text}, ${sup?.supplier_id ?? null}, ${body.quantity ?? r.quantity ?? 1},
                  'staff_request', ${id}, 'approved', ${actor.staffId},
                  ${sup?.case_cost_pence != null ? Math.round(sup.case_cost_pence / sup.pack_size) : null})
          RETURNING id`;
        itemId = item!.id;
      }
      const [updated] = await tx`
        UPDATE purchase_requests SET status = ${body.decision === 'approve' ? 'approved' : 'rejected'}, reviewed_by = ${actor.staffId},
               reviewed_at = now(), review_note = ${body.note ?? null}
        WHERE id = ${id} RETURNING *`;
      return { ...updated, purchase_list_item_id: itemId };
    });
  });

  // ------------------------------------------------------------ shopping list
  app.get('/v1/purchase-list', async (req) => {
    const q = parse(z.object({ branch_id: uuid }), req.query);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'purchasing.manage_list');
      requireBranchAccess(actor, q.branch_id);
      const listId = await openList(tx, tenantId, q.branch_id, actor.staffId);
      const [list] = await tx`SELECT * FROM purchase_lists WHERE id = ${listId}`;
      const items = await tx`
        SELECT i.*, p.name AS product_name, s.name AS supplier_name
        FROM purchase_list_items i
        LEFT JOIN products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id
        LEFT JOIN suppliers s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
        WHERE i.purchase_list_id = ${listId} ORDER BY s.name NULLS LAST, p.name`;
      return { ...list, items };
    });
  });

  app.post('/v1/purchase-list/items', async (req, reply) => {
    const body = parse(z.object({
      branch_id: uuid, product_id: uuid.nullish(), free_text: z.string().nullish(), supplier_id: uuid.nullish(),
      quantity: z.number().positive(), unit: z.enum(['each', 'case']).default('each'),
    }).refine((b) => b.product_id || b.free_text, 'Give a product or a description'), req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'purchasing.manage_list');
      requireBranchAccess(actor, body.branch_id);
      const listId = await openList(tx, tenantId, body.branch_id, actor.staffId);
      const sup = !body.supplier_id && body.product_id ? await preferredSupplier(tx, body.product_id) : undefined;
      const { branch_id, ...fields } = body;
      const [i] = await tx`
        INSERT INTO purchase_list_items ${tx({ ...fields, tenant_id: tenantId, purchase_list_id: listId, source: 'manual',
          status: 'approved', added_by: actor.staffId, supplier_id: body.supplier_id ?? sup?.supplier_id ?? null } as never)}
        RETURNING *`;
      return i;
    });
    return reply.status(201).send(row);
  });

  app.patch('/v1/purchase-list/items/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ quantity: z.number().positive().optional(), supplier_id: uuid.nullish(),
      status: z.enum(['pending', 'approved', 'rejected']).optional(), unit: z.enum(['each', 'case']).optional() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'purchasing.manage_list');
      const [i] = await tx`
        UPDATE purchase_list_items SET ${tx(body as never)} WHERE id = ${id} AND status NOT IN ('ordered','received') RETURNING *`;
      if (!i) throw notFound('List item (or it is already ordered)');
      return i;
    });
  });

  // Low stock -> suggested list items (source = reorder_point). Idempotent.
  app.post('/v1/purchase-list/generate', async (req) => {
    const body = parse(z.object({ branch_id: uuid }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'purchasing.manage_list');
      requireBranchAccess(actor, body.branch_id);
      const listId = await openList(tx, tenantId, body.branch_id, actor.staffId);
      const low = await tx<{ product_id: string; name: string; quantity: number; reorder_point: number; reorder_qty: number | null }[]>`
        SELECT v.product_id, v.name, v.quantity, v.reorder_point, v.reorder_qty FROM v_low_stock v
        WHERE v.branch_id = ${body.branch_id}
          AND NOT EXISTS (SELECT 1 FROM purchase_list_items i WHERE i.tenant_id = v.tenant_id AND i.purchase_list_id = ${listId}
                          AND i.product_id = v.product_id AND i.status IN ('pending','approved'))`;
      const added = [];
      for (const l of low) {
        const qty = l.reorder_qty ?? Math.max(l.reorder_point * 2 - l.quantity, 1);
        const sup = await preferredSupplier(tx, l.product_id);
        const [i] = await tx`
          INSERT INTO purchase_list_items (tenant_id, purchase_list_id, product_id, supplier_id, quantity, source, ai_reason, status,
                                           estimated_unit_cost_pence, added_by)
          VALUES (${tenantId}, ${listId}, ${l.product_id}, ${sup?.supplier_id ?? null}, ${qty}, 'reorder_point',
                  ${`${l.quantity} left, reorder point is ${l.reorder_point}`}, 'pending',
                  ${sup?.case_cost_pence != null ? Math.round(sup.case_cost_pence / sup.pack_size) : null}, ${actor.staffId})
          RETURNING *`;
        added.push(i);
      }
      return { purchase_list_id: listId, added };
    });
  });

  // ------------------------------------------------------------ purchase orders
  app.post('/v1/purchase-orders/from-list', async (req, reply) => {
    const body = parse(z.object({ branch_id: uuid }), req.body);
    const out = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'purchasing.order');
      requireBranchAccess(actor, body.branch_id);
      const [branch] = await tx<{ code: string }[]>`SELECT code FROM branches WHERE id = ${body.branch_id}`;
      const items = await tx<{ id: string; product_id: string; supplier_id: string; quantity: number; unit: string; estimated_unit_cost_pence: number | null }[]>`
        SELECT i.id, i.product_id, i.supplier_id, i.quantity, i.unit, i.estimated_unit_cost_pence
        FROM purchase_list_items i JOIN purchase_lists l ON l.tenant_id = i.tenant_id AND l.id = i.purchase_list_id
        WHERE l.branch_id = ${body.branch_id} AND l.status = 'open' AND i.status = 'approved'
          AND i.product_id IS NOT NULL AND i.supplier_id IS NOT NULL`;
      if (!items.length) throw unprocessable('No approved items with a supplier on the shopping list');
      type Item = (typeof items)[number];
      const bySupplier = new Map<string, Item[]>();
      for (const i of items) bySupplier.set(i.supplier_id, [...(bySupplier.get(i.supplier_id) ?? []), i]);
      const orders = [];
      for (const [supplierId, lines] of bySupplier) {
        const poNumber = `PO-${branch!.code}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${createHash('sha1')
          .update(supplierId + Date.now() + Math.random()).digest('hex').slice(0, 5).toUpperCase()}`;
        const [po] = await tx<{ id: string }[]>`
          INSERT INTO purchase_orders (tenant_id, branch_id, supplier_id, po_number, created_by)
          VALUES (${tenantId}, ${body.branch_id}, ${supplierId}, ${poNumber}, ${actor.staffId}) RETURNING *`;
        let estimate = 0;
        for (const l of lines) {
          const [sp] = await tx<{ id: string; pack_size: number; case_cost_pence: number | null }[]>`
            SELECT id, pack_size, case_cost_pence FROM supplier_products WHERE supplier_id = ${supplierId} AND product_id = ${l.product_id}
            ORDER BY is_preferred DESC LIMIT 1`;
          // Order whole cases when the supplier sells in cases.
          const byCase = l.unit === 'case' || (sp && sp.pack_size > 1);
          const qty = l.unit === 'case' ? l.quantity : byCase ? Math.ceil(l.quantity / sp!.pack_size) : l.quantity;
          const cost = byCase ? sp?.case_cost_pence ?? null : l.estimated_unit_cost_pence;
          estimate += Math.round((cost ?? 0) * qty);
          await tx`
            INSERT INTO purchase_order_lines (tenant_id, purchase_order_id, product_id, supplier_product_id, unit, qty_ordered, unit_cost_pence)
            VALUES (${tenantId}, ${po!.id}, ${l.product_id}, ${sp?.id ?? null}, ${byCase ? 'case' : 'each'}, ${qty}, ${cost})`;
          await tx`UPDATE purchase_list_items SET status = 'ordered', purchase_order_id = ${po!.id} WHERE id = ${l.id}`;
        }
        const [final] = await tx`UPDATE purchase_orders SET estimated_total_pence = ${estimate} WHERE id = ${po!.id} RETURNING *`;
        orders.push(final);
      }
      return orders;
    });
    return reply.status(201).send(out);
  });

  app.get('/v1/purchase-orders', async (req) => {
    const q = parse(z.object({ branch_id: uuid, status: z.string().optional() }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requireAnyPermission(actor, 'purchasing.order', 'invoices.approve');
      requireBranchAccess(actor, q.branch_id);
      return tx`
        SELECT po.*, s.name AS supplier_name,
               (SELECT jsonb_agg(l ORDER BY l.id) FROM purchase_order_lines l WHERE l.tenant_id = po.tenant_id AND l.purchase_order_id = po.id) AS lines
        FROM purchase_orders po JOIN suppliers s ON s.tenant_id = po.tenant_id AND s.id = po.supplier_id
        WHERE po.branch_id = ${q.branch_id} ${q.status ? tx`AND po.status = ${q.status}` : tx``}
        ORDER BY po.created_at DESC`;
    });
  });

  app.post('/v1/purchase-orders/:id/send', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ expected_on: isoDate.nullish() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'purchasing.order');
      const [po] = await tx<{ status: string; branch_id: string; supplier_id: string }[]>`
        SELECT status, branch_id, supplier_id FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
      if (!po) throw notFound('Purchase order');
      requireBranchAccess(actor, po.branch_id);
      if (po.status !== 'draft') throw conflict(`Purchase order is ${po.status}`);
      const [s] = await tx<{ order_method: string; email: string | null }[]>`SELECT order_method, email FROM suppliers WHERE id = ${po.supplier_id}`;
      const [sent] = await tx`
        UPDATE purchase_orders SET status = 'sent', sent_at = now(), sent_via = ${s!.order_method}, expected_on = ${body.expected_on ?? null}
        WHERE id = ${id} RETURNING *`;
      if (s!.order_method === 'email' && s!.email) {
        await enqueueEvent(tx, tenantId, 'purchase_order.send', 'purchase_order', id, { purchase_order_id: id, to: s!.email });
      }
      return sent;
    });
  });

  // ------------------------------------------------------------ supplier invoices (OCR)
  app.post('/v1/invoices', async (req, reply) => {
    const body = parse(z.object({
      branch_id: uuid, file_name: z.string().min(1), mime_type: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
      content_base64: z.string().min(1), purchase_order_id: uuid.nullish(),
    }), req.body);
    if (!deps.files) throw unprocessable('File storage is not configured');
    const bytes = Buffer.from(body.content_base64, 'base64');
    if (bytes.length > 20 * 1024 * 1024) throw unprocessable('File is larger than 20 MB');
    const tenantId = req.auth!.tid;
    const key = storageKeyFor(tenantId, 'invoices', body.file_name);
    await deps.files.put(key, bytes, body.mime_type);
    const row = await tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'invoices.upload');
      requireBranchAccess(actor, body.branch_id);
      await requireBranchExists(tx, body.branch_id);
      const [att] = await tx<{ id: string }[]>`
        INSERT INTO attachments (tenant_id, storage_key, file_name, mime_type, size_bytes, sha256, uploaded_by)
        VALUES (${tenantId}, ${key}, ${body.file_name}, ${body.mime_type}, ${bytes.length},
                ${createHash('sha256').update(bytes).digest('hex')}, ${actor.staffId}) RETURNING id`;
      const [inv] = await tx<{ id: string }[]>`
        INSERT INTO supplier_invoices (tenant_id, branch_id, purchase_order_id, file_attachment_id, uploaded_by)
        VALUES (${tenantId}, ${body.branch_id}, ${body.purchase_order_id ?? null}, ${att!.id}, ${actor.staffId}) RETURNING *`;
      await enqueueEvent(tx, tenantId, 'invoice.ocr_requested', 'supplier_invoice', inv!.id, { invoice_id: inv!.id });
      return inv;
    });
    return reply.status(201).send(row);
  });

  app.get('/v1/invoices', async (req) => {
    const q = parse(z.object({ branch_id: uuid, status: z.string().optional() }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requireAnyPermission(actor, 'invoices.upload', 'invoices.approve');
      requireBranchAccess(actor, q.branch_id);
      return tx`
        SELECT i.id, i.status, i.invoice_number, i.invoice_date, i.total_pence, i.ocr_confidence, i.ocr_error, i.created_at,
               s.name AS supplier_name
        FROM supplier_invoices i LEFT JOIN suppliers s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
        WHERE i.branch_id = ${q.branch_id} ${q.status ? tx`AND i.status = ${q.status}` : tx``}
        ORDER BY i.created_at DESC`;
    });
  });

  app.get('/v1/invoices/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requireAnyPermission(actor, 'invoices.upload', 'invoices.approve');
      const [inv] = await tx<{ branch_id: string }[]>`
        SELECT i.*, s.name AS supplier_name FROM supplier_invoices i
        LEFT JOIN suppliers s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id WHERE i.id = ${id}`;
      if (!inv) throw notFound('Invoice');
      requireBranchAccess(actor, inv.branch_id);
      const lines = await tx`
        SELECT l.*, p.name AS product_name FROM supplier_invoice_lines l
        LEFT JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
        WHERE l.invoice_id = ${id} ORDER BY l.line_no`;
      return { ...inv, lines };
    });
  });

  // Typed in by hand, or a corrected OCR result. Same shape the OCR returns.
  app.put('/v1/invoices/:id/extraction', async (req) => {
    const { id } = parse(idParam, req.params);
    const result = ocrInvoiceSchema.safeParse(req.body);
    if (!result.success) throw unprocessable('Invalid invoice data', result.error.issues);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'invoices.upload');
      const [inv] = await tx<{ branch_id: string }[]>`SELECT branch_id FROM supplier_invoices WHERE id = ${id}`;
      if (!inv) throw notFound('Invoice');
      requireBranchAccess(actor, inv.branch_id);
      return applyExtraction(tx, tenantId, id, { provider: 'manual', model: 'manual', result: result.data, raw: result.data });
    });
  });

  app.patch('/v1/invoices/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ supplier_id: uuid.optional(), invoice_number: z.string().optional(), invoice_date: isoDate.optional(),
      purchase_order_id: uuid.nullish() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'invoices.approve');
      const [inv] = await tx`
        UPDATE supplier_invoices SET ${tx(body as never)}, reviewed_by = ${actor.staffId}
        WHERE id = ${id} AND status IN ('uploaded','needs_review','approved','failed') RETURNING *`;
      if (!inv) throw notFound('Invoice (or it is already posted)');
      return inv;
    });
  });

  // Human fixes a line: pick the right product (or ignore). This mapping is
  // what teaches the system — it is saved as supplier code -> product on post.
  app.patch('/v1/invoices/:id/lines/:lineId', async (req) => {
    const { id, lineId } = parse(z.object({ id: uuid, lineId: uuid }), req.params);
    const body = parse(z.object({
      product_id: uuid.nullish(), ignore: z.boolean().optional(), quantity: z.number().positive().optional(),
      pack_size: z.number().positive().optional(), unit_cost_pence: pence.optional(), expiry_date: isoDate.nullish(),
    }), req.body);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'invoices.approve');
      const [inv] = await tx<{ status: string }[]>`SELECT status FROM supplier_invoices WHERE id = ${id}`;
      if (!inv) throw notFound('Invoice');
      if (!['needs_review', 'approved'].includes(inv.status)) throw conflict(`Invoice is ${inv.status}`);
      const { ignore, ...fields } = body;
      const update: Record<string, unknown> = { ...fields };
      if (ignore) Object.assign(update, { match_status: 'ignored', product_id: null, matched_by: actor.staffId });
      else if (body.product_id) Object.assign(update, { match_status: 'matched_manual', match_confidence: 1, matched_by: actor.staffId });
      const [l] = await tx`UPDATE supplier_invoice_lines SET ${tx(update as never)} WHERE id = ${lineId} AND invoice_id = ${id} RETURNING *`;
      if (!l) throw notFound('Invoice line');
      return l;
    });
  });

  app.post('/v1/invoices/:id/post', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor, tenantId, auth }) => {
      requirePermission(actor, 'invoices.approve');
      const [inv] = await tx<{ branch_id: string }[]>`SELECT branch_id FROM supplier_invoices WHERE id = ${id}`;
      if (!inv) throw notFound('Invoice');
      requireBranchAccess(actor, inv.branch_id);
      return postInvoice(tx, tenantId, id, actor.staffId, auth.did ?? null);
    });
  });

  app.post('/v1/invoices/:id/reject', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ reason: z.string().min(1) }), req.body);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'invoices.approve');
      const [inv] = await tx`
        UPDATE supplier_invoices SET status = 'rejected', ocr_error = ${body.reason}, reviewed_by = ${actor.staffId}
        WHERE id = ${id} AND status <> 'posted' RETURNING *`;
      if (!inv) throw forbidden('Posted invoices cannot be rejected; post a correcting adjustment instead');
      return inv;
    });
  });
}
