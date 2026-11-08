import { formatGBP } from '@retail/shared';
import { View } from 'react-native';
import { type MessageKey, t, useLang, vatLabel } from '../i18n';
import { Divider, Money, Row, T } from './components';
import { color, space } from './theme';

export interface ZReport {
  till_session_id: string;
  generated_at: string;
  opening_float_pence: number;
  sales: { count: number; gross_pence: number; discounts_pence: number; net_pence: number; vat_pence: number; items: number };
  voided_sales: { count: number; value_pence: number };
  voided_lines: { count: number; value_pence: number };
  payments: Record<string, number>;
  refunds: { count: number; total_pence: number; by_method: Record<string, number> };
  cash_movements: Record<string, { count: number; amount_pence: number }>;
  vat_by_code: Record<string, { gross_pence: number; vat_pence: number; net_pence: number }>;
  expected_cash_pence: number;
}

/** −£1.20 for a deduction, but plain £0.00 when there is none. */
const minus = (pence: number) => (pence > 0 ? `−${formatGBP(pence)}` : formatGBP(pence));

const MOVES: Record<string, MessageKey> = {
  no_sale: 'z.move.no_sale', paid_in: 'z.move.paid_in', paid_out: 'z.move.paid_out', cash_drop: 'z.move.cash_drop', float_adjust: 'z.move.float_adjust',
};

function Line({ l, r, strong, tone }: { l: string; r: string; strong?: boolean; tone?: string }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <T v={strong ? 'label' : 'body'} muted={!strong} style={{ flexShrink: 1 }}>{l}</T>
      <Money pence={r} size={strong ? 18 : 15} tone={tone} />
    </Row>
  );
}

/** X-read / Z report summary (GET /v1/till-sessions/:id/z-report). */
export function ZReportView({ z }: { z: ZReport }) {
  useLang();
  return (
    <View style={{ gap: 6 }} testID="z-report">
      <Line l={t('z.sales', { count: z.sales.count })} r={formatGBP(z.sales.gross_pence)} />
      <Line l={t('z.discounts')} r={minus(z.sales.discounts_pence)} />
      <Line l={t('z.net')} r={formatGBP(z.sales.net_pence)} strong />
      <Line l={t('z.ofWhichVat')} r={formatGBP(z.sales.vat_pence)} />
      <Divider />
      {Object.entries(z.payments).map(([m, v]) => <Line key={m} l={m === 'cash' ? t('z.cashTaken') : m === 'card' ? t('z.cardTaken') : m} r={formatGBP(v)} />)}
      <Line l={t('z.refunds', { count: z.refunds.count })} r={minus(z.refunds.total_pence)} />
      <Line l={t('z.voided', { sales: z.voided_sales.count, lines: z.voided_lines.count })} r={formatGBP(z.voided_sales.value_pence + z.voided_lines.value_pence)} />
      {Object.entries(z.cash_movements).map(([k, v]) => <Line key={k} l={t('z.movement', { label: MOVES[k] ? t(MOVES[k]) : k, count: v.count })} r={formatGBP(v.amount_pence)} />)}
      <Divider />
      {Object.entries(z.vat_by_code).map(([code, v]) => <Line key={code} l={t('z.vat', { label: vatLabel(code), amount: formatGBP(v.net_pence) })} r={formatGBP(v.vat_pence)} />)}
      <Divider />
      <Line l={t('z.openingFloat')} r={formatGBP(z.opening_float_pence)} />
      <View style={{ backgroundColor: color.primaryTint, borderRadius: 10, padding: space.md, marginTop: 4 }}>
        <Line l={t('z.expected')} r={formatGBP(z.expected_cash_pence)} strong tone={color.primary} />
      </View>
    </View>
  );
}
