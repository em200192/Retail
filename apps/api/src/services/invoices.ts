import type { Tx } from '../lib/db.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { enqueueEvent } from '../lib/outbox.ts';
import { type MovementInput, postMovements } from '../lib/stock.ts';
import type { OcrInvoice } from '../integrations/ocr.ts';
import { updateCosts } from '../routes/stock.ts';
import { productNameFromInvoice } from '@retail/shared';

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
      unit_cost_pence: l.unit_cost_pence, line_total_pence: l.line_total_pence, rrp_pence: l.rrp_pence ?? null, vat_code: l.vat_code, is_pmp: l.is_pmp,
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

  // Net every line per product first, so a VOID NOTE / negative line cancels
  // what it voids instead of blocking the post.
  const perProduct = new Map<string, { units: number; cost: number; costedUnits: number; expiry: string | null;
    trackExpiry: boolean; codes: { code: string; description: string; pack: number; caseCost: number | null }[] }>();
  for (const l of lines) {
    if (l.match_status === 'ignored' || !l.product_id) continue;
    const qty = l.quantity ?? 0;
    if (qty === 0) continue;
    const pack = l.pack_size && l.pack_size > 0 ? l.pack_size : 1;
    const units = qty * pack;
    const caseCost = l.unit_cost_pence ?? (l.line_total_pence != null ? Math.round(l.line_total_pence / qty) : null);
    const p = perProduct.get(l.product_id) ?? { units: 0, cost: 0, costedUnits: 0, expiry: null, trackExpiry: !!l.track_expiry, codes: [] };
    p.units += units;
    if (caseCost != null) { p.cost += Math.round((caseCost / pack) * units); p.costedUnits += units; }
    if (l.expiry_date && (!p.expiry || l.expiry_date < p.expiry)) p.expiry = l.expiry_date;
    if (l.supplier_code && qty > 0) p.codes.push({ code: l.supplier_code, description: l.description, pack, caseCost });
    perProduct.set(l.product_id, p);
  }
  const movements: MovementInput[] = [];
  for (const [productId, p] of perProduct) {
    const units = Math.round(p.units * 1000) / 1000;
    if (units <= 0) continue; // fully voided / returned
    const unitCost = p.costedUnits > 0 ? Math.round(p.cost / p.costedUnits) : null;
    let batchId: string | null = null;
    if (p.trackExpiry && p.expiry) {
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO stock_batches (tenant_id, branch_id, product_id, supplier_invoice_id, expiry_date, qty_received, qty_remaining, unit_cost_pence)
        VALUES (${tenantId}, ${inv.branch_id}, ${productId}, ${invoiceId}, ${p.expiry}, ${units}, ${units}, ${unitCost}) RETURNING id`;
      batchId = b!.id;
    }
    if (unitCost != null) await updateCosts(tx, inv.branch_id, productId, units, unitCost);
    movements.push({ branchId: inv.branch_id, productId, quantity: units, movementType: 'receipt',
      unitCostPence: unitCost, referenceType: 'supplier_invoice', referenceId: invoiceId, batchId, staffId, deviceId });
    for (const c of p.codes) {
      await tx`
        INSERT INTO supplier_products (tenant_id, supplier_id, product_id, supplier_code, supplier_description, pack_size,
                                       case_cost_pence, last_cost_at, match_source)
        VALUES (${tenantId}, ${inv.supplier_id}, ${productId}, ${c.code}, ${c.description}, ${c.pack}, ${c.caseCost}, now(), 'ocr_confirmed')
        ON CONFLICT (tenant_id, supplier_id, supplier_code) DO UPDATE SET
          product_id = EXCLUDED.product_id, pack_size = EXCLUDED.pack_size, case_cost_pence = EXCLUDED.case_cost_pence,
          last_cost_at = now(), supplier_description = EXCLUDED.supplier_description,
          match_source = CASE WHEN supplier_products.match_source = 'manual' THEN 'manual' ELSE 'ocr_confirmed' END`;
    }
    if (inv.purchase_order_id) {
      await tx`
        UPDATE purchase_order_lines SET qty_received = qty_received + ${units}
        WHERE id = (SELECT id FROM purchase_order_lines WHERE purchase_order_id = ${inv.purchase_order_id} AND product_id = ${productId} LIMIT 1)`;
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

/**
 * Creates a product from an invoice line the shop doesn't stock yet: tidy
 * name, the line's barcode (PMP when price-marked), VAT code, and a shelf
 * price from the price mark / RRP. The line is then matched to it.
 */
export async function createProductFromLine(tx: Tx, tenantId: string, staffId: string, invoiceId: string, lineId: string,
  overrides: { name?: string; vat_code?: string; category_id?: string | null; price_pence?: number | null } = {}) {
  const [l] = await tx<{ id: string; description: string; barcode: string | null; vat_code: string | null; is_pmp: boolean | null;
    pmp_price_pence: number | null; rrp_pence: number | null; product_id: string | null; match_status: string; pack_size: number | null;
    unit_cost_pence: number | null }[]>`
    SELECT id, description, barcode, vat_code, is_pmp, pmp_price_pence, rrp_pence, product_id, match_status, pack_size, unit_cost_pence
    FROM supplier_invoice_lines WHERE id = ${lineId} AND invoice_id = ${invoiceId}`;
  if (!l) throw notFound('Invoice line');
  if (l.match_status === 'ignored') throw conflict('This line is ignored');
  const name = (overrides.name ?? productNameFromInvoice(l.description)).trim();
  if (!name) throw unprocessable('Enter a product name');
  if (l.barcode) {
    const [taken] = await tx<{ product_id: string }[]>`SELECT product_id FROM product_barcodes WHERE barcode = ${l.barcode}`;
    if (taken) throw conflict('A product with this barcode already exists — match the line to it instead', { product_id: taken.product_id });
  }
  const vat = overrides.vat_code ?? l.vat_code ?? 'S';
  const [p] = await tx<{ id: string; name: string }[]>`
    INSERT INTO products (tenant_id, name, vat_code, category_id, last_cost_pence)
    VALUES (${tenantId}, ${name}, ${vat}, ${overrides.category_id ?? null},
            ${l.unit_cost_pence != null ? Math.round(l.unit_cost_pence / (l.pack_size || 1)) : null})
    RETURNING id, name`;
  if (l.barcode) {
    await tx`
      INSERT INTO product_barcodes (tenant_id, product_id, barcode, barcode_type, is_primary, is_pmp, pmp_price_pence)
      VALUES (${tenantId}, ${p!.id}, ${l.barcode}, ${l.barcode.length === 8 ? 'EAN8' : l.barcode.length === 14 ? 'ITF14' : 'EAN13'}, true,
              ${!!(l.is_pmp && l.pmp_price_pence)}, ${l.is_pmp ? l.pmp_price_pence : null})`;
  }
  const price = overrides.price_pence !== undefined ? overrides.price_pence : (l.is_pmp && l.pmp_price_pence ? l.pmp_price_pence : l.rrp_pence);
  if (price != null) {
    await tx`
      INSERT INTO product_prices (tenant_id, product_id, price_level_id, price_pence, created_by)
      SELECT ${tenantId}, ${p!.id}, id, ${price}, ${staffId} FROM price_levels WHERE is_default`;
  }
  await tx`
    UPDATE supplier_invoice_lines SET product_id = ${p!.id}, match_status = 'new_product_created', match_confidence = 1, matched_by = ${staffId}
    WHERE id = ${lineId}`;
  // Other lines for the same supplier code on this invoice (repeats, voids) are the same product.
  const [code] = await tx<{ supplier_code: string | null }[]>`SELECT supplier_code FROM supplier_invoice_lines WHERE id = ${lineId}`;
  if (code?.supplier_code) {
    await tx`
      UPDATE supplier_invoice_lines SET product_id = ${p!.id}, match_status = 'new_product_created', match_confidence = 1, matched_by = ${staffId}
      WHERE invoice_id = ${invoiceId} AND supplier_code = ${code.supplier_code} AND product_id IS NULL AND match_status <> 'ignored'`;
  }
  await enqueueEvent(tx, tenantId, 'product.changed', 'product', p!.id, { product_id: p!.id, action: 'created' });
  return { product_id: p!.id, name: p!.name, price_pence: price ?? null };
}
