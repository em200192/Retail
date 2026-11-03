import type { Tx } from '../lib/db.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { enqueueEvent } from '../lib/outbox.ts';
import { type MovementInput, postMovements } from '../lib/stock.ts';
import type { OcrInvoice } from '../integrations/ocr.ts';
import { updateCosts } from '../routes/stock.ts';

/** Thresholds for auto-matching invoice lines. */
export const MATCH = {
  supplierCode: 1.0,
  barcode: 0.97,
  fuzzyAccept: 0.6,      // below this, a fuzzy hit is only a suggestion
  fuzzyMax: 0.85,        // a name-only match is never trusted enough to skip review
  autoApprove: 0.9,      // every line at/above this and OCR confident -> no review needed
  ocrConfident: 0.8,
};

interface LineMatch { productId: string | null; status: 'matched_auto' | 'unmatched'; confidence: number | null; packSize: number | null }

/**
 * Match an OCR'd line to a product: supplier code first (learned mappings),
 * then barcode, then fuzzy name (pg_trgm).
 */
export async function matchLine(tx: Tx, supplierId: string | null,
  line: { supplier_code: string | null; barcode: string | null; description: string }): Promise<LineMatch> {
  if (supplierId && line.supplier_code) {
    const [m] = await tx<{ product_id: string; pack_size: number }[]>`
      SELECT product_id, pack_size FROM supplier_products WHERE supplier_id = ${supplierId} AND supplier_code = ${line.supplier_code}`;
    if (m) return { productId: m.product_id, status: 'matched_auto', confidence: MATCH.supplierCode, packSize: m.pack_size };
  }
  if (line.barcode) {
    const [b] = await tx<{ product_id: string; units_per_scan: number }[]>`
      SELECT product_id, units_per_scan FROM product_barcodes WHERE barcode = ${line.barcode}`;
    if (b) return { productId: b.product_id, status: 'matched_auto', confidence: MATCH.barcode,
      packSize: b.units_per_scan > 1 ? b.units_per_scan : null };
  }
  const [f] = await tx<{ id: string; score: number }[]>`
    SELECT id, similarity(name, ${line.description}) AS score FROM products
    WHERE archived_at IS NULL AND name % ${line.description}
    ORDER BY score DESC LIMIT 1`;
  if (f && f.score >= MATCH.fuzzyAccept) {
    const confidence = Math.min(Math.round(f.score * 1000) / 1000, MATCH.fuzzyMax);
    return { productId: f.id, status: 'matched_auto', confidence, packSize: null };
  }
  return { productId: f?.id ?? null, status: 'unmatched', confidence: f ? Math.round(f.score * 1000) / 1000 : null, packSize: null };
}

async function findOrCreateSupplier(tx: Tx, tenantId: string, ocr: OcrInvoice): Promise<string | null> {
  if (ocr.supplier_vat_number) {
    const [s] = await tx<{ id: string }[]>`
      SELECT id FROM suppliers WHERE replace(upper(vat_number), ' ', '') = replace(upper(${ocr.supplier_vat_number}), ' ', '')`;
    if (s) return s.id;
  }
  if (!ocr.supplier_name) return null;
  const [s] = await tx<{ id: string }[]>`
    SELECT id FROM suppliers WHERE name ILIKE ${ocr.supplier_name} OR similarity(name, ${ocr.supplier_name}) > 0.5
    ORDER BY similarity(name, ${ocr.supplier_name}) DESC LIMIT 1`;
  if (s) return s.id;
  // Known national wholesaler -> set the tenant up with it automatically.
  const [g] = await tx<{ id: string; name: string; website: string | null }[]>`
    SELECT id, name, website FROM global_suppliers
    WHERE is_active AND (${ocr.supplier_name} ILIKE '%' || name || '%' OR similarity(name, ${ocr.supplier_name}) > 0.5)
    ORDER BY similarity(name, ${ocr.supplier_name}) DESC LIMIT 1`;
  if (!g) return null;
  const [created] = await tx<{ id: string }[]>`
    INSERT INTO suppliers (tenant_id, global_supplier_id, name, website, vat_number, order_method)
    VALUES (${tenantId}, ${g.id}, ${g.name}, ${g.website}, ${ocr.supplier_vat_number}, 'portal')
    ON CONFLICT (tenant_id, name) DO UPDATE SET global_supplier_id = EXCLUDED.global_supplier_id
    RETURNING id`;
  return created!.id;
}

/**
 * Store an extraction (from OCR or typed by hand) on an invoice, match its
 * lines and decide whether a human must review it. Re-running replaces lines.
 */
