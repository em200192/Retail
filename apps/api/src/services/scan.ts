import { type BarcodeRule, lineAmount, parseScaleBarcode } from '@retail/shared';
import type { Tx } from '../lib/db.ts';

export interface ScanResult {
  found: true;
  product: {
    id: string; name: string; vat_code: string; vat_rate_percent: number; min_age: number | null;
    sold_by_weight: boolean; unit_type: string; track_stock: boolean;
  };
  barcode_id: string | null;
  barcode: string;
  quantity: number;               // base units (or kg) this scan represents
  unit_price_pence: number | null; // per base unit, after PMP cap
  resolved_price_pence: number | null;
  is_pmp: boolean;
  pmp_price_pence: number | null;
  line_amount_pence: number | null;
  embedded: 'price' | 'weight' | null;
  requires_age_check: boolean;
  available_qty: number | null;
}

export interface ScanMiss {
  found: false;
  barcode: string;
  catalog_suggestion: Record<string, unknown> | null;
}

/**
 * What the till does when something is scanned. Resolution order:
 * 1) exact product barcode (single / case / PMP / PLU)
 * 2) variable-measure scale barcode (barcode_rules -> PLU item code)
 * 3) unknown: suggest from the shared UK catalogue
 * Price always comes from resolve_price(); PMP caps it at the printed price.
 */
export async function resolveScan(
  tx: Tx,
  opts: { barcode: string; branchId: string; priceLevelId?: string | null; at?: Date },
): Promise<ScanResult | ScanMiss> {
  const at = opts.at ?? new Date();
  const [level] = opts.priceLevelId
    ? await tx<{ id: string }[]>`SELECT id FROM price_levels WHERE id = ${opts.priceLevelId}`
    : await tx<{ id: string }[]>`SELECT id FROM price_levels WHERE is_default`;
  const levelId = level?.id ?? null;

  let barcodeRow = await findBarcode(tx, opts.barcode);
  let embedded: { pricePence?: number; weightGrams?: number } | null = null;

  if (!barcodeRow) {
    const rules = await tx<BarcodeRule[]>`
      SELECT prefix, barcode_length, item_code_start, item_code_length, value_type, value_start, value_length
      FROM barcode_rules WHERE is_active`;
    const parsed = parseScaleBarcode(opts.barcode, rules);
    if (parsed) {
      barcodeRow = await findBarcode(tx, parsed.itemCode, 'PLU');
      if (barcodeRow) embedded = parsed;
    }
  }

  if (!barcodeRow) {
    const [cat] = await tx`
      SELECT id, gtin, name, brand, size_text, category_hint, image_url, vat_code, is_pmp, pmp_price_pence, min_age
      FROM catalog_products WHERE gtin = ${opts.barcode}`;
    return { found: false, barcode: opts.barcode, catalog_suggestion: cat ?? null };
  }

  const quantity = embedded?.weightGrams !== undefined ? embedded.weightGrams / 1000
    : embedded?.pricePence !== undefined ? 1 : barcodeRow.units_per_scan;

  // Quantity breaks start at min_qty 1, so a 455 g weighed item must still find the per-kg price.
  const breakQty = Math.max(quantity, 1);
  const [p] = await tx<{ price: number | null; vat_rate: number; available: number | null }[]>`
    SELECT resolve_price(${barcodeRow.product_id}, ${levelId}, ${opts.branchId}, ${breakQty}, ${at}) AS price,
           vat_rate_on(${barcodeRow.vat_code}, ${at.toISOString().slice(0, 10)}::date) AS vat_rate,
           (SELECT available FROM v_stock_availability
             WHERE branch_id = ${opts.branchId} AND product_id = ${barcodeRow.product_id}) AS available`;

  const resolved = p!.price;
  let unitPrice = resolved;
  if (barcodeRow.is_pmp && barcodeRow.pmp_price_pence !== null) {
    // PMP price is printed per pack scanned; cap the per-unit price accordingly.
    const pmpPerUnit = Math.floor(barcodeRow.pmp_price_pence / barcodeRow.units_per_scan);
    unitPrice = unitPrice === null ? pmpPerUnit : Math.min(unitPrice, pmpPerUnit);
  }
  let lineAmountPence: number | null = unitPrice === null ? null : lineAmount(unitPrice, quantity);
  if (embedded?.pricePence !== undefined) {
    unitPrice = embedded.pricePence;
    lineAmountPence = embedded.pricePence;
  }

  return {
    found: true,
    product: {
      id: barcodeRow.product_id, name: barcodeRow.name, vat_code: barcodeRow.vat_code, vat_rate_percent: p!.vat_rate,
      min_age: barcodeRow.min_age, sold_by_weight: barcodeRow.sold_by_weight, unit_type: barcodeRow.unit_type,
      track_stock: barcodeRow.track_stock,
    },
    barcode_id: barcodeRow.id,
    barcode: opts.barcode,
    quantity,
    unit_price_pence: unitPrice,
    resolved_price_pence: resolved,
    is_pmp: barcodeRow.is_pmp,
    pmp_price_pence: barcodeRow.pmp_price_pence,
    line_amount_pence: lineAmountPence,
    embedded: embedded ? (embedded.pricePence !== undefined ? 'price' : 'weight') : null,
    requires_age_check: barcodeRow.min_age !== null,
    available_qty: p!.available,
  };
}

interface BarcodeRow {
  id: string; product_id: string; units_per_scan: number; is_pmp: boolean; pmp_price_pence: number | null;
  name: string; vat_code: string; min_age: number | null; sold_by_weight: boolean; unit_type: string; track_stock: boolean;
}

async function findBarcode(tx: Tx, barcode: string, type?: 'PLU'): Promise<BarcodeRow | undefined> {
  const [row] = await tx<BarcodeRow[]>`
    SELECT b.id, b.product_id, b.units_per_scan, b.is_pmp, b.pmp_price_pence,
           p.name, p.vat_code, p.min_age, p.sold_by_weight, p.unit_type, p.track_stock
    FROM product_barcodes b JOIN products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
    WHERE b.barcode = ${barcode} AND p.is_active AND p.archived_at IS NULL
      ${type ? tx`AND b.barcode_type = ${type}` : tx``}`;
  return row;
}
