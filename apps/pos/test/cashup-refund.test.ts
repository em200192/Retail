import { describe, expect, it } from 'vitest';
import { countedTotal, DENOMINATIONS, parseCount, summariseCashUp } from '../src/logic/cashup.ts';
import { decodePairingCode } from '../src/logic/pairing.ts';
import { buildRefundPayload, refundableLines, refundAmount, type SaleDetail } from '../src/logic/refund.ts';

describe('cash-up counting', () => {
  it('covers every UK note and coin', () => {
    expect(DENOMINATIONS.map((d) => d.label)).toEqual(['£50', '£20', '£10', '£5', '£2', '£1', '50p', '20p', '10p', '5p', '2p', '1p']);
  });

  it('adds up the drawer and reports the variance', () => {
    const counts = { 5000: 1, 2000: 3, 1000: 2, 500: 4, 200: 5, 100: 7, 50: 3, 20: 4, 10: 6, 5: 3, 2: 4, 1: 9 };
    // 50 + 60 + 20 + 20 + 10 + 7 + 1.50 + 0.80 + 0.60 + 0.15 + 0.08 + 0.09 = £170.22
    expect(countedTotal(counts)).toBe(17022);
    expect(summariseCashUp(counts, 17022)).toMatchObject({ status: 'balanced', variancePence: 0, notesPence: 15000, coinsPence: 2022 });
    expect(summariseCashUp(counts, 17100)).toMatchObject({ status: 'short', variancePence: -78 });
    expect(summariseCashUp(counts, 17000)).toMatchObject({ status: 'over', variancePence: 22 });
    expect(summariseCashUp({}, null)).toMatchObject({ status: 'unknown', countedPence: 0, variancePence: null });
  });

  it('only accepts whole counts', () => {
    expect(parseCount('12')).toBe(12);
    expect(parseCount('')).toBe(0);
    expect(parseCount('1.5')).toBeNull();
    expect(parseCount('-2')).toBeNull();
    expect(() => countedTotal({ 100: -1 })).toThrow();
  });
});

describe('refund amounts', () => {
  const sale: SaleDetail = {
    id: 's', receipt_number: 'MAN1-1-9', status: 'completed', is_training: false, total_pence: 600, completed_at: null,
    lines: [
      { id: 'l1', line_no: 1, product_id: 'p1', description: 'Lager', quantity: 3, unit_price_pence: 200, line_total_pence: 500, vat_code: 'S', vat_rate_percent: 20, is_voided: false },
      { id: 'l2', line_no: 2, product_id: 'p2', description: 'Milk', quantity: 1, unit_price_pence: 100, line_total_pence: 100, vat_code: 'Z', vat_rate_percent: 0, is_voided: false },
      { id: 'l3', line_no: 3, product_id: 'p3', description: 'Voided', quantity: 1, unit_price_pence: 100, line_total_pence: 100, vat_code: 'Z', vat_rate_percent: 0, is_voided: true },
    ],
    refunds: [{ lines: [{ sale_line_id: 'l1', quantity: 1, amount_pence: 166 }] }],
  };

  it('knows what is left to refund and never exceeds the server cap', () => {
    const lines = refundableLines(sale);
    expect(lines.map((l) => l.saleLineId)).toEqual(['l1', 'l2']);
    const lager = lines[0]!;
    expect(lager).toMatchObject({ refundedQty: 1, remainingQty: 2, refundedPence: 166 });
    expect(refundAmount(lager, 1)).toBe(166);          // floor(500/3)
    expect(refundAmount(lager, 2)).toBe(334);          // the rest: 500 - 166, = ceil(500*2/3)
    expect(() => refundAmount(lager, 3)).toThrow();
  });

  it('builds a refund payload with VAT per line', () => {
    const [lager, milk] = refundableLines(sale);
    const r = buildRefundPayload({ saleId: 's', tillSessionId: null, staffId: 'mo', reasonCode: 'changed_mind', method: 'cash',
      picks: [{ line: lager!, qty: 2, restock: false }, { line: milk!, qty: 1, restock: true }, { line: milk!, qty: 0, restock: true }] });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ amount_pence: 334, vat_pence: 56, restock: false, vat_code: 'S' });
    expect(r).toMatchObject({ total_pence: 434, vat_pence: 56, refund_method: 'cash', original_sale_id: 's' });
  });
});

describe('pairing code', () => {
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const good = { api: 'http://localhost:3100/', device_id: '019a4b2e-0000-7000-8000-000000000001', device_secret: 'x'.repeat(43) };

  it('decodes base64url JSON and tidies the API address', () => {
    expect(decodePairingCode(`  ${encode(good)}\n`)).toEqual({ ...good, api: 'http://localhost:3100' });
  });

  it('explains what is wrong with a bad code', () => {
    expect(() => decodePairingCode('')).toThrow(/Paste/);
    expect(() => decodePairingCode('not-a-code')).toThrow(/does not look like/);
    expect(() => decodePairingCode(encode({ ...good, device_id: 'nope' }))).toThrow(/device id/);
    expect(() => decodePairingCode(encode({ ...good, api: 'ftp://x' }))).toThrow(/API/);
  });
});