export async function applyExtraction(tx: Tx, tenantId: string, invoiceId: string,
  ex: { provider: string; model: string; result: OcrInvoice; raw: unknown }) {
  const [inv] = await tx<{ id: string; status: string; supplier_id: string | null }[]>`
    SELECT id, status, supplier_id FROM supplier_invoices WHERE id = ${invoiceId} FOR UPDATE`;
  if (!inv) throw notFound('Invoice');
  if (['posted', 'rejected'].includes(inv.status)) throw conflict(`Invoice is already ${inv.status}`);
  const ocr = ex.result;
  const supplierId = inv.supplier_id ?? await findOrCreateSupplier(tx, tenantId, ocr);

  // The same invoice uploaded twice would double the stock — block it.
  if (supplierId && ocr.invoice_number) {
    const [dup] = await tx<{ id: string }[]>`
      SELECT id FROM supplier_invoices
      WHERE supplier_id = ${supplierId} AND invoice_number = ${ocr.invoice_number} AND status <> 'rejected' AND id <> ${invoiceId}`;
    if (dup) {
      const [rejected] = await tx`
        UPDATE supplier_invoices SET status = 'rejected', supplier_id = ${supplierId}, ocr_provider = ${ex.provider},
               ocr_model = ${ex.model}, ocr_raw = ${tx.json(ex.raw as never)}, processed_at = now(),
               ocr_error = ${`Duplicate: invoice ${ocr.invoice_number} was already uploaded (${dup.id})`}
        WHERE id = ${invoiceId} RETURNING *`;
      return { invoice: rejected, duplicate_of: dup.id };
    }
  }

  await tx`DELETE FROM supplier_invoice_lines WHERE invoice_id = ${invoiceId}`;
  let worst = 1;
  let unmatched = 0;
  const rows = [];
  for (const [i, l] of ocr.lines.entries()) {
    const m = await matchLine(tx, supplierId, l);
    if (m.status === 'unmatched') unmatched++;
    worst = Math.min(worst, m.confidence ?? 0);
    rows.push({
      tenant_id: tenantId, invoice_id: invoiceId, line_no: i + 1, raw_text: l.raw_text, supplier_code: l.supplier_code,
      barcode: l.barcode, description: l.description, quantity: l.quantity, pack_size: l.pack_size ?? m.packSize,
      unit_cost_pence: l.unit_cost_pence, line_total_pence: l.line_total_pence, vat_code: l.vat_code, is_pmp: l.is_pmp,
      pmp_price_pence: l.pmp_price_pence, expiry_date: l.expiry_date,
      product_id: m.status === 'matched_auto' ? m.productId : null, match_status: m.status, match_confidence: m.confidence,
    });
  }
  if (rows.length) await tx`INSERT INTO supplier_invoice_lines ${tx(rows as never)}`;

  const needsReview = unmatched > 0 || worst < MATCH.autoApprove || ocr.confidence < MATCH.ocrConfident
    || !supplierId || !ocr.invoice_number || rows.length === 0;
  const [updated] = await tx`
    UPDATE supplier_invoices SET
      supplier_id = ${supplierId}, invoice_number = ${ocr.invoice_number}, invoice_date = ${ocr.invoice_date},
      due_date = ${ocr.due_date}, subtotal_pence = ${ocr.subtotal_pence}, vat_pence = ${ocr.vat_pence}, total_pence = ${ocr.total_pence},
      status = ${needsReview ? 'needs_review' : 'approved'}, ocr_provider = ${ex.provider}, ocr_model = ${ex.model},
      ocr_raw = ${tx.json(ex.raw as never)}, ocr_confidence = ${Math.max(0, Math.min(1, ocr.confidence))}, ocr_error = NULL,
      processed_at = now()
    WHERE id = ${invoiceId} RETURNING *`;
  await enqueueEvent(tx, tenantId, 'notify.invoice_ready', 'supplier_invoice', invoiceId, { invoice_id: invoiceId, needs_review: needsReview });
  return { invoice: updated, lines_unmatched: unmatched };
}

/**
 * Posting = the human confirms the invoice. Creates receipt movements and
 * expiry batches, updates costs, and LEARNS supplier code -> product so the
 * next invoice from this supplier matches automatically.
 */
