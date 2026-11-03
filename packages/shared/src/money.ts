/**
 * Money is ALWAYS integer pence. These are the only rounding helpers the
 * system uses — API, worker and POS device all import them from here, and
 * the SQL function vat_from_gross() (migration 011) mirrors vatFromGross().
 */

/** Divide and round half away from zero, using integers only. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');
  const neg = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return neg ? -q : q;
}

/** Converts a percent such as 20, "20.00" or 12.5 to basis points (2000, 1250). */
export function percentToBasisPoints(percent: number | string): bigint {
  const s = typeof percent === 'number' ? percent.toFixed(2) : percent.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid percent: ${percent}`);
  const bp = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -bp : bp;
}

function toBig(pence: number | bigint): bigint {
  if (typeof pence === 'bigint') return pence;
  if (!Number.isSafeInteger(pence)) throw new RangeError(`pence must be an integer: ${pence}`);
  return BigInt(pence);
}

/**
 * VAT contained in a VAT-INCLUSIVE amount (UK shelf prices include VAT):
 *   vat = gross × rate / (100 + rate), rounded half-up, per line.
 */
export function vatFromGross(grossPence: number, ratePercent: number | string): number {
  const bp = percentToBasisPoints(ratePercent);
  if (bp === 0n) return 0;
  return Number(divRoundHalfUp(toBig(grossPence) * bp, 10000n + bp));
}

/** `percent` of an amount, rounded half-up. percentOf(199, 10) = 20. */
export function percentOf(pence: number, percent: number | string): number {
  return Number(divRoundHalfUp(toBig(pence) * percentToBasisPoints(percent), 10000n));
}

/** unitPrice × quantity for weighed goods (quantity has up to 3 decimals). */
export function lineAmount(unitPricePence: number, quantity: number | string): number {
  const milli = quantityToMilli(quantity);
  return Number(divRoundHalfUp(toBig(unitPricePence) * milli, 1000n));
}

/** Quantities are numeric(14,3); do arithmetic in thousandths to avoid float drift. */
export function quantityToMilli(quantity: number | string): bigint {
  const s = typeof quantity === 'number' ? quantity.toFixed(3) : quantity.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid quantity: ${quantity}`);
  const v = BigInt(m[2]!) * 1000n + BigInt((m[3] ?? '').padEnd(3, '0'));
  return m[1] === '-' ? -v : v;
}

export function milliToQuantity(milli: bigint): number {
  return Number(milli) / 1000;
}

/**
 * Splits `amountPence` across `weights` proportionally (largest remainder),
 * so the parts always add up exactly. Used to spread a basket discount over
 * the lines, which keeps VAT correct per line.
 */
export function apportion(amountPence: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (total <= 0) {
    if (amountPence !== 0) throw new RangeError('cannot apportion a non-zero amount over zero weights');
    return weights.map(() => 0);
  }
  const amount = toBig(amountPence);
  const totalB = toBig(total);
  const parts = weights.map((w) => (amount * toBig(w)) / totalB);
  const remainders = weights.map((w, i) => ({ i, r: (amount * toBig(w)) % totalB }));
  let left = amount - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of remainders) {
    if (left <= 0n) break;
    parts[i] = parts[i]! + 1n;
    left -= 1n;
  }
  return parts.map(Number);
}

export function formatGBP(pence: number): string {
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(pence);
  return `${sign}£${Math.floor(abs / 100).toLocaleString('en-GB')}.${String(abs % 100).padStart(2, '0')}`;
}
