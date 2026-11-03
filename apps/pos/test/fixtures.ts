import { applyPull, type CatalogState, emptyCatalog, type PullResponse } from '../src/logic/catalog.ts';

export const BRANCH = '00000000-0000-4000-8000-0000000000b1';
export const OTHER_BRANCH = '00000000-0000-4000-8000-0000000000b2';
export const RETAIL = '00000000-0000-4000-8000-00000000001a';
export const TRADE = '00000000-0000-4000-8000-00000000001b';
export const MILK = '00000000-0000-4000-8000-0000000000a1';
export const COLA = '00000000-0000-4000-8000-0000000000a2';
export const LAGER = '00000000-0000-4000-8000-0000000000a3';
export const CHEESE = '00000000-0000-4000-8000-0000000000a4';
export const WATER = '00000000-0000-4000-8000-0000000000a5';

const product = (id: string, name: string, vat: 'S' | 'Z', extra: Record<string, unknown> = {}) => ({
  id, name, category_id: null, vat_code: vat, min_age: null, sold_by_weight: false, unit_type: 'each', track_stock: true,
  is_active: true, archived_at: null, avg_cost_pence: 50, is_ranged: true, ...extra,
});
const price = (product_id: string, price_pence: number, extra: Record<string, unknown> = {}) => ({
  product_id, price_level_id: RETAIL, branch_id: null, min_qty: 1, price_pence, valid_from: '2024-01-01T00:00:00Z', valid_to: null, ...extra,
});

export function pull(): PullResponse {
  return {
    server_time: '2026-11-03T09:00:00.000Z',
    full: true,
    tenant: { id: 't', legal_name: 'Shah Convenience Ltd', trading_name: "Shah's Corner Shop", vat_number: 'GB123456789', vat_registered: true },
    branch: { id: BRANCH, code: 'MAN1', name: 'Wilmslow Road' },
    device: { id: 'd', device_no: 1, name: 'Front till' },
    products: [
      product(MILK, 'Milk 2L', 'Z'),
      product(COLA, 'Coca-Cola 500ml', 'S'),
      product(LAGER, 'Lager 4x440ml', 'S', { min_age: 18 }),
      product(CHEESE, 'Deli Cheddar', 'Z', { sold_by_weight: true, unit_type: 'kg' }),
      product(WATER, 'Still Water 500ml', 'S'),
    ],
    barcodes: [
      { id: 'b1', product_id: MILK, barcode: '5000000000042', barcode_type: 'EAN13', units_per_scan: 1, is_pmp: false, pmp_price_pence: null },
      { id: 'b2', product_id: COLA, barcode: '5449000000996', barcode_type: 'EAN13', units_per_scan: 1, is_pmp: true, pmp_price_pence: 165 },
      { id: 'b3', product_id: COLA, barcode: '15449000000993', barcode_type: 'ITF14', units_per_scan: 24, is_pmp: false, pmp_price_pence: null },
      { id: 'b4', product_id: LAGER, barcode: '5000000000059', barcode_type: 'EAN13', units_per_scan: 1, is_pmp: false, pmp_price_pence: null },
      { id: 'b5', product_id: CHEESE, barcode: '12345', barcode_type: 'PLU', units_per_scan: 1, is_pmp: false, pmp_price_pence: null },
      { id: 'b6', product_id: WATER, barcode: '5010156000507', barcode_type: 'EAN13', units_per_scan: 1, is_pmp: false, pmp_price_pence: null },
    ],
    prices: [
      price(MILK, 195),
      price(MILK, 179, { price_level_id: TRADE }),
      price(MILK, 189, { branch_id: BRANCH }),
      price(MILK, 150, { branch_id: OTHER_BRANCH }),
      price(COLA, 175),
      price(LAGER, 650),
      price(CHEESE, 1200),
      price(WATER, 95),
      price(WATER, 80, { min_qty: 4 }),
    ],
    staff: [
      { id: 'owner', display_name: 'Priya', role_key: 'owner', permissions: ['pos.sell', 'pos.approve', 'pos.discount', 'pos.refund'], limits: {} },
      { id: 'mo', display_name: 'Mo', role_key: 'manager', permissions: ['pos.sell', 'pos.approve', 'pos.discount', 'pos.refund'],
        limits: { 'pos.discount.max_percent': 50, 'pos.refund.max_amount_pence': 20000 } },
      { id: 'sam', display_name: 'Sam', role_key: 'cashier', permissions: ['pos.sell', 'pos.discount', 'pos.void_line'],
        limits: { 'pos.discount.max_percent': 5, 'pos.discount.max_amount_pence': 100 } },
    ],
    categories: [],
    price_levels: [
      { id: RETAIL, code: 'retail', name: 'Retail', is_default: true, requires_customer: false },
      { id: TRADE, code: 'trade', name: 'Trade', is_default: false, requires_customer: true },
    ],
    barcode_rules: [
      { prefix: '21', barcode_length: 13, item_code_start: 3, item_code_length: 5, value_type: 'weight_g', value_start: 8, value_length: 5 },
      { prefix: '22', barcode_length: 13, item_code_start: 3, item_code_length: 5, value_type: 'price_pence', value_start: 8, value_length: 5 },
    ],
    vat_rates: [
      { code: 'S', rate_percent: 20, name: 'Standard', valid_from: '2011-01-04', valid_to: null },
      { code: 'R', rate_percent: 5, name: 'Reduced', valid_from: '1997-09-01', valid_to: null },
      { code: 'Z', rate_percent: 0, name: 'Zero', valid_from: '1973-04-01', valid_to: null },
      { code: 'E', rate_percent: 0, name: 'Exempt', valid_from: '1973-04-01', valid_to: null },
    ],
    tills: [],
    promotions: [],
  } as PullResponse;
}

export function catalog(): CatalogState {
  return applyPull(emptyCatalog(), pull());
}
