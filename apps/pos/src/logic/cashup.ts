/** UK notes and coins, largest first (pence). */
export const DENOMINATIONS = [
  { pence: 5000, label: '£50', kind: 'note' },
  { pence: 2000, label: '£20', kind: 'note' },
  { pence: 1000, label: '£10', kind: 'note' },
  { pence: 500, label: '£5', kind: 'note' },
  { pence: 200, label: '£2', kind: 'coin' },
  { pence: 100, label: '£1', kind: 'coin' },
  { pence: 50, label: '50p', kind: 'coin' },
  { pence: 20, label: '20p', kind: 'coin' },
  { pence: 10, label: '10p', kind: 'coin' },
  { pence: 5, label: '5p', kind: 'coin' },
  { pence: 2, label: '2p', kind: 'coin' },
  { pence: 1, label: '1p', kind: 'coin' },
] as const;

export type DenominationCounts = Partial<Record<number, number>>;

/** Parses what staff typed into a count box: whole, non-negative numbers only. */
export function parseCount(input: string): number | null {
  const s = input.trim();
  if (s === '') return 0;
  if (!/^\d{1,6}$/.test(s)) return null;
  return Number(s);
}

export function countedTotal(counts: DenominationCounts): number {
  let total = 0;
  for (const d of DENOMINATIONS) {
    const n = counts[d.pence] ?? 0;
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`invalid count for ${d.label}: ${n}`);
    total += n * d.pence;
  }
  return total;
}

export interface CashUpSummary {
  countedPence: number;
  expectedPence: number | null;
  variancePence: number | null;   // counted − expected: negative = short, positive = over
  status: 'balanced' | 'short' | 'over' | 'unknown';
  notesPence: number;
  coinsPence: number;
}

export function summariseCashUp(counts: DenominationCounts, expectedPence: number | null): CashUpSummary {
  const countedPence = countedTotal(counts);
  let notesPence = 0;
  for (const d of DENOMINATIONS) if (d.kind === 'note') notesPence += (counts[d.pence] ?? 0) * d.pence;
  const variance = expectedPence === null ? null : countedPence - expectedPence;
  return {
    countedPence, expectedPence, variancePence: variance, notesPence, coinsPence: countedPence - notesPence,
    status: variance === null ? 'unknown' : variance === 0 ? 'balanced' : variance < 0 ? 'short' : 'over',
  };
}
