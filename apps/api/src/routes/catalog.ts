import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, tenantTx } from '../app.ts';
import { requireBranchAccess, requirePermission } from '../lib/authz.ts';
import type { Tx } from '../lib/db.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { enqueueEvent } from '../lib/outbox.ts';
import { idParam, isoDateTime, parse, pence, uuid, vatCode } from '../lib/validate.ts';
import { resolveScan } from '../services/scan.ts';

const barcodeSchema = z.object({
  barcode: z.string().min(1).max(64),
  barcode_type: z.enum(['EAN13', 'EAN8', 'UPCA', 'UPCE', 'ITF14', 'CODE128', 'PLU', 'INTERNAL']).default('EAN13'),
  units_per_scan: z.number().positive().default(1),
  is_pmp: z.boolean().default(false),
  pmp_price_pence: pence.nullish(),
  is_primary: z.boolean().default(false),
}).refine((b) => !b.is_pmp || b.pmp_price_pence != null, 'PMP barcodes need pmp_price_pence');

const productFields = z.object({
  name: z.string().min(1),
  name_i18n: z.record(z.string()).optional(),
  category_id: uuid.nullish(),
  sku: z.string().nullish(),
  brand: z.string().nullish(),
  size_text: z.string().nullish(),
  description: z.string().nullish(),
  image_url: z.string().url().nullish(),
  unit_type: z.enum(['each', 'kg', 'g', 'l', 'ml']).optional(),
  sold_by_weight: z.boolean().optional(),
  vat_code: vatCode.optional(),
  min_age: z.number().int().min(12).max(25).nullish(),
  is_hfss: z.boolean().optional(),
  track_stock: z.boolean().optional(),
  track_expiry: z.boolean().optional(),
  allow_negative_stock: z.boolean().optional(),
  reorder_point: z.number().nonnegative().nullish(),
  reorder_qty: z.number().positive().nullish(),
  catalog_product_id: uuid.nullish(),
});

const createProductSchema = productFields.extend({
  barcodes: z.array(barcodeSchema).default([]),
  price_pence: pence.optional(),       // retail (default level) price, all branches
});

const priceSchema = z.object({
  price_pence: pence,
  price_level_id: uuid.optional(),
  branch_id: uuid.nullish(),
  min_qty: z.number().positive().default(1),
  valid_from: isoDateTime.optional(),
  valid_to: isoDateTime.nullish(),
});

async function addPrice(tx: Tx, tenantId: string, staffId: string, productId: string, p: z.infer<typeof priceSchema>) {
  const [level] = p.price_level_id
    ? await tx<{ id: string }[]>`SELECT id FROM price_levels WHERE id = ${p.price_level_id}`
    : await tx<{ id: string }[]>`SELECT id FROM price_levels WHERE is_default`;
  if (!level) throw notFound('Price level');
  // Price changes are always a NEW row; history is never rewritten.
  const [row] = await tx`
    INSERT INTO product_prices (tenant_id, product_id, price_level_id, branch_id, min_qty, price_pence, valid_from, valid_to, created_by)
    VALUES (${tenantId}, ${productId}, ${level.id}, ${p.branch_id ?? null}, ${p.min_qty}, ${p.price_pence},
            ${p.valid_from ? new Date(p.valid_from) : new Date()}, ${p.valid_to ? new Date(p.valid_to) : null}, ${staffId})
    RETURNING *`;
  await enqueueEvent(tx, tenantId, 'price.changed', 'product', productId, {
    product_id: productId, price_level_id: level.id, branch_id: p.branch_id ?? null, price_pence: p.price_pence,
  });
  return row;
}

async function insertBarcodes(tx: Tx, tenantId: string, productId: string, barcodes: z.infer<typeof barcodeSchema>[]) {
  if (!barcodes.length) return;
  await tx`INSERT INTO product_barcodes ${tx(barcodes.map((b) => ({
    tenant_id: tenantId, product_id: productId, ...b, pmp_price_pence: b.pmp_price_pence ?? null,
  })) as never)}`;
}

