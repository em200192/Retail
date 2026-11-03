import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextOf, type Deps, requirePosToken } from '../app.ts';
import { loadActor, requirePermission } from '../lib/authz.ts';
import { forbidden } from '../lib/errors.ts';
import { isoDateTime, parse } from '../lib/validate.ts';
import { type DeviceContext, ingestRefund, ingestSale, refundSchema, saleSchema, type SyncOutcome, toOutcome } from '../services/sync.ts';

export async function syncRoutes(app: FastifyInstance, deps: Deps) {
  /**
   * The till uploads its offline queue. Each sale/refund is its own
   * transaction, so one bad record never blocks the rest; the device keeps
   * 'rejected' items for a manager to look at and drops created/duplicate.
   */
  app.post('/v1/sync/push', async (req) => {
    const pos = requirePosToken(req);
    const body = parse(z.object({
      sales: z.array(z.unknown()).max(500).default([]),
      refunds: z.array(z.unknown()).max(500).default([]),
    }), req.body);
    const ctx = contextOf(req);
    const dev: DeviceContext = { tenantId: pos.tid, deviceId: pos.did, branchId: pos.bid };

    // The device itself must still be active.
    await deps.db.withTenant(ctx, async (tx) => {
      const [d] = await tx<{ is_active: boolean }[]>`SELECT is_active FROM devices WHERE id = ${pos.did}`;
      if (!d?.is_active) throw forbidden('Device has been deactivated');
      const actor = await loadActor(tx, pos.sid);
      requirePermission(actor, 'pos.sell');
    });

    const run = async <T extends { id: string }>(raw: unknown, schema: z.ZodType<T>,
      ingest: (tx: Parameters<typeof ingestSale>[0], dev: DeviceContext, p: T) => Promise<'created' | 'duplicate'>): Promise<SyncOutcome> => {
      const parsed = schema.safeParse(raw);
      const id = (raw as { id?: string })?.id ?? 'unknown';
      if (!parsed.success) {
        return { id, status: 'rejected', error: 'invalid', message: 'Invalid payload',
          details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
      }
      try {
        const status = await deps.db.withTenant(ctx, (tx) => ingest(tx, dev, parsed.data));
        return { id: parsed.data.id, status };
      } catch (err) {
        return toOutcome(parsed.data.id, err);
      }
    };

    const sales: SyncOutcome[] = [];
    for (const s of body.sales) sales.push(await run(s, saleSchema as z.ZodType<z.infer<typeof saleSchema>>, ingestSale));
    const refunds: SyncOutcome[] = [];
    for (const r of body.refunds) refunds.push(await run(r, refundSchema as z.ZodType<z.infer<typeof refundSchema>>, ingestRefund));

    await deps.db.withTenant(ctx, (tx) => tx`UPDATE devices SET last_sync_at = now(), last_seen_at = now() WHERE id = ${pos.did}`);
    return { sales, refunds };
  });

  /**
   * Everything the till needs to work offline for its branch: catalogue,
   * barcodes, prices per level (already resolved), scale rules, VAT rates,
   * promotions and the effective permissions/limits of staff at the branch.
   * Pass ?since= to get only products changed since the last pull.
   */
  app.get('/v1/sync/pull', async (req) => {
    const pos = requirePosToken(req);
    const q = parse(z.object({ since: isoDateTime.optional() }), req.query);
    const ctx = contextOf(req);
    return deps.db.withTenant(ctx, async (tx) => {
      const actor = await loadActor(tx, pos.sid);
      requirePermission(actor, 'pos.sell');
      const since = q.since ? new Date(q.since) : null;
      const serverTime = new Date().toISOString();
      const [branch] = await tx`SELECT id, code, name, timezone, settings FROM branches WHERE id = ${pos.bid}`;
      const [device] = await tx`SELECT id, device_no, name FROM devices WHERE id = ${pos.did}`;
      const products = await tx`
        SELECT p.id, p.name, p.name_i18n, p.category_id, p.vat_code, p.min_age, p.sold_by_weight, p.unit_type, p.track_stock,
               p.is_active, p.archived_at, p.avg_cost_pence, p.updated_at, COALESCE(pbs.is_ranged, true) AS is_ranged
        FROM products p
        LEFT JOIN product_branch_settings pbs ON pbs.tenant_id = p.tenant_id AND pbs.product_id = p.id AND pbs.branch_id = ${pos.bid}
        ${since ? tx`WHERE p.updated_at > ${since}
                       OR EXISTS (SELECT 1 FROM product_prices pp WHERE pp.tenant_id = p.tenant_id AND pp.product_id = p.id AND pp.created_at > ${since})
                       OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.tenant_id = p.tenant_id AND b.product_id = p.id AND b.created_at > ${since})` : tx``}
        ORDER BY p.name`;
      const ids = products.map((p) => p.id as string);
      const [barcodes, prices] = ids.length ? await Promise.all([
        tx`SELECT id, product_id, barcode, barcode_type, units_per_scan, is_pmp, pmp_price_pence FROM product_barcodes WHERE product_id IN ${tx(ids)}`,
        // All currently-valid price rows for this branch (+ future-dated ones, so the till switches on time).
        tx`SELECT product_id, price_level_id, branch_id, min_qty, price_pence, valid_from, valid_to
           FROM product_prices
           WHERE product_id IN ${tx(ids)} AND (branch_id IS NULL OR branch_id = ${pos.bid})
             AND (valid_to IS NULL OR valid_to > now())
           ORDER BY product_id, valid_from`,
      ]) : [[], []];
      const staff = await tx`
        SELECT s.id, s.display_name, r.system_key AS role_key,
               COALESCE((SELECT array_agg(permission_code) FROM v_staff_permissions v WHERE v.staff_id = s.id), '{}') AS permissions,
               COALESCE((SELECT jsonb_object_agg(limit_code, value) FROM v_staff_limits l WHERE l.staff_id = s.id), '{}') AS limits
        FROM staff s JOIN roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id
        WHERE s.status = 'active' AND (r.system_key = 'owner' OR EXISTS (
          SELECT 1 FROM staff_branch_access a WHERE a.tenant_id = s.tenant_id AND a.staff_id = s.id AND a.branch_id = ${pos.bid}))`;
      return {
        server_time: serverTime,
        full: !since,
        branch, device, products, barcodes, prices, staff,
        categories: await tx`SELECT id, parent_id, name, name_i18n, sort_order, is_active FROM categories`,
        price_levels: await tx`SELECT id, code, name, is_default, requires_customer FROM price_levels ORDER BY sort_order`,
        barcode_rules: await tx`SELECT * FROM barcode_rules WHERE is_active`,
        vat_rates: await tx`SELECT * FROM vat_rates`,
        tills: await tx`SELECT id, name, device_id FROM tills WHERE branch_id = ${pos.bid} AND is_active`,
        promotions: await tx`
          SELECT p.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'required_qty', g.required_qty,
                   'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'category_id', i.category_id)), '[]')
                             FROM promotion_group_items i WHERE i.tenant_id = g.tenant_id AND i.group_id = g.id)) ORDER BY g.position)
                 FROM promotion_groups g WHERE g.tenant_id = p.tenant_id AND g.promotion_id = p.id), '[]') AS groups
          FROM promotions p
          WHERE p.is_active AND (p.ends_at IS NULL OR p.ends_at > now())
            AND (NOT EXISTS (SELECT 1 FROM promotion_branches pb WHERE pb.tenant_id = p.tenant_id AND pb.promotion_id = p.id)
                 OR EXISTS (SELECT 1 FROM promotion_branches pb WHERE pb.tenant_id = p.tenant_id AND pb.promotion_id = p.id AND pb.branch_id = ${pos.bid}))`,
      };
    });
  });
}
