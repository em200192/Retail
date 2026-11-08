import { formatGBP, formatQuantity, lineAmount } from '@retail/shared';
import { StyleSheet, Text, View } from 'react-native';
import { dirStyle, fmtDate, type Lang, LANGUAGES, ltr, type MessageKey, textDir, tIn, useReceiptLang, vatShort } from '../i18n';
import type { Receipt } from '../state/store';
import { color, font } from './theme';

const mono = font.family;

export function receiptDate(iso: string, lang: Lang = 'en'): string {
  // Arabic Intl output puts RLM marks (U+200F) between the date parts; they are strong RTL
  // characters, so even inside an LTR isolate "08/11/2026" would print scrambled. Drop them.
  return fmtDate(iso, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }, lang)
    .replace(/[‎‏؜]/g, '');
}

/**
 * A UK till receipt: VAT number, VAT summary per rate, served by, dd/mm/yyyy 24 h.
 * Printed in English by default (UK customers); the Menu can make it follow the
 * till language. The paper has its own direction, so an English receipt stays
 * left-to-right inside an Arabic till screen.
 */
export function ReceiptPaper({ receipt }: { receipt: Receipt }) {
  const lang = useReceiptLang();
  const tr = (key: MessageKey, vars?: Record<string, string | number>) => tIn(lang, key, vars);
  const rtl = LANGUAGES[lang].dir === 'rtl';
  const cellAlign = { textAlign: rtl ? 'left' : 'right' } as const;
  const s = receipt.sale;
  const lines = s.lines.filter((l) => !l.is_voided);
  const vat: Record<string, { rate: number; gross: number; vat: number }> = {};
  for (const l of lines) {
    const v = (vat[l.vat_code] ??= { rate: l.vat_rate_percent, gross: 0, vat: 0 });
    v.gross += l.line_total_pence;
    v.vat += l.vat_pence;
  }
  const at = s.completed_at ?? s.voided_at ?? s.started_at ?? new Date().toISOString();
  const m = (pence: number, minus = false) => ltr(`${minus ? '-' : ''}${formatGBP(pence)}`, lang);
  const txt = [styles.mono, textDir(lang)];
  return (
    <View style={[styles.paper, dirStyle(lang)]} accessibilityLabel={tr('rcpt.a11y', { number: s.receipt_number })} testID="receipt-paper">
      {s.is_training ? <Text style={[textDir(lang), styles.training]}>{tr('rcpt.training')}</Text> : null}
      <Text style={styles.shop}>{receipt.shop.name}</Text>
      {receipt.shop.legalName && receipt.shop.legalName !== receipt.shop.name ? <Text style={styles.center}>{receipt.shop.legalName}</Text> : null}
      {receipt.shop.address.map((a) => <Text key={a} style={styles.center}>{a}</Text>)}
      {receipt.shop.vatNumber ? <Text style={[textDir(lang), styles.center]}>{tr('rcpt.vatNo', { number: receipt.shop.vatNumber })}</Text> : null}
      <Dash />
      <Pair l={ltr(receiptDate(at, lang), lang)} r={receipt.tillName} lang={lang} />
      <Pair l={tr('rcpt.receipt')} r={ltr(s.receipt_number, lang)} lang={lang} />
      <Pair l={tr('rcpt.servedBy')} r={receipt.servedBy} lang={lang} />
      <Dash />
      {lines.map((l) => (
        <View key={l.id} style={{ marginBottom: 4 }}>
          <Pair l={l.description} r={`${m(lineAmount(l.unit_price_pence, l.quantity))} ${l.vat_code}`} bold={false} lang={lang} />
          {l.quantity !== 1 ? <Text style={[styles.sub, textDir(lang)]}>  {ltr(`${formatQuantity(l.quantity)} @ ${formatGBP(l.unit_price_pence)}`, lang)}</Text> : null}
          {l.is_pmp && l.pmp_price_pence !== null ? <Text style={[styles.sub, textDir(lang)]}>  {tr('rcpt.priceMarked', { amount: formatGBP(l.pmp_price_pence) })}</Text> : null}
          {l.line_discount_pence + l.promotion_discount_pence > 0 ? <Pair l={`  ${tr('rcpt.discount')}`} r={m(l.line_discount_pence + l.promotion_discount_pence, true)} lang={lang} /> : null}
        </View>
      ))}
      <Dash />
      <Pair l={tr('rcpt.subtotal')} r={m(s.subtotal_pence)} lang={lang} />
      {s.discount_pence ? <Pair l={tr('rcpt.saved')} r={m(s.discount_pence, true)} lang={lang} /> : null}
      <Pair l={tr('rcpt.total')} r={m(s.total_pence)} big lang={lang} />
      <Dash />
      {s.payments.map((p) => (
        <View key={p.id}>
          {p.method === 'cash' ? (
            <>
              <Pair l={tr('rcpt.cash')} r={m(p.tendered_pence ?? p.amount_pence)} lang={lang} />
              {p.change_pence ? <Pair l={tr('rcpt.change')} r={m(p.change_pence)} bold lang={lang} /> : null}
            </>
          ) : (
            <>
              <Pair l={tr('rcpt.card', { card: `${(p.card_brand ?? '').toUpperCase()} **** ${p.card_last4 ?? ''}`.trim() })} r={m(p.amount_pence)} lang={lang} />
              {p.auth_code ? <Text style={[styles.sub, textDir(lang)]}>  {tr('rcpt.auth', { code: p.auth_code })}</Text> : null}
            </>
          )}
        </View>
      ))}
      <Dash />
      <Text style={[...txt, { fontWeight: '700' }]}>{tr('rcpt.vatSummary')}</Text>
      <View style={styles.vatHead}>
        <Text style={[...txt, styles.cell, cellAlign, { flex: 1.4 }]}>{tr('rcpt.rate')}</Text>
        <Text style={[...txt, styles.cell, cellAlign]}>{tr('rcpt.net')}</Text>
        <Text style={[...txt, styles.cell, cellAlign]}>{tr('rcpt.vat')}</Text>
        <Text style={[...txt, styles.cell, cellAlign]}>{tr('rcpt.gross')}</Text>
      </View>
      {Object.entries(vat).sort().map(([code, v]) => (
        <View key={code} style={{ flexDirection: 'row' }}>
          <Text style={[...txt, styles.cell, cellAlign, { flex: 1.4 }]}>{code} {vatShort(code, v.rate, lang)}</Text>
          <Text style={[...txt, styles.cell, cellAlign]}>{m(v.gross - v.vat)}</Text>
          <Text style={[...txt, styles.cell, cellAlign]}>{m(v.vat)}</Text>
          <Text style={[...txt, styles.cell, cellAlign]}>{m(v.gross)}</Text>
        </View>
      ))}
      <Dash />
      <Text style={[textDir(lang), styles.center]}>{tr('rcpt.thanks')}</Text>
      <Text style={[textDir(lang), styles.center, styles.sub]}>{tr('rcpt.keep')}</Text>
    </View>
  );

}


function Pair({ l, r, big, bold, lang }: { l: string; r: string; big?: boolean; bold?: boolean; lang: Lang }) {
  const st = [styles.mono, textDir(lang), big && { fontSize: 20, fontWeight: '800' as const }, bold && { fontWeight: '700' as const }];
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={[...st, { flex: 1 }]}>{l}</Text>
      <Text style={st}>{r}</Text>
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
  cell: { flex: 1, fontSize: 12 },
});