export async function postInvoice(tx: Tx, tenantId: string, invoiceId: string, staffId: string, deviceId: string | null) {
  const [inv] = await tx<{ id: string; status: string; supplier_id: string | null; branch_id: string; purchase_order_id: string | null }[]>`
    SELECT id, status, supplier_id, branch_id, purchase_order_id FROM supplier_invoices WHERE id = ${invoiceId} FOR UPDATE`;
  if (!inv) throw notFound('Invoice');
  if (!['needs_review', 'approved'].includes(inv.status)) throw conflict(`Invoice is ${inv.status}`);
  if (!inv.supplier_id) throw unprocessable('Choose the supplier before posting');
  const lines = await tx<{ id: string; product_id: string | null; match_status: string; supplier_code: string | null; description: string;
    quantity: number | null; pack_size: number | null; unit_cost_pence: number | null; line_total_pence: number | null;
    expiry_date: string | null; track_expiry: boolean | null }[]>`
    SELECT l.id, l.product_id, l.match_status, l.supplier_code, l.description, l.quantity, l.pack_size, l.unit_cost_pence,
           l.line_total_pence, l.expiry_date, p.track_expiry
    FROM supplier_invoice_lines l LEFT JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
    WHERE l.invoice_id = ${invoiceId} ORDER BY l.line_no`;
  const open = lines.filter((l) => l.match_status !== 'ignored' && !l.product_id);
  if (open.length) throw unprocessable(`${open.length} line(s) still need a product (or mark them ignored)`, { line_ids: open.map((l) => l.id) });

  const movements: MovementInput[] = [];
  for (const l of lines) {
    if (l.match_status === 'ignored' || !l.product_id) continue;
    const qty = l.quantity ?? 0;
    if (qty <= 0) throw unprocessable(`Line "${l.description}" has no quantity`);
    const pack = l.pack_size && l.pack_size > 0 ? l.pack_size : 1;
    const units = Math.round(qty * pack * 1000) / 1000;
    const caseCost = l.unit_cost_pence ?? (l.line_total_pence != null ? Math.round(l.line_total_pence / qty) : null);
    const unitCost = caseCost != null ? Math.round(caseCost / pack) : null;

    let batchId: string | null = null;
    if (l.track_expiry && l.expiry_date) {
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO stock_batches (tenant_id, branch_id, product_id, supplier_invoice_id, expiry_date, qty_received, qty_remaining, unit_cost_pence)
        VALUES (${tenantId}, ${inv.branch_id}, ${l.product_id}, ${invoiceId}, ${l.expiry_date}, ${units}, ${units}, ${unitCost}) RETURNING id`;
      batchId = b!.id;
    }
    if (unitCost != null) await updateCosts(tx, inv.branch_id, l.product_id, units, unitCost);
    movements.push({ branchId: inv.branch_id, productId: l.product_id, quantity: units, movementType: 'receipt',
      unitCostPence: unitCost, referenceType: 'supplier_invoice', referenceId: invoiceId, batchId, staffId, deviceId });

    if (l.supplier_code) {
      await tx`
        INSERT INTO supplier_products (tenant_id, supplier_id, product_id, supplier_code, supplier_description, pack_size,
                                       case_cost_pence, last_cost_at, match_source)
        VALUES (${tenantId}, ${inv.supplier_id}, ${l.product_id}, ${l.supplier_code}, ${l.description}, ${pack}, ${caseCost}, now(), 'ocr_confirmed')
        ON CONFLICT (tenant_id, supplier_id, supplier_code) DO UPDATE SET
          product_id = EXCLUDED.product_id, pack_size = EXCLUDED.pack_size, case_cost_pence = EXCLUDED.case_cost_pence,
          last_cost_at = now(), supplier_description = EXCLUDED.supplier_description,
          match_source = CASE WHEN supplier_products.match_source = 'manual' THEN 'manual' ELSE 'ocr_confirmed' END`;
    }
    if (inv.purchase_order_id) {
      await tx`
        UPDATE purchase_order_lines SET qty_received = qty_received + ${l.quantity}
        WHERE id = (SELECT id FROM purchase_order_lines WHERE purchase_order_id = ${inv.purchase_order_id} AND product_id = ${l.product_id} LIMIT 1)`;
    }
  }
  await postMovements(tx, tenantId, movements);
  if (inv.purchase_order_id) {
    await tx`
      UPDATE purchase_orders SET status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines WHERE purchase_order_id = ${inv.purchase_order_id} AND qty_received < qty_ordered)
        THEN 'received' ELSE 'partially_received' END
      WHERE id = ${inv.purchase_order_id}`;
    await tx`UPDATE purchase_list_items SET status = 'received' WHERE purchase_order_id = ${inv.purchase_order_id} AND status = 'ordered'`;
  }
  const [posted] = await tx`
    UPDATE supplier_invoices SET status = 'posted', posted_by = ${staffId}, posted_at = now(), reviewed_by = COALESCE(reviewed_by, ${staffId})
    WHERE id = ${invoiceId} RETURNING *`;
  await enqueueEvent(tx, tenantId, 'invoice.posted', 'supplier_invoice', invoiceId, { invoice_id: invoiceId, branch_id: inv.branch_id });
  return { invoice: posted, lines_received: movements.length };
}
