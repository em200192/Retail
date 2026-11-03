import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  apportion, ARABIC_UK_LOCALE, divRoundHalfUp, evaluateDiscount, evaluateLimit, formatDateTimeUK, formatDateUK, formatGBP, formatTimeUK, latinDigits, formatReceiptNumber, gtinCheckDigitValid,
  lineAmount, LIMITS, parseReceiptNumber, parseScaleBarcode, percentOf, PERMISSIONS, quantityToMilli, UUID_RE,
  uuidv7, vatFromGross,
} from '../src/index.ts';

describe('money', () => {
  it('rounds half away from zero', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
  });
  it('extracts VAT from VAT-inclusive prices', () => {
    expect(vatFromGross(120, 20)).toBe(20);
    expect(vatFromGross(125, '20.00')).toBe(21); // 20.833 -> 21
    expect(vatFromGross(105, 5)).toBe(5);
    expect(vatFromGross(165, 0)).toBe(0);
    expect(vatFromGross(3, 20)).toBe(1); // 0.5 -> 1 (half-up)
    expect(vatFromGross(-120, 20)).toBe(-20);
  });
  it('computes weighed line amounts and percentages', () => {
    expect(lineAmount(899, '0.455')).toBe(409); // £8.99/kg × 455g = 409.045
    expect(lineAmount(165, 3)).toBe(495);
    expect(percentOf(199, 10)).toBe(20);
    expect(percentOf(1000, '12.5')).toBe(125);
  });
  it('parses quantities exactly', () => {
    expect(quantityToMilli('1.5')).toBe(1500n);
    expect(quantityToMilli(0.1 + 0.2)).toBe(300n);
  });
  it('apportions without losing pennies', () => {
    expect(apportion(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(apportion(50, [300, 100])).toEqual([38, 12]);
    const parts = apportion(997, [123, 456, 789, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(997);
  });
  it('formats GBP', () => {
    expect(formatGBP(123456)).toBe('£1,234.56');
    expect(formatGBP(-5)).toBe('-£0.05');
  });
});

describe('ids & receipts', () => {
  it('generates time-ordered UUIDv7', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(UUID_RE);
    expect(a[14]).toBe('7');
    expect(a < b).toBe(true);
  });
  it('formats and parses receipt numbers', () => {
    expect(formatReceiptNumber('MAN1', 2, 1043)).toBe('MAN1-2-1043');
    expect(parseReceiptNumber('MAN1-2-1043')).toEqual({ branchCode: 'MAN1', deviceNo: 2, seq: 1043 });
    expect(parseReceiptNumber('bad')).toBeNull();
  });
});

describe('barcodes', () => {
  it('validates GTIN check digits', () => {
    expect(gtinCheckDigitValid('5000112637922')).toBe(true);
    expect(gtinCheckDigitValid('5000112637923')).toBe(false);
    expect(gtinCheckDigitValid('96385074')).toBe(true);
  });
  it('parses scale barcodes', () => {
    const rule = { prefix: '2', barcode_length: 13, item_code_start: 2, item_code_length: 5,
      value_type: 'price_pence' as const, value_start: 7, value_length: 5 };
    expect(parseScaleBarcode('2001230045671', [rule])).toEqual({ rule, itemCode: '00123', pricePence: 456 });
    expect(parseScaleBarcode('5001230045671', [rule])).toBeNull();
  });
});

describe('permissions', () => {
  it('match the codes seeded in 100_seed.sql', () => {
    const seed = readFileSync(new URL('../../../db/migrations/100_seed.sql', import.meta.url), 'utf8');
    const permBlock = seed.split('INSERT INTO permissions')[1]!.split('ON CONFLICT')[0]!;
    const seeded = [...permBlock.matchAll(/\('([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);
    expect([...PERMISSIONS].sort()).toEqual(seeded.sort());
    const limitBlock = seed.split('INSERT INTO limit_definitions')[1]!.split('ON CONFLICT')[0]!;
    const seededLimits = [...limitBlock.matchAll(/\('([a-z_.]+)'/g)].map((m) => m[1]);
    expect([...LIMITS].sort()).toEqual(seededLimits.sort());
  });
  it('evaluates limits (NULL = needs approval, owner unrestricted)', () => {
    expect(evaluateLimit(10, null, false)).toBe('needs_approval');
    expect(evaluateLimit(10, null, true)).toBe('self_authorised');
    expect(evaluateLimit(5, 5, false)).toBe('self_authorised');
    expect(evaluateLimit(6, 5, false)).toBe('needs_approval');
    expect(evaluateDiscount(5, 50, { maxPercent: 5, maxAmountPence: 100 }, false)).toBe('self_authorised');
    expect(evaluateDiscount(5, 150, { maxPercent: 5, maxAmountPence: 100 }, false)).toBe('needs_approval');
    expect(evaluateDiscount(40, 5000, { maxPercent: 50, maxAmountPence: null }, false)).toBe('self_authorised');
  });
});

describe('date formatting (locales)', () => {
  const at = '2026-11-03T14:05:00Z';
  it('defaults to en-GB, Europe/London', () => {
    expect(formatDateTimeUK(at)).toBe('03 Nov 2026, 14:05');
    expect(formatTimeUK('2026-07-01T11:30:00Z')).toBe('12:30'); // BST
    expect(formatDateUK('2026-11-03')).toBe('03 Nov 2026');
  });
  it('formats Arabic month names with Latin digits', () => {
    const s = formatDateTimeUK(at, ARABIC_UK_LOCALE);
    expect(s).toContain('نوفمبر');
    expect(s).toMatch(/03/);
    expect(s).toMatch(/2026/);
    expect(s).toMatch(/14:05/);
    expect(s).not.toMatch(/[٠-٩]/);
    expect(formatTimeUK(at, ARABIC_UK_LOCALE)).toBe('14:05');
    expect(formatDateUK('2026-01-15', { month: 'long' }, ARABIC_UK_LOCALE)).toBe('يناير');
  });
  it('turns Arabic-Indic digits into 0-9', () => {
    expect(latinDigits('٠١٢٣٤٥٦٧٨٩ / ۰۹')).toBe('0123456789 / 09');
    expect(latinDigits('£12.34')).toBe('£12.34');
  });
});
