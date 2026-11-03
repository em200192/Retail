import { parseScaleBarcode, todayUK, type VatCode } from '@retail/shared';
import { type Barcode, type CatalogState, type PriceLevel, type PriceRow, type Product, sellable } from './catalog.ts';

/**
 * Offline mirror of the SQL resolve_price() (migration 090):
 *   rows of the requested level OR the default level, for this branch or all
 *   branches, min_qty <= qty, valid at `at`; ordered by
 *   requested level first > branch-specific first > highest min_qty > newest valid_from.
 */
export function resolvePrice(
  rows: readonly PriceRow[],
  levels: readonly PriceLevel[],
  opts: { priceLevelId: string | null; branchId: string; qty: number; at: Date },
): number | null {
  const defaults = new Set(levels.filter((l) => l.is_default).map((l) => l.id));
  const t = opts.at.getTime();
  const candidates = rows.filter((r) =>
    (r.price_level_id === opts.priceLevelId || defaults.has(r.price_level_id))
    && (r.branch_id === null || r.branch_id === opts.branchId)
    && r.min_qty <= opts.qty
    && Date.parse(r.valid_from) <= t
    && (r.valid_to === null || Date.parse(r.valid_to) > t));
  candidates.sort((a, b) => {
    const lvl = Number(b.price_level_id === opts.priceLevelId) - Number(a.price_level_id === opts.priceLevelId);
    if (lvl) return lvl;
    const br = Number(b.branch_id !== null) - Number(a.branch_id !== null);
    if (br) return br;
    if (b.min_qty !== a.min_qty) return b.min_qty - a.min_qty;
    return Date.parse(b.valid_from) - Date.parse(a.valid_from);
  });
  return candidates[0]?.price_pence ?? null;
}

/** Offline mirror of vat_rate_on(code, date). `date` is YYYY-MM-DD (UK). */
export function vatRateOn(rates: CatalogState['vatRates'], code: string, date: string): number | null {
  const row = rates
    .filter((r) => r.code === code && r.valid_from <= date && (r.valid_to === null || r.valid_to > date))
    .sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1))[0];
  return row ? Number(row.rate_percent) : null;
}

const FALLBACK_VAT: Record<VatCode, number> = { S: 20, R: 5, Z: 0, E: 0 };

export interface ScannedItem {
  kind: 'item';
  product: Product;
  barcode: string | null;
  quantity: number;               // base units (case = N) or kg
  unitPricePence: number;         // per base unit after the PMP cap
  isPmp: boolean;
  pmpPricePence: number | null;
  vatCode: VatCode;
  vatRatePercent: number;
  embedded: 'price' | 'weight' | null;
}
export type ScanOutcome =
  | ScannedItem
  | { kind: 'no_price'; product: Product; barcode: string | null }
  | { kind: 'unknown'; barcode: string };

/**
 * Offline mirror of the server's resolveScan() (services/scan.ts):
 * 1) exact barcode (single / case / PMP / PLU), 2) scale barcode via
 * barcode_rules -> PLU item code, 3) unknown. PMP caps the per-unit price.
 */
export function resolveScan(
  c: CatalogState,
  code: string,
  opts: { priceLevelId: string | null; at?: Date },
): ScanOutcome {
  const at = opts.at ?? new Date();
  const trimmed = code.trim();
  let bc: Barcode | undefined = c.barcodes[trimmed];
  let embedded: { pricePence?: number; weightGrams?: number } | null = null;
  if (!bc) {
    const parsed = parseScaleBarcode(trimmed, c.barcodeRules);
    if (parsed) {
      const plu = c.barcodes[parsed.itemCode];
      if (plu && plu.barcode_type === 'PLU') {
        bc = plu;
        embedded = parsed;
      }
    }
  }
  const product = bc ? c.products[bc.product_id] : undefined;
  if (!bc || !sellable(product)) return { kind: 'unknown', barcode: trimmed };
  return priceItem(c, product, bc, trimmed, embedded, opts.priceLevelId, at);
}

/** Price a product picked by name (no scan): uses its primary barcode so PMP still applies. */
export function resolveProduct(c: CatalogState, product: Product, barcode: Barcode | null, opts: { priceLevelId: string | null; at?: Date }): ScanOutcome {
  return priceItem(c, product, barcode, barcode?.barcode ?? null, null, opts.priceLevelId, opts.at ?? new Date());
}

function priceItem(
  c: CatalogState, product: Product, bc: Barcode | null, scanned: string | null,
  embedded: { pricePence?: number; weightGrams?: number } | null, priceLevelId: string | null, at: Date,
): ScanOutcome {
  const unitsPerScan = bc?.units_per_scan ?? 1;
  const quantity = embedded?.weightGrams !== undefined ? embedded.weightGrams / 1000
    : embedded?.pricePence !== undefined ? 1 : unitsPerScan;
  // Quantity breaks start at 1, so a 455 g item still finds the per-kg price.
  const resolved = resolvePrice(c.prices[product.id] ?? [], c.priceLevels, {
    priceLevelId, branchId: c.branch?.id ?? '', qty: Math.max(quantity, 1), at,
  });
  let unit = resolved;
  const isPmp = !!bc?.is_pmp && bc.pmp_price_pence !== null;
  if (isPmp) {
    const pmpPerUnit = Math.floor(bc!.pmp_price_pence! / unitsPerScan);
    unit = unit === null ? pmpPerUnit : Math.min(unit, pmpPerUnit);
  }
  if (embedded?.pricePence !== undefined) unit = embedded.pricePence;
  if (unit === null) return { kind: 'no_price', product, barcode: scanned };
  const vatRate = vatRateOn(c.vatRates, product.vat_code, todayUK(at)) ?? FALLBACK_VAT[product.vat_code];
  return {
    kind: 'item', product, barcode: scanned, quantity, unitPricePence: unit, isPmp,
    pmpPricePence: isPmp ? bc!.pmp_price_pence : null, vatCode: product.vat_code, vatRatePercent: vatRate,
    embedded: embedded ? (embedded.pricePence !== undefined ? 'price' : 'weight') : null,
  };
}
