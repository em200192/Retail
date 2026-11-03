import { formatDateUK, formatGBP, formatQuantity, lineAmount, VAT_LABELS } from '@retail/shared';
import { StyleSheet, Text, View } from 'react-native';
import type { Receipt } from '../state/store';
import { color, font } from './theme';

const mono = font.family;

export function receiptDate(iso: string): string {
  return formatDateUK(iso, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** A UK till receipt: VAT number, VAT summary per rate, served by, dd/mm/yyyy 24 h. */
export function ReceiptPaper({ receipt }: { receipt: Receipt }) {
  const s = receipt.sale;
  const lines = s.lines.filter((l) => !l.is_voided);
  const vat: Record<string, { rate: number; gross: number; vat: number }> = {};
  for (const l of lines) {
    const v = (vat[l.vat_code] ??= { rate: l.vat_rate_percent, gross: 0, vat: 0 });
    v.gross += l.line_total_pence;
    v.vat += l.vat_pence;
  }
  const at = s.completed_at ?? s.voided_at ?? s.started_at ?? new Date().toISOString();
  return (
    <View style={styles.paper} accessibilityLabel={`Receipt ${s.receipt_number}`} testID="receipt-paper">
      {s.is_training ? <Text style={styles.training}>TRAINING – NOT A VALID RECEIPT</Text> : null}
      <Text style={styles.shop}>{receipt.shop.name}</Text>
      {receipt.shop.legalName && receipt.shop.legalName !== receipt.shop.name ? <Text style={styles.center}>{receipt.shop.legalName}</Text> : null}
      {receipt.shop.address.map((a) => <Text key={a} style={styles.center}>{a}</Text>)}
      {receipt.shop.vatNumber ? <Text style={styles.center}>VAT No. {receipt.shop.vatNumber}</Text> : null}
      <Dash />
      <Pair l={receiptDate(at)} r={receipt.tillName} />
      <Pair l="Receipt" r={s.receipt_number} />
      <Pair l="Served by" r={receipt.servedBy} />
      <Dash />
      {lines.map((l) => (
        <View key={l.id} style={{ marginBottom: 4 }}>
          <Pair l={l.description} r={formatGBP(lineAmount(l.unit_price_pence, l.quantity))} bold={false} code={l.vat_code} />
          {l.quantity !== 1 ? <Text style={styles.sub}>  {formatQuantity(l.quantity)} @ {formatGBP(l.unit_price_pence)}</Text> : null}
          {l.is_pmp && l.pmp_price_pence !== null ? <Text style={styles.sub}>  Price marked {formatGBP(l.pmp_price_pence)}</Text> : null}
          {l.line_discount_pence + l.promotion_discount_pence > 0 ? <Pair l="  Discount" r={`-${formatGBP(l.line_discount_pence + l.promotion_discount_pence)}`} /> : null}
        </View>
      ))}
      <Dash />
      <Pair l="Subtotal" r={formatGBP(s.subtotal_pence)} />
      {s.discount_pence ? <Pair l="You saved" r={`-${formatGBP(s.discount_pence)}`} /> : null}
      <Pair l="TOTAL" r={formatGBP(s.total_pence)} big />
      <Dash />
      {s.payments.map((p) => (
        <View key={p.id}>
          {p.method === 'cash' ? (
            <>
              <Pair l="Cash" r={formatGBP(p.tendered_pence ?? p.amount_pence)} />
              {p.change_pence ? <Pair l="Change" r={formatGBP(p.change_pence)} bold /> : null}
            </>
          ) : (
            <>
              <Pair l={`Card ${(p.card_brand ?? '').toUpperCase()} **** ${p.card_last4 ?? ''}`} r={formatGBP(p.amount_pence)} />
              {p.auth_code ? <Text style={styles.sub}>  Auth {p.auth_code} · Contactless</Text> : null}
            </>
          )}
        </View>
      ))}
      <Dash />
      <Text style={[styles.mono, { fontWeight: '700' }]}>VAT summary</Text>
      <View style={styles.vatHead}>
        <Text style={[styles.mono, styles.cell, { flex: 1.4 }]}>Rate</Text>
        <Text style={[styles.mono, styles.cell]}>Net</Text>
        <Text style={[styles.mono, styles.cell]}>VAT</Text>
        <Text style={[styles.mono, styles.cell]}>Gross</Text>
      </View>
      {Object.entries(vat).sort().map(([code, v]) => (
        <View key={code} style={{ flexDirection: 'row' }}>
          <Text style={[styles.mono, styles.cell, { flex: 1.4 }]}>{code} {VAT_LABELS[code]?.replace(/^\w+ /, '') ?? `${v.rate}%`}</Text>
          <Text style={[styles.mono, styles.cell]}>{formatGBP(v.gross - v.vat)}</Text>
          <Text style={[styles.mono, styles.cell]}>{formatGBP(v.vat)}</Text>
          <Text style={[styles.mono, styles.cell]}>{formatGBP(v.gross)}</Text>
        </View>
      ))}
      <Dash />
      <Text style={styles.center}>Thank you for shopping with us</Text>
      <Text style={[styles.center, styles.sub]}>Please keep your receipt for refunds</Text>
    </View>
  );
}

function Pair({ l, r, big, bold, code }: { l: string; r: string; big?: boolean; bold?: boolean; code?: string }) {
  const st = [styles.mono, big && { fontSize: 20, fontWeight: '800' as const }, bold && { fontWeight: '700' as const }];
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={[...st, { flex: 1 }]}>{l}</Text>
      <Text style={st}>{r}{code ? ` ${code}` : ''}</Text>
    </View>
  );
}

function Dash() {
  return <View style={{ borderBottomWidth: 1, borderStyle: 'dashed', borderColor: '#94A3B8', marginVertical: 8 }} />;
}

const styles = StyleSheet.create({
  paper: { backgroundColor: '#fff', width: 380, maxWidth: '100%', padding: 22, borderRadius: 6, borderWidth: 1, borderColor: color.border },
  shop: { fontFamily: mono, fontSize: 20, fontWeight: '800', textAlign: 'center', color: color.ink },
  center: { fontFamily: mono, fontSize: 13, textAlign: 'center', color: color.ink },
  mono: { fontFamily: mono, fontSize: 14, color: color.ink, fontVariant: ['tabular-nums'] },
  sub: { fontFamily: mono, fontSize: 12, color: color.muted },
  training: { fontFamily: mono, fontSize: 14, fontWeight: '900', textAlign: 'center', color: color.accentInk, backgroundColor: color.accent, padding: 6, marginBottom: 8 },
  vatHead: { flexDirection: 'row', borderBottomWidth: 1, borderColor: color.border, marginTop: 4, marginBottom: 2 },
  cell: { flex: 1, fontSize: 12, textAlign: 'right' },
});
