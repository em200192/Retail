import { formatGBP, VAT_LABELS } from '@retail/shared';
import { View } from 'react-native';
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

const MOVES: Record<string, string> = { no_sale: 'No sales', paid_in: 'Paid in', paid_out: 'Paid out', cash_drop: 'Cash drops', float_adjust: 'Float adjustments' };

function Line({ l, r, strong, tone }: { l: string; r: string; strong?: boolean; tone?: string }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <T v={strong ? 'label' : 'body'} muted={!strong}>{l}</T>
      <Money pence={r} size={strong ? 18 : 15} tone={tone} />
    </Row>
  );
}

/** X-read / Z report summary (GET /v1/till-sessions/:id/z-report). */
export function ZReportView({ z }: { z: ZReport }) {
  return (
    <View style={{ gap: 6 }} testID="z-report">
      <Line l={`Sales (${z.sales.count})`} r={formatGBP(z.sales.gross_pence)} />
      <Line l="Discounts" r={`−${formatGBP(z.sales.discounts_pence)}`} />
      <Line l="Net sales" r={formatGBP(z.sales.net_pence)} strong />
      <Line l="of which VAT" r={formatGBP(z.sales.vat_pence)} />
      <Divider />
      {Object.entries(z.payments).map(([m, v]) => <Line key={m} l={m === 'cash' ? 'Cash taken' : m === 'card' ? 'Card taken' : m} r={formatGBP(v)} />)}
      <Line l={`Refunds (${z.refunds.count})`} r={`−${formatGBP(z.refunds.total_pence)}`} />
      <Line l={`Voided sales (${z.voided_sales.count}) · lines (${z.voided_lines.count})`} r={formatGBP(z.voided_sales.value_pence + z.voided_lines.value_pence)} />
      {Object.entries(z.cash_movements).map(([k, v]) => <Line key={k} l={`${MOVES[k] ?? k} (${v.count})`} r={formatGBP(v.amount_pence)} />)}
      <Divider />
      {Object.entries(z.vat_by_code).map(([code, v]) => <Line key={code} l={`VAT ${VAT_LABELS[code] ?? code}: net ${formatGBP(v.net_pence)}`} r={formatGBP(v.vat_pence)} />)}
      <Divider />
      <Line l="Opening float" r={formatGBP(z.opening_float_pence)} />
      <View style={{ backgroundColor: color.primaryTint, borderRadius: 10, padding: space.md, marginTop: 4 }}>
        <Line l="Cash expected in drawer" r={formatGBP(z.expected_cash_pence)} strong tone={color.primary} />
      </View>
    </View>
  );
}
