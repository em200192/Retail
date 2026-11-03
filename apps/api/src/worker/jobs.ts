import type { Db, Tx } from '../lib/db.ts';
import type { DeliveryChannelAdapter, MessageChannelAdapter } from '../integrations/adapters.ts';
import type { FileStore } from '../integrations/files.ts';
import { OcrRefusedError, type OcrProvider } from '../integrations/ocr.ts';
import { applyExtraction } from '../services/invoices.ts';

export interface WorkerDeps {
  db: Db;
  ocr?: OcrProvider;
  files?: FileStore;
  delivery?: Map<string, DeliveryChannelAdapter>;
  messages?: Map<string, MessageChannelAdapter>;
  log?: (msg: string, extra?: unknown) => void;
}

export interface OutboxEvent {
  tenant_id: string;
  id: number;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

export const MAX_ATTEMPTS = 8;
/** 30s, 60s, 2m, 4m ... capped at 1h. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);
}

type Handler = (deps: WorkerDeps, e: OutboxEvent) => Promise<void>;

const NOTIFY_EVENTS: Record<string, { pref: string; subject: string }> = {
  'notify.purchase_request': { pref: 'purchase_request', subject: 'New staff request' },
  'notify.cash_variance': { pref: 'cash_variance', subject: 'Till cash variance' },
  'notify.invoice_ready': { pref: 'invoice_ready', subject: 'Supplier invoice ready to review' },
  'notify.low_stock': { pref: 'low_stock', subject: 'Low stock' },
};

/**
 * Notifications are channel-agnostic: write outbound_messages rows; a
 * MessageChannelAdapter per channel delivers them. Recipients = staff who
 * opted in for this event, or (no preferences set) owners and managers.
 */
async function notify(deps: WorkerDeps, e: OutboxEvent) {
  const cfg = NOTIFY_EVENTS[e.event_type]!;
  await deps.db.asWorker(async (tx) => {
    const recipients = await tx<{ id: string; email: string; locale: string; channel: string }[]>`
      SELECT s.id, s.email, s.locale, np.channel FROM notification_preferences np
      JOIN staff s ON s.tenant_id = np.tenant_id AND s.id = np.staff_id
      WHERE np.tenant_id = ${e.tenant_id} AND np.event_type = ${cfg.pref} AND np.is_enabled AND s.status = 'active'
        AND s.email IS NOT NULL
      UNION
      SELECT s.id, s.email, s.locale, 'email' FROM staff s JOIN roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id
      WHERE s.tenant_id = ${e.tenant_id} AND r.system_key IN ('owner','manager') AND s.status = 'active' AND s.email IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM notification_preferences np WHERE np.tenant_id = s.tenant_id AND np.event_type = ${cfg.pref})`;
    for (const r of recipients) {
      await tx`
        INSERT INTO outbound_messages (tenant_id, channel, template_code, locale, staff_id, to_address, subject, payload)
        VALUES (${e.tenant_id}, ${r.channel}, ${cfg.pref}, ${r.locale}, ${r.id}, ${r.email}, ${cfg.subject}, ${tx.json(e.payload as never)})`;
    }
  });
}

const handlers: Record<string, Handler> = {
  'invoice.ocr_requested': async (deps, e) => {
    const invoiceId = String(e.payload.invoice_id);
    if (!deps.ocr || !deps.files) return; // no OCR configured: invoice stays 'uploaded' for manual entry
    const ctx = { tenantId: e.tenant_id, staffId: null, userId: null, deviceId: null };
    const inv = await deps.db.withTenant(ctx, async (tx) => {
      const [row] = await tx<{ status: string; storage_key: string; mime_type: string; parser_key: string | null }[]>`
        UPDATE supplier_invoices i SET status = 'processing'
        FROM attachments a
        WHERE i.id = ${invoiceId} AND a.tenant_id = i.tenant_id AND a.id = i.file_attachment_id AND i.status IN ('uploaded','processing','failed')
        RETURNING i.status, a.storage_key, a.mime_type,
          (SELECT g.invoice_parser_key FROM suppliers s JOIN global_suppliers g ON g.id = s.global_supplier_id
            WHERE s.tenant_id = i.tenant_id AND s.id = i.supplier_id) AS parser_key`;
      return row;
    });
    if (!inv) return;
    try {
      const bytes = await deps.files.get(inv.storage_key);
      const out = await deps.ocr.extract({ bytes, mimeType: inv.mime_type, parserKey: inv.parser_key });
      await deps.db.withTenant(ctx, (tx) => applyExtraction(tx, e.tenant_id, invoiceId, out));
    } catch (err) {
      const final = err instanceof OcrRefusedError || e.attempts + 1 >= MAX_ATTEMPTS;
      await deps.db.withTenant(ctx, (tx) => tx`
        UPDATE supplier_invoices SET status = ${final ? 'failed' : 'uploaded'}, ocr_error = ${(err as Error).message}
        WHERE id = ${invoiceId}`);
      if (!final) throw err; // retried with backoff
    }
  },

  // Keep delivery platforms in sync with what is actually on the shelf.
  'stock.changed': async (deps, e) => {
    if (!deps.delivery?.size) return;
    const branchId = String(e.payload.branch_id);
    const productIds = (e.payload.product_ids as string[]) ?? [];
    const work = await deps.db.asWorker(async (tx) => {
      const conns = await tx<{ id: string; provider: string; external_store_id: string | null; credentials_secret_ref: string | null; config: Record<string, unknown> }[]>`
        SELECT id, provider, external_store_id, credentials_secret_ref, config FROM integration_connections
        WHERE tenant_id = ${e.tenant_id} AND branch_id = ${branchId} AND status = 'active'
          AND provider IN ('uber_eats','deliveroo','just_eat','snappy_shopper')`;
      const out = [];
      for (const c of conns) {
        const changes = await tx<{ product_id: string; external_item_id: string | null; available: number }[]>`
          SELECT l.product_id, l.external_item_id, GREATEST(COALESCE(a.available, 0), 0) AS available
          FROM external_product_links l
          LEFT JOIN v_stock_availability a ON a.tenant_id = l.tenant_id AND a.branch_id = ${branchId} AND a.product_id = l.product_id
          WHERE l.tenant_id = ${e.tenant_id} AND l.connection_id = ${c.id} AND l.is_listed AND l.product_id IN ${tx(productIds)}`;
        if (changes.length) out.push({ c, changes });
      }
      return out;
    });
    for (const { c, changes } of work) {
      const adapter = deps.delivery.get(c.provider);
      if (!adapter) continue;
      await adapter.pushStock(
        { tenantId: e.tenant_id, connectionId: c.id, externalStoreId: c.external_store_id, credentialsSecretRef: c.credentials_secret_ref, config: c.config },
        changes.map((x) => ({ productId: x.product_id, externalItemId: x.external_item_id, available: x.available })));
    }
  },

  'purchase_order.send': async (deps, e) => {
    await deps.db.asWorker((tx) => tx`
      INSERT INTO outbound_messages (tenant_id, channel, template_code, to_address, subject, payload)
      VALUES (${e.tenant_id}, 'email', 'purchase_order', ${String(e.payload.to)}, 'Purchase order', ${tx.json(e.payload as never)})`);
  },
};
for (const type of Object.keys(NOTIFY_EVENTS)) handlers[type] = notify;

/**
 * Publish a batch of outbox events. Rows are locked FOR UPDATE SKIP LOCKED,
 * so several workers can run side by side. Failures retry with backoff via
 * available_at; events with no handler are simply marked published.
 */
export async function publishOutbox(deps: WorkerDeps, batchSize = 50): Promise<{ published: number; failed: number }> {
  let published = 0, failed = 0;
  await deps.db.asWorker(async (tx: Tx) => {
    const events = await tx<OutboxEvent[]>`
      SELECT tenant_id, id, event_type, aggregate_type, aggregate_id, payload, attempts FROM outbox_events
      WHERE published_at IS NULL AND available_at <= now() AND attempts < ${MAX_ATTEMPTS}
      ORDER BY available_at, id LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED`;
    for (const e of events) {
      try {
        await handlers[e.event_type]?.(deps, e);
        await tx`UPDATE outbox_events SET published_at = now(), attempts = attempts + 1, last_error = NULL
                 WHERE tenant_id = ${e.tenant_id} AND id = ${e.id}`;
        published++;
      } catch (err) {
        failed++;
        deps.log?.(`outbox ${e.event_type} #${e.id} failed`, err);
        await tx`UPDATE outbox_events SET attempts = attempts + 1, last_error = ${(err as Error).message?.slice(0, 2000) ?? 'error'},
                 available_at = now() + make_interval(secs => ${backoffSeconds(e.attempts + 1)})
                 WHERE tenant_id = ${e.tenant_id} AND id = ${e.id}`;
      }
    }
  });
  return { published, failed };
}

/** Deliver queued notifications through the channel adapters. */
export async function sendOutboundMessages(deps: WorkerDeps, batchSize = 50): Promise<number> {
  if (!deps.messages?.size) return 0;
  let sent = 0;
  await deps.db.asWorker(async (tx) => {
    const msgs = await tx<{ tenant_id: string; id: string; channel: string; to_address: string; subject: string | null;
      template_code: string; payload: Record<string, unknown>; locale: string; attempts: number }[]>`
      SELECT tenant_id, id, channel, to_address, subject, template_code, payload, locale, attempts FROM outbound_messages
      WHERE status = 'queued' AND scheduled_for <= now() ORDER BY scheduled_for LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`;
    for (const m of msgs) {
      const adapter = deps.messages!.get(m.channel);
      if (!adapter) continue;
      try {
        const r = await adapter.send({ to: m.to_address, subject: m.subject, templateCode: m.template_code, payload: m.payload, locale: m.locale });
        await tx`UPDATE outbound_messages SET status = 'sent', sent_at = now(), provider_message_id = ${r.providerMessageId},
                 attempts = attempts + 1 WHERE tenant_id = ${m.tenant_id} AND id = ${m.id}`;
        sent++;
      } catch (err) {
        await tx`UPDATE outbound_messages SET attempts = attempts + 1, last_error = ${(err as Error).message},
                 status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'queued' END,
                 scheduled_for = now() + make_interval(secs => ${backoffSeconds(m.attempts + 1)})
                 WHERE tenant_id = ${m.tenant_id} AND id = ${m.id}`;
      }
    }
  });
  return sent;
}

/**
 * Rebuild daily_branch_summaries + product_daily_sales for one business date
 * (in each branch's own timezone). Training sales are excluded. Runs as
 * app_worker, so every query filters tenant_id explicitly.
 */
export async function refreshDailySummaries(db: Db, opts: { tenantId: string; date: string }): Promise<void> {
  const { tenantId, date } = opts;
  await db.asWorker(async (tx) => {
    await tx`
      WITH b AS (SELECT id, timezone FROM branches WHERE tenant_id = ${tenantId}),
      s AS (
        SELECT s.* FROM sales s JOIN b ON b.id = s.branch_id
        WHERE s.tenant_id = ${tenantId} AND NOT s.is_training
          AND (s.completed_at AT TIME ZONE b.timezone)::date = ${date}::date),
      sold AS (
        SELECT branch_id,
          COALESCE(sum(subtotal_pence) FILTER (WHERE status <> 'voided'),0) AS gross,
          COALESCE(sum(total_pence - vat_pence) FILTER (WHERE status <> 'voided'),0) AS net,
          COALESCE(sum(vat_pence) FILTER (WHERE status <> 'voided'),0) AS vat,
          COALESCE(sum(discount_pence) FILTER (WHERE status <> 'voided'),0) AS disc,
          count(*) FILTER (WHERE status <> 'voided')::int AS tx_count
        FROM s GROUP BY branch_id),
      pay AS (
        SELECT s.branch_id,
          COALESCE(sum(p.amount_pence) FILTER (WHERE p.method = 'cash'),0) AS cash,
          COALESCE(sum(p.amount_pence) FILTER (WHERE p.method = 'card'),0) AS card,
          COALESCE(sum(p.amount_pence) FILTER (WHERE p.method = 'online_platform'),0) AS online
        FROM s JOIN sale_payments p ON p.tenant_id = s.tenant_id AND p.sale_id = s.id AND p.status = 'approved'
        WHERE s.status <> 'voided' GROUP BY s.branch_id),
      cogs AS (
        SELECT s.branch_id, COALESCE(sum(round(l.quantity * COALESCE(l.unit_cost_pence,0))),0)::bigint AS cost,
               count(*) FILTER (WHERE l.is_voided)::int AS voided
        FROM s JOIN sale_lines l ON l.tenant_id = s.tenant_id AND l.sale_id = s.id
        WHERE s.status <> 'voided' OR l.is_voided GROUP BY s.branch_id),
      ref AS (
        SELECT r.branch_id, sum(r.total_pence) AS refunds FROM refunds r JOIN b ON b.id = r.branch_id
        WHERE r.tenant_id = ${tenantId} AND (r.occurred_at AT TIME ZONE b.timezone)::date = ${date}::date GROUP BY r.branch_id),
      waste AS (
        SELECT m.branch_id, sum(round(-m.quantity * COALESCE(m.unit_cost_pence,0)))::bigint AS cost
        FROM stock_movements m JOIN b ON b.id = m.branch_id
        WHERE m.tenant_id = ${tenantId} AND m.movement_type = 'waste' AND (m.occurred_at AT TIME ZONE b.timezone)::date = ${date}::date
        GROUP BY m.branch_id),
      nosale AS (
        SELECT t.branch_id, count(*)::int AS n FROM cash_movements c
        JOIN till_sessions t ON t.tenant_id = c.tenant_id AND t.id = c.till_session_id JOIN b ON b.id = t.branch_id
        WHERE c.tenant_id = ${tenantId} AND c.movement_type = 'no_sale' AND (c.occurred_at AT TIME ZONE b.timezone)::date = ${date}::date
        GROUP BY t.branch_id),
      orders_ AS (
        SELECT o.branch_id, sum(o.platform_fee_pence) AS fees FROM orders o JOIN b ON b.id = o.branch_id
        WHERE o.tenant_id = ${tenantId} AND o.status = 'completed' AND (o.completed_at AT TIME ZONE b.timezone)::date = ${date}::date
        GROUP BY o.branch_id)
      INSERT INTO daily_branch_summaries (tenant_id, branch_id, business_date, gross_sales_pence, net_sales_pence, vat_pence,
        refunds_pence, discounts_pence, cost_of_goods_pence, waste_cost_pence, transactions, avg_basket_pence, cash_pence,
        card_pence, online_pence, platform_fees_pence, voided_lines, no_sales, computed_at)
      SELECT ${tenantId}, b.id, ${date}::date, COALESCE(sold.gross,0), COALESCE(sold.net,0), COALESCE(sold.vat,0),
        COALESCE(ref.refunds,0), COALESCE(sold.disc,0), COALESCE(cogs.cost,0), COALESCE(waste.cost,0), COALESCE(sold.tx_count,0),
        CASE WHEN COALESCE(sold.tx_count,0) > 0 THEN round((sold.net + sold.vat)::numeric / sold.tx_count)::bigint ELSE 0 END,
        COALESCE(pay.cash,0), COALESCE(pay.card,0), COALESCE(pay.online,0), COALESCE(orders_.fees,0),
        COALESCE(cogs.voided,0), COALESCE(nosale.n,0), now()
      FROM b LEFT JOIN sold ON sold.branch_id = b.id LEFT JOIN pay ON pay.branch_id = b.id LEFT JOIN cogs ON cogs.branch_id = b.id
        LEFT JOIN ref ON ref.branch_id = b.id LEFT JOIN waste ON waste.branch_id = b.id LEFT JOIN nosale ON nosale.branch_id = b.id
        LEFT JOIN orders_ ON orders_.branch_id = b.id
      ON CONFLICT (tenant_id, branch_id, business_date) DO UPDATE SET
        gross_sales_pence = EXCLUDED.gross_sales_pence, net_sales_pence = EXCLUDED.net_sales_pence, vat_pence = EXCLUDED.vat_pence,
        refunds_pence = EXCLUDED.refunds_pence, discounts_pence = EXCLUDED.discounts_pence,
        cost_of_goods_pence = EXCLUDED.cost_of_goods_pence, waste_cost_pence = EXCLUDED.waste_cost_pence,
        transactions = EXCLUDED.transactions, avg_basket_pence = EXCLUDED.avg_basket_pence, cash_pence = EXCLUDED.cash_pence,
        card_pence = EXCLUDED.card_pence, online_pence = EXCLUDED.online_pence, platform_fees_pence = EXCLUDED.platform_fees_pence,
        voided_lines = EXCLUDED.voided_lines, no_sales = EXCLUDED.no_sales, computed_at = now()`;

    // Per product. was_out_of_stock = ledger balance at end of day <= 0 (lost sales matter for forecasting).
    await tx`
      WITH b AS (SELECT id, timezone FROM branches WHERE tenant_id = ${tenantId}),
      lines AS (
        SELECT s.branch_id, l.product_id, sum(l.quantity) AS qty, sum(l.line_total_pence - l.vat_pence) AS net,
               sum(round(l.quantity * COALESCE(l.unit_cost_pence,0)))::bigint AS cost
        FROM sales s JOIN b ON b.id = s.branch_id
        JOIN sale_lines l ON l.tenant_id = s.tenant_id AND l.sale_id = s.id
        WHERE s.tenant_id = ${tenantId} AND NOT s.is_training AND s.status <> 'voided' AND NOT l.is_voided AND l.product_id IS NOT NULL
          AND (s.completed_at AT TIME ZONE b.timezone)::date = ${date}::date
        GROUP BY s.branch_id, l.product_id),
      wasted AS (
        SELECT m.branch_id, m.product_id, sum(-m.quantity) AS qty FROM stock_movements m JOIN b ON b.id = m.branch_id
        WHERE m.tenant_id = ${tenantId} AND m.movement_type = 'waste' AND (m.occurred_at AT TIME ZONE b.timezone)::date = ${date}::date
        GROUP BY m.branch_id, m.product_id),
      keys AS (SELECT branch_id, product_id FROM lines UNION SELECT branch_id, product_id FROM wasted)
      INSERT INTO product_daily_sales (tenant_id, branch_id, product_id, business_date, qty_sold, net_sales_pence, cost_pence,
                                       qty_wasted, was_out_of_stock, computed_at)
      SELECT ${tenantId}, k.branch_id, k.product_id, ${date}::date, COALESCE(l.qty,0), COALESCE(l.net,0), COALESCE(l.cost,0),
             COALESCE(w.qty,0),
             COALESCE((SELECT sum(m.quantity) FROM stock_movements m JOIN b ON b.id = m.branch_id
                       WHERE m.tenant_id = ${tenantId} AND m.branch_id = k.branch_id AND m.product_id = k.product_id
                         AND m.occurred_at < ((${date}::date + 1)::timestamp AT TIME ZONE b.timezone)), 0) <= 0,
             now()
      FROM keys k LEFT JOIN lines l USING (branch_id, product_id) LEFT JOIN wasted w USING (branch_id, product_id)
      ON CONFLICT (tenant_id, branch_id, product_id, business_date) DO UPDATE SET
        qty_sold = EXCLUDED.qty_sold, net_sales_pence = EXCLUDED.net_sales_pence, cost_pence = EXCLUDED.cost_pence,
        qty_wasted = EXCLUDED.qty_wasted, was_out_of_stock = EXCLUDED.was_out_of_stock, computed_at = now()`;
  });
}

/** Refresh today + yesterday for every active tenant (run every few minutes). */
export async function refreshRecentSummaries(db: Db): Promise<number> {
  const tenants = await db.asWorker((tx) => tx<{ id: string }[]>`SELECT id FROM tenants WHERE status IN ('trial','active','past_due')`);
  const today = new Date();
  const days = [0, 1].map((d) => new Date(today.getTime() - d * 86400000).toISOString().slice(0, 10));
  for (const t of tenants) for (const date of days) await refreshDailySummaries(db, { tenantId: t.id, date });
  return tenants.length;
}
