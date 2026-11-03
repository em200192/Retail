import type { BarcodeRule, VatCode } from '@retail/shared';

/** Shapes returned by GET /v1/sync/pull and POST /v1/devices/hello. */
export interface TenantHeader {
  id: string;
  legal_name: string;
  trading_name: string | null;
  vat_number: string | null;
  vat_registered: boolean;
}
export interface BranchInfo {
  id: string;
  code: string;
  name: string;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  postcode?: string | null;
  phone?: string | null;
  timezone?: string;
}
export interface DeviceInfo { id: string; device_no: number; name: string; kind?: string; last_receipt_seq?: number }
export interface Product {
  id: string;
  name: string;
  category_id: string | null;
  vat_code: VatCode;
  min_age: number | null;
  sold_by_weight: boolean;
  unit_type: string;
  track_stock: boolean;
  is_active: boolean;
  archived_at: string | null;
  avg_cost_pence: number | null;
  is_ranged: boolean;
  updated_at?: string;
}
export interface Barcode {
  id: string;
  product_id: string;
  barcode: string;
  barcode_type: string;
  units_per_scan: number;
  is_pmp: boolean;
  pmp_price_pence: number | null;
}
export interface PriceRow {
  product_id: string;
  price_level_id: string;
  branch_id: string | null;
  min_qty: number;
  price_pence: number;
  valid_from: string;
  valid_to: string | null;
}
export interface StaffMember {
  id: string;
  display_name: string;
  role_key: string | null;
  role_name?: string;
  permissions: string[];
  limits: Record<string, number>;
}
export interface StaffTile { id: string; display_name: string; role_key: string | null; role_name?: string }
export interface PriceLevel { id: string; code: string; name: string; is_default: boolean; requires_customer: boolean }
export interface VatRate { code: string; rate_percent: number; name: string; valid_from: string; valid_to: string | null }
export interface Category { id: string; parent_id: string | null; name: string; sort_order: number; is_active: boolean }
export interface Till { id: string; name: string; device_id: string | null; open_session_id?: string | null }

export interface PullResponse {
  server_time: string;
  full: boolean;
  tenant?: TenantHeader;
  branch: BranchInfo;
  device: DeviceInfo;
  products: Product[];
  barcodes: Barcode[];
  prices: PriceRow[];
  staff: StaffMember[];
  categories: Category[];
  price_levels: PriceLevel[];
  barcode_rules: (BarcodeRule & { id?: string; name?: string })[];
  vat_rates: VatRate[];
  tills: Till[];
  promotions: unknown[];
}

export interface CatalogState {
  serverTime: string | null;
  tenant: TenantHeader | null;
  branch: BranchInfo | null;
  device: DeviceInfo | null;
  products: Record<string, Product>;
  /** keyed by the barcode string */
  barcodes: Record<string, Barcode>;
  /** keyed by product id */
  prices: Record<string, PriceRow[]>;
  staff: StaffMember[];
  categories: Category[];
  priceLevels: PriceLevel[];
  barcodeRules: BarcodeRule[];
  vatRates: VatRate[];
  tills: Till[];
}

export function emptyCatalog(): CatalogState {
  return {
    serverTime: null, tenant: null, branch: null, device: null, products: {}, barcodes: {}, prices: {}, staff: [],
    categories: [], priceLevels: [], barcodeRules: [], vatRates: [], tills: [],
  };
}

/**
 * Merges a pull into the cached catalogue. A full pull replaces everything.
 * A delta (`?since=`) carries only changed products — but for each of those it
 * carries ALL their barcodes and current prices, so we replace them per product.
 * Staff, levels, rules, VAT rates and tills are always sent in full.
 */
export function applyPull(prev: CatalogState, pull: PullResponse): CatalogState {
  const base = pull.full ? emptyCatalog() : prev;
  const products = { ...base.products };
  const prices = { ...base.prices };
  let barcodes = { ...base.barcodes };
  const changed = new Set(pull.products.map((p) => p.id));
  if (!pull.full && changed.size) {
    barcodes = Object.fromEntries(Object.entries(barcodes).filter(([, b]) => !changed.has(b.product_id)));
  }
  for (const p of pull.products) {
    products[p.id] = p;
    prices[p.id] = [];
  }
  for (const b of pull.barcodes) barcodes[b.barcode] = { ...b, units_per_scan: Number(b.units_per_scan) };
  for (const r of pull.prices) {
    (prices[r.product_id] ??= []).push({ ...r, min_qty: Number(r.min_qty), price_pence: Number(r.price_pence) });
  }
  return {
    serverTime: pull.server_time,
    tenant: pull.tenant ?? base.tenant ?? prev.tenant,
    branch: pull.branch,
    device: pull.device,
    products,
    barcodes,
    prices,
    staff: pull.staff,
    categories: pull.categories,
    priceLevels: pull.price_levels,
    barcodeRules: pull.barcode_rules.map((r) => ({
      prefix: r.prefix, barcode_length: Number(r.barcode_length), item_code_start: Number(r.item_code_start),
      item_code_length: Number(r.item_code_length), value_type: r.value_type, value_start: Number(r.value_start),
      value_length: Number(r.value_length),
    })),
    vatRates: pull.vat_rates.map((v) => ({ ...v, rate_percent: Number(v.rate_percent) })),
    tills: pull.tills,
  };
}

export function sellable(p: Product | undefined): p is Product {
  return !!p && p.is_active && !p.archived_at && p.is_ranged !== false;
}

/** Name / barcode search over the cached catalogue (case-insensitive, all words must match). */
export function searchProducts(c: CatalogState, query: string, limit = 24): Product[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const byBarcode = c.barcodes[q];
  const out: Product[] = [];
  if (byBarcode && sellable(c.products[byBarcode.product_id])) out.push(c.products[byBarcode.product_id]!);
  for (const p of Object.values(c.products)) {
    if (!sellable(p) || out.includes(p)) continue;
    const name = p.name.toLowerCase();
    if (words.every((w) => name.includes(w))) out.push(p);
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => {
    const as = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    return as - bs || a.name.localeCompare(b.name);
  });
}

/** The barcode to "scan" when an item is picked by name: single unit, PMP preferred so the cap applies. */
export function primaryBarcode(c: CatalogState, productId: string): Barcode | null {
  const all = Object.values(c.barcodes).filter((b) => b.product_id === productId && b.barcode_type !== 'PLU');
  const singles = all.filter((b) => b.units_per_scan === 1);
  return singles.find((b) => b.is_pmp) ?? singles[0] ?? all[0] ?? null;
}

/** Popular items: most sold on this till first, topped up from the catalogue. */
export function popularProducts(c: CatalogState, counts: Record<string, number>, limit = 12): Product[] {
  const ranked = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => c.products[id])
    .filter(sellable);
  const rest = Object.values(c.products).filter((p) => sellable(p) && !ranked.includes(p))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...ranked, ...rest].slice(0, limit);
}
