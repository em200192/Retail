/** GS1 check digit for EAN-8 / EAN-13 / UPC-A / ITF-14. */
export function gtinCheckDigitValid(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10 === check;
}

/** Mirrors a row of the barcode_rules table (positions are 1-based). */
export interface BarcodeRule {
  prefix: string;
  barcode_length: number;
  item_code_start: number;
  item_code_length: number;
  value_type: 'price_pence' | 'weight_g';
  value_start: number;
  value_length: number;
}

export interface ScaleBarcode {
  rule: BarcodeRule;
  itemCode: string;
  pricePence?: number;
  weightGrams?: number;
}

/**
 * Variable-measure barcodes printed by in-store scales, e.g. prefix '2':
 * 2 IIIII VVVVV C  -> item code + embedded price (pence) or weight (grams).
 * Longest matching prefix wins.
 */
export function parseScaleBarcode(barcode: string, rules: readonly BarcodeRule[]): ScaleBarcode | null {
  const candidates = rules
    .filter((r) => barcode.length === r.barcode_length && barcode.startsWith(r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const rule = candidates[0];
  if (!rule || !/^\d+$/.test(barcode)) return null;
  const itemCode = barcode.substr(rule.item_code_start - 1, rule.item_code_length);
  const raw = barcode.substr(rule.value_start - 1, rule.value_length);
  if (itemCode.length !== rule.item_code_length || raw.length !== rule.value_length) return null;
  const value = Number(raw);
  return rule.value_type === 'price_pence'
    ? { rule, itemCode, pricePence: value }
    : { rule, itemCode, weightGrams: value };
}
