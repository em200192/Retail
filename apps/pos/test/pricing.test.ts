import { describe, expect, it } from 'vitest';
import { applyPull, popularProducts, primaryBarcode, searchProducts } from '../src/logic/catalog.ts';
import { resolvePrice, resolveScan, vatRateOn } from '../src/logic/pricing.ts';
import { BRANCH, catalog, CHEESE, COLA, MILK, OTHER_BRANCH, pull, RETAIL, TRADE, WATER } from './fixtures.ts';

const at = new Date('2026-11-03T10:00:00Z');

describe('offline resolve_price()', () => {
  const c = catalog();
  const levels = c.priceLevels;
  const rows = c.prices[MILK]!;

  it('prefers a branch price over the all-branches price', () => {
    expect(resolvePrice(rows, levels, { priceLevelId: null, branchId: BRANCH, qty: 1, at })).toBe(189);
    expect(resolvePrice(rows, levels, { priceLevelId: null, branchId: OTHER_BRANCH, qty: 1, at })).toBe(150);
    expect(resolvePrice(rows, levels, { priceLevelId: null, branchId: 'elsewhere', qty: 1, at })).toBe(195);
  });

  it('prefers the requested level over the default, even over a branch price', () => {
    expect(resolvePrice(rows, levels, { priceLevelId: TRADE, branchId: BRANCH, qty: 1, at })).toBe(179);
    // a level with no row of its own falls back to the default level
    expect(resolvePrice(c.prices[COLA]!, levels, { priceLevelId: TRADE, branchId: BRANCH, qty: 1, at })).toBe(175);
  });

  it('takes the best quantity break that applies', () => {
    const water = c.prices[WATER]!;
    expect(resolvePrice(water, levels, { priceLevelId: null, branchId: BRANCH, qty: 3, at })).toBe(95);
    expect(resolvePrice(water, levels, { priceLevelId: null, branchId: BRANCH, qty: 4, at })).toBe(80);
  });

  it('takes the newest valid row, ignoring expired and future ones', () => {
    const base = { product_id: MILK, price_level_id: RETAIL, branch_id: null, min_qty: 1 };
    const history = [
      { ...base, price_pence: 100, valid_from: '2024-01-01T00:00:00Z', valid_to: null },
      { ...base, price_pence: 120, valid_from: '2026-06-01T00:00:00Z', valid_to: null },
      { ...base, price_pence: 90, valid_from: '2026-10-01T00:00:00Z', valid_to: '2026-10-31T00:00:00Z' },
      { ...base, price_pence: 130, valid_from: '2026-12-01T00:00:00Z', valid_to: null },
    ];
    expect(resolvePrice(history, levels, { priceLevelId: null, branchId: BRANCH, qty: 1, at })).toBe(120);
    expect(resolvePrice(history, levels, { priceLevelId: null, branchId: BRANCH, qty: 1, at: new Date('2026-10-15T00:00:00Z') })).toBe(90);
    expect(resolvePrice(history, levels, { priceLevelId: null, branchId: BRANCH, qty: 1, at: new Date('2026-12-02T00:00:00Z') })).toBe(130);
    expect(resolvePrice([], levels, { priceLevelId: null, branchId: BRANCH, qty: 1, at })).toBeNull();
  });

  it('looks up the VAT rate on the date', () => {
    expect(vatRateOn(c.vatRates, 'S', '2026-11-03')).toBe(20);
    expect(vatRateOn([{ code: 'S', rate_percent: 17.5, name: '', valid_from: '2010-01-01', valid_to: '2011-01-04' }, ...c.vatRates], 'S', '2010-06-01')).toBe(17.5);
  });
});

describe('offline scan', () => {
  const c = catalog();

  it('caps a PMP item at the printed price', () => {
    const r = resolveScan(c, '5449000000996', { priceLevelId: null, at });
    expect(r).toMatchObject({ kind: 'item', unitPricePence: 165, isPmp: true, pmpPricePence: 165, quantity: 1, vatRatePercent: 20 });
  });

  it('counts a case barcode as N base units', () => {
    const r = resolveScan(c, '15449000000993', { priceLevelId: null, at });
    expect(r).toMatchObject({ kind: 'item', quantity: 24, unitPricePence: 175, isPmp: false });
  });

  it('reads weight and price from scale barcodes via barcode_rules', () => {
    // 21 12345 00455 C -> 455 g of cheese at £12.00/kg
    expect(resolveScan(c, '2112345004551', { priceLevelId: null, at })).toMatchObject({
      kind: 'item', quantity: 0.455, unitPricePence: 1200, embedded: 'weight', product: { id: CHEESE } });
    // 22 12345 00599 C -> £5.99 price-embedded
    expect(resolveScan(c, '2212345005991', { priceLevelId: null, at })).toMatchObject({
      kind: 'item', quantity: 1, unitPricePence: 599, embedded: 'price' });
  });

  it('reports unknown barcodes', () => {
    expect(resolveScan(c, '0000000000000', { priceLevelId: null, at })).toEqual({ kind: 'unknown', barcode: '0000000000000' });
  });

  it('uses the branch price by default', () => {
    expect(resolveScan(c, '5000000000042', { priceLevelId: null, at })).toMatchObject({ unitPricePence: 189, vatRatePercent: 0 });
  });
});

describe('catalogue cache', () => {
  it('replaces barcodes and prices of changed products on a delta pull', () => {
    const c = catalog();
    const delta = { ...pull(), full: false, server_time: '2026-11-03T10:00:00.000Z',
      products: [pull().products.find((p) => p.id === MILK)!],
      barcodes: [{ id: 'b9', product_id: MILK, barcode: '5000000000999', barcode_type: 'EAN13', units_per_scan: 1, is_pmp: false, pmp_price_pence: null }],
      prices: [{ product_id: MILK, price_level_id: RETAIL, branch_id: null, min_qty: 1, price_pence: 205, valid_from: '2026-11-03T09:30:00Z', valid_to: null }] };
    const next = applyPull(c, delta);
    expect(next.barcodes['5000000000042']).toBeUndefined();
    expect(next.barcodes['5000000000999']?.product_id).toBe(MILK);
    expect(next.prices[MILK]).toHaveLength(1);
    expect(next.prices[COLA]).toHaveLength(1);        // untouched products keep their prices
    expect(next.barcodes['5449000000996']).toBeDefined();
    expect(next.serverTime).toBe('2026-11-03T10:00:00.000Z');
  });

  it('searches by name words and barcode; picks a PMP single barcode as primary', () => {
    const c = catalog();
    expect(searchProducts(c, 'cola').map((p) => p.id)).toEqual([COLA]);
    expect(searchProducts(c, '2l milk').map((p) => p.id)).toEqual([MILK]);
    expect(searchProducts(c, '5010156000507').map((p) => p.id)).toEqual([WATER]);
    expect(primaryBarcode(c, COLA)?.barcode).toBe('5449000000996');
    expect(popularProducts(c, { [WATER]: 9, [COLA]: 3 }, 3).map((p) => p.id)).toEqual([WATER, COLA, CHEESE]);
  });
});