export async function catalogRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------ categories
  app.get('/v1/categories', async (req) =>
    tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'products.view');
      return tx`SELECT * FROM categories ORDER BY sort_order, name`;
    }));

  const categorySchema = z.object({
    name: z.string().min(1), name_i18n: z.record(z.string()).optional(), parent_id: uuid.nullish(),
    default_vat_code: vatCode.nullish(), default_min_age: z.number().int().min(12).max(25).nullish(),
    sort_order: z.number().int().optional(), is_active: z.boolean().optional(),
  });

  app.post('/v1/categories', async (req, reply) => {
    const body = parse(categorySchema, req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'products.edit');
      const [c] = await tx`INSERT INTO categories ${tx({ ...body, tenant_id: tenantId } as never)} RETURNING *`;
      return c;
    });
    return reply.status(201).send(row);
  });

  app.patch('/v1/categories/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(categorySchema.partial(), req.body);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'products.edit');
      const [c] = await tx`UPDATE categories SET ${tx(body as never)} WHERE id = ${id} RETURNING *`;
      if (!c) throw notFound('Category');
      return c;
    });
  });

  // ------------------------------------------------------------ products
  app.get('/v1/products', async (req) => {
    const q = parse(z.object({
      q: z.string().optional(), category_id: uuid.optional(), include_archived: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0),
    }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'products.view');
      const term = q.q?.trim();
      return tx`
        SELECT p.id, p.name, p.brand, p.size_text, p.sku, p.category_id, p.vat_code, p.min_age, p.is_active,
               p.sold_by_weight, p.track_stock, p.archived_at, p.last_cost_pence, p.avg_cost_pence,
               resolve_price(p.id, NULL, NULL) AS retail_price_pence,
               (SELECT barcode FROM product_barcodes b WHERE b.tenant_id = p.tenant_id AND b.product_id = p.id
                ORDER BY is_primary DESC, created_at LIMIT 1) AS barcode
        FROM products p
        WHERE ${q.include_archived ? tx`true` : tx`p.archived_at IS NULL`}
          ${q.category_id ? tx`AND p.category_id = ${q.category_id}` : tx``}
          ${term ? tx`AND (p.name ILIKE ${'%' + term + '%'} OR p.name % ${term} OR p.sku = ${term}
                       OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.tenant_id = p.tenant_id
                                  AND b.product_id = p.id AND b.barcode = ${term}))` : tx``}
        ORDER BY ${term ? tx`similarity(p.name, ${term}) DESC,` : tx``} p.name
        LIMIT ${q.limit} OFFSET ${q.offset}`;
    });
  });

  app.get('/v1/products/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'products.view');
      const [p] = await tx`SELECT * FROM products WHERE id = ${id}`;
      if (!p) throw notFound('Product');
      const [barcodes, prices, stock] = await Promise.all([
        tx`SELECT * FROM product_barcodes WHERE product_id = ${id} ORDER BY is_primary DESC, created_at`,
        tx`
          SELECT DISTINCT ON (pp.price_level_id, pp.branch_id, pp.min_qty)
                 pp.id, pp.price_level_id, pl.code AS price_level_code, pp.branch_id, pp.min_qty, pp.price_pence, pp.valid_from, pp.valid_to
          FROM product_prices pp JOIN price_levels pl ON pl.tenant_id = pp.tenant_id AND pl.id = pp.price_level_id
          WHERE pp.product_id = ${id} AND pp.valid_from <= now() AND (pp.valid_to IS NULL OR pp.valid_to > now())
          ORDER BY pp.price_level_id, pp.branch_id, pp.min_qty, pp.valid_from DESC`,
        tx`SELECT branch_id, on_hand, reserved, available FROM v_stock_availability WHERE product_id = ${id}`,
      ]);
      const visibleStock = stock.filter((s) => actor.isOwner || actor.branchIds.has(s.branch_id as string));
      return { ...p, barcodes, current_prices: prices, stock: actor.permissions.has('stock.view') ? visibleStock : undefined };
    });
  });

  app.post('/v1/products', async (req, reply) => {
    const body = parse(createProductSchema, req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'products.edit');
      if (body.price_pence !== undefined) requirePermission(actor, 'prices.edit');
      const { barcodes, price_pence, ...fields } = body;
      // Category defaults (VAT code, age restriction) apply when not given.
      if (fields.category_id && (fields.vat_code === undefined || fields.min_age === undefined)) {
        const [cat] = await tx<{ default_vat_code: string | null; default_min_age: number | null }[]>`
          SELECT default_vat_code, default_min_age FROM categories WHERE id = ${fields.category_id}`;
        if (!cat) throw notFound('Category');
        if (fields.vat_code === undefined && cat.default_vat_code) fields.vat_code = cat.default_vat_code as never;
        if (fields.min_age === undefined && cat.default_min_age) fields.min_age = cat.default_min_age;
      }
      if (fields.sold_by_weight && !fields.unit_type) fields.unit_type = 'kg';
      const [p] = await tx<{ id: string }[]>`INSERT INTO products ${tx({ ...fields, tenant_id: tenantId } as never)} RETURNING *`;
      await insertBarcodes(tx, tenantId, p!.id, barcodes);
      if (price_pence !== undefined) await addPrice(tx, tenantId, actor.staffId, p!.id, { price_pence, min_qty: 1 });
      await enqueueEvent(tx, tenantId, 'product.changed', 'product', p!.id, { product_id: p!.id, action: 'created' });
      return p;
    });
    return reply.status(201).send(row);
  });

  // Unknown barcode scanned -> copy from the shared UK catalogue.
  app.post('/v1/products/from-catalog', async (req, reply) => {
    const body = parse(z.object({ gtin: z.string(), category_id: uuid.nullish(), price_pence: pence.optional() }), req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'products.edit');
      if (body.price_pence !== undefined) requirePermission(actor, 'prices.edit');
      const [c] = await tx`SELECT * FROM catalog_products WHERE gtin = ${body.gtin}`;
      if (!c) throw notFound('Catalogue product');
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO products (tenant_id, catalog_product_id, category_id, name, brand, size_text, image_url, vat_code, min_age, is_hfss)
        VALUES (${tenantId}, ${c.id}, ${body.category_id ?? null}, ${c.name}, ${c.brand}, ${c.size_text}, ${c.image_url},
                ${c.vat_code ?? 'S'}, ${c.min_age}, ${c.is_hfss ?? false})
        RETURNING *`;
      await insertBarcodes(tx, tenantId, p!.id, [{ barcode: c.gtin as string, barcode_type: (c.gtin as string).length === 8 ? 'EAN8' : 'EAN13',
        units_per_scan: 1, is_pmp: c.is_pmp as boolean, pmp_price_pence: c.pmp_price_pence as number | null, is_primary: true }]);
      if (body.price_pence !== undefined) await addPrice(tx, tenantId, actor.staffId, p!.id, { price_pence: body.price_pence, min_qty: 1 });
      return p;
    });
    return reply.status(201).send(row);
  });

  app.patch('/v1/products/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(productFields.partial().extend({ is_active: z.boolean().optional(), archived: z.boolean().optional() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'products.edit');
      const { archived, ...fields } = body;
      const update: Record<string, unknown> = { ...fields };
      if (archived !== undefined) update.archived_at = archived ? new Date() : null;
      if (Object.keys(update).length === 0) throw unprocessable('Nothing to update');
      const [p] = await tx`UPDATE products SET ${tx(update as never)} WHERE id = ${id} RETURNING *`;
      if (!p) throw notFound('Product');
      await enqueueEvent(tx, tenantId, 'product.changed', 'product', id, { product_id: id, action: 'updated' });
      return p;
    });
  });

  app.post('/v1/products/:id/barcodes', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(barcodeSchema, req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'products.edit');
      const [p] = await tx`SELECT 1 FROM products WHERE id = ${id}`;
      if (!p) throw notFound('Product');
      const [taken] = await tx<{ name: string }[]>`
        SELECT p.name FROM product_barcodes b JOIN products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id WHERE b.barcode = ${body.barcode}`;
      if (taken) throw conflict(`This barcode is already on ${taken.name}`, { product_name: taken.name });
      if (body.is_primary) await tx`UPDATE product_barcodes SET is_primary = false WHERE product_id = ${id}`;
      const [b] = await tx`INSERT INTO product_barcodes ${tx({ ...body, tenant_id: tenantId, product_id: id,
        pmp_price_pence: body.pmp_price_pence ?? null } as never)} RETURNING *`;
      return b;
    });
    return reply.status(201).send(row);
  });

  app.delete('/v1/products/:id/barcodes/:barcodeId', async (req, reply) => {
    const { id, barcodeId } = parse(z.object({ id: uuid, barcodeId: uuid }), req.params);
    await tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'products.edit');
      const r = await tx`DELETE FROM product_barcodes WHERE id = ${barcodeId} AND product_id = ${id} RETURNING id`;
      if (!r.length) throw notFound('Barcode');
    });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------ prices
  app.post('/v1/products/:id/prices', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(priceSchema, req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'prices.edit');
      if (body.branch_id) requireBranchAccess(actor, body.branch_id);
      const [p] = await tx`SELECT 1 FROM products WHERE id = ${id}`;
      if (!p) throw notFound('Product');
      return addPrice(tx, tenantId, actor.staffId, id, body);
    });
    return reply.status(201).send(row);
  });

  app.get('/v1/products/:id/prices', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'products.view');
      return tx`
        SELECT pp.*, pl.code AS price_level_code FROM product_prices pp
        JOIN price_levels pl ON pl.tenant_id = pp.tenant_id AND pl.id = pp.price_level_id
        WHERE pp.product_id = ${id} ORDER BY pp.valid_from DESC`;
    });
  });

  app.get('/v1/price-levels', async (req) =>
    tenantTx(deps, req, async ({ tx }) => tx`SELECT * FROM price_levels ORDER BY sort_order, name`));

  app.post('/v1/price-levels', async (req, reply) => {
    const body = parse(z.object({ code: z.string().regex(/^[a-z0-9_]+$/), name: z.string().min(1),
      requires_customer: z.boolean().default(false), sort_order: z.number().int().default(10) }), req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'prices.edit');
      const [l] = await tx`INSERT INTO price_levels ${tx({ ...body, tenant_id: tenantId } as never)} RETURNING *`;
      return l;
    });
    return reply.status(201).send(row);
  });

  // ------------------------------------------------------------ scale barcode rules
  app.get('/v1/barcode-rules', async (req) =>
    tenantTx(deps, req, async ({ tx }) => tx`SELECT * FROM barcode_rules ORDER BY prefix`));

  app.post('/v1/barcode-rules', async (req, reply) => {
    const body = parse(z.object({
      name: z.string().min(1), prefix: z.string().regex(/^[0-9]{1,3}$/), barcode_length: z.number().int().default(13),
      item_code_start: z.number().int().positive(), item_code_length: z.number().int().positive(),
      value_type: z.enum(['price_pence', 'weight_g']), value_start: z.number().int().positive(),
      value_length: z.number().int().positive(),
    }), req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'products.edit');
      const [r] = await tx`INSERT INTO barcode_rules ${tx({ ...body, tenant_id: tenantId } as never)} RETURNING *`;
      return r;
    });
    return reply.status(201).send(row);
  });

  // ------------------------------------------------------------ scanning
  app.get('/v1/scan', async (req) => {
    const q = parse(z.object({ barcode: z.string().min(1), branch_id: uuid.optional(), price_level_id: uuid.optional() }), req.query);
    return tenantTx(deps, req, async ({ tx, actor, auth }) => {
      requirePermission(actor, 'products.view');
      const branchId = q.branch_id ?? auth.bid;
      if (!branchId) throw unprocessable('branch_id is required');
      requireBranchAccess(actor, branchId);
      return resolveScan(tx, { barcode: q.barcode, branchId, priceLevelId: q.price_level_id });
    });
  });

  app.get('/v1/catalog/search', async (req) => {
    const q = parse(z.object({ q: z.string().min(2) }), req.query);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'products.view');
      return tx`
        SELECT id, gtin, name, brand, size_text, category_hint, image_url, vat_code, is_pmp, pmp_price_pence, min_age
        FROM catalog_products WHERE gtin = ${q.q} OR name % ${q.q} OR name ILIKE ${'%' + q.q + '%'}
        ORDER BY (gtin = ${q.q}) DESC, similarity(name, ${q.q}) DESC LIMIT 25`;
    });
  });
}
