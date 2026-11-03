import { formatGBP } from '@retail/shared';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { errorMessage } from '../src/api';
import { LTR, t, useLang } from '../src/i18n';
import { DENOMINATIONS, type DenominationCounts, parseCount, summariseCashUp } from '../src/logic/cashup';
import { can } from '../src/logic/permissions';
import { api, clearTillSession, getState, syncNow, useApp } from '../src/state/store';
import { Badge, Banner, Button, Card, Divider, Field, Money, Row, T } from '../src/ui/components';
import { color, font, radius, space } from '../src/ui/theme';
import { type ZReport, ZReportView } from '../src/ui/zreport';

export default function CashUp() {
  useLang();
  const staff = useApp((s) => s.session?.staff ?? null);
  const session = useApp((s) => s.tillSession);
  const pending = useApp((s) => s.queue.pending);
  const { width } = useWindowDimensions();
  const [counts, setCounts] = useState<DenominationCounts>({});
  const [z, setZ] = useState<ZReport | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState<{ variance_pence: number; expected_cash_pence: number; counted_cash_pence: number; z_report: ZReport } | null>(null);
  const showExpected = can(staff, 'pos.z_report');

  const load = async () => {
    if (!session) return;
    setError(null);
    try {
      await syncNow();                  // queued sales must reach the server before we compare
      setZ(await api<ZReport>('GET', `/v1/till-sessions/${session.id}/z-report`));
    } catch (e) { setError(errorMessage(e)); }
  };
  useEffect(() => { void load(); }, [session?.id]);

  const summary = useMemo(() => summariseCashUp(counts, showExpected ? z?.expected_cash_pence ?? null : null), [counts, z, showExpected]);

  const close = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await syncNow();
      const left = getState().queue.pending;
      if (left > 0) throw new Error(t('cashup.stillWaiting', { count: left }));
      const r = await api<typeof closed & object>('POST', `/v1/till-sessions/${session.id}/close`, { counted_cash_pence: summary.countedPence, notes: notes || null });
      setClosed(r);
      clearTillSession();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (closed) {
    const v = closed.variance_pence;
    return (
      <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 720, width: '100%', alignSelf: 'center' }}>
        <Card style={{ gap: space.md, padding: space.xl }}>
          <T v="caption" tone={color.success}>{t('cashup.closedCaption')}</T>
          <T v="title">{v === 0 ? t('cashup.balances') : v < 0 ? t('cashup.shortBy', { amount: formatGBP(-v) }) : t('cashup.overBy', { amount: formatGBP(v) })}</T>
          <Row style={{ justifyContent: 'space-between' }}><T muted>{t('cashup.expected')}</T><Money pence={formatGBP(closed.expected_cash_pence)} /></Row>
          <Row style={{ justifyContent: 'space-between' }}><T muted>{t('cashup.counted')}</T><Money pence={formatGBP(closed.counted_cash_pence)} /></Row>
          {v !== 0 ? <Banner tone="warning" text={t('cashup.varianceSent')} /> : null}
          <Divider />
          <ZReportView z={closed.z_report} />
        </Card>
        <Button label={t('common.done')} size="xl" onPress={() => router.replace('/open-till')} />
      </ScrollView>
    );
  }

  const set = (pence: number, n: number) => setCounts((c) => ({ ...c, [pence]: Math.max(0, n) }));
  const wide = width >= 980;
  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 1200, width: '100%', alignSelf: 'center' }}>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View>
          <T v="caption" muted>{t('cashup.caption')}</T>
          <T v="title" accessibilityRole="header">{t('cashup.title')}</T>
        </View>
        <Button kind="secondary" label={t('common.back')} onPress={() => router.back()} />
      </Row>
      {!session ? <Banner tone="warning" text={t('cashup.noSession')} /> : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.lg, alignItems: 'flex-start' }}>
        <Card style={{ flex: 1.4, gap: 4, width: wide ? undefined : '100%' }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: space.sm }}>
            <T v="h3">{t('cashup.countDrawer')}</T>
            <Button kind="ghost" label={t('cashup.clearAll')} onPress={() => setCounts({})} />
          </Row>
          {DENOMINATIONS.map((d) => {
            const n = counts[d.pence] ?? 0;
            return (
              <View key={d.pence} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 6, borderBottomWidth: 1, borderColor: '#F1F5F9' }}>
                <View style={{ width: 64, height: 40, borderRadius: d.kind === 'note' ? 6 : 20, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: d.kind === 'note' ? color.primaryTint : '#F1F5F9', borderWidth: 1, borderColor: d.kind === 'note' ? '#B9DAD7' : color.border }}>
                  <Text style={[{ fontWeight: '800', fontSize: 15, color: color.ink, fontFamily: font.family }, LTR]}>{d.label}</Text>
                </View>
                <Stepper label={d.label} onPress={() => set(d.pence, n - 1)} sym="−" />
                <TextInput testID={`count-${d.label}`} accessibilityLabel={t(d.kind === 'note' ? 'cashup.countNotes' : 'cashup.countCoins', { label: d.label })} keyboardType="number-pad" inputMode="numeric"
                  value={n ? String(n) : ''} placeholder="0" placeholderTextColor="#94A3B8"
                  onChangeText={(t) => { const v = parseCount(t); if (v !== null) set(d.pence, v); }}
                  style={{ width: 72, height: 44, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: radius.sm, textAlign: 'center', fontSize: 18, fontWeight: '700', color: color.ink, fontFamily: font.family }} />
                <Stepper label={d.label} onPress={() => set(d.pence, n + 1)} sym="+" />
                <View style={{ flex: 1 }} />
                <Money pence={formatGBP(n * d.pence)} size={16} tone={n ? color.ink : '#94A3B8'} />
              </View>
            );
          })}
        </Card>
        <View style={{ flex: 1, gap: space.lg, width: wide ? undefined : '100%' }}>
          <Card style={{ gap: space.sm, padding: space.xl }}>
            <T v="caption" muted>{t('cashup.counted')}</T>
            <Money pence={formatGBP(summary.countedPence)} size={52} />
            <T muted>{t('cashup.notesCoins', { notes: formatGBP(summary.notesPence), coins: formatGBP(summary.coinsPence) })}</T>
            <Divider />
            {showExpected ? (
              <>
                <Row style={{ justifyContent: 'space-between' }}><T>{t('cashup.expectedInDrawer')}</T><Money pence={z ? formatGBP(z.expected_cash_pence) : '…'} size={18} /></Row>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T v="label">{t('cashup.variance')}</T>
                  {summary.variancePence === null ? <T muted>—</T> : (
                    <Row>
                      <Badge tone={summary.status === 'balanced' ? 'success' : 'warning'} symbol={summary.status === 'balanced' ? '✓' : '!'}
                        label={summary.status === 'balanced' ? t('cashup.balanced') : summary.status === 'short' ? t('cashup.short') : t('cashup.over')} />
                      <Money pence={`${summary.variancePence > 0 ? '+' : ''}${formatGBP(summary.variancePence)}`} size={20}
                        tone={summary.status === 'balanced' ? color.success : color.warning} />
                    </Row>
                  )}
                </Row>
              </>
            ) : <T v="small" muted>{t('cashup.blind')}</T>}
            <Field label={t('cashup.notes')} value={notes} onChangeText={setNotes} placeholder={t('cashup.notesPlaceholder')} />
            <Button testID="close-till" label={busy ? t('cashup.closing') : t('cashup.close', { amount: formatGBP(summary.countedPence) })} size="xl" onPress={close}
              disabled={busy || !session || !can(staff, 'pos.close_till')} />
            {pending ? <T v="small" tone={color.warning}>{t('cashup.pending', { count: pending })}</T> : null}
          </Card>
          {z && showExpected ? <Card><T v="h3" style={{ marginBottom: space.sm }}>{t('cashup.xReadSoFar')}</T><ZReportView z={z} /></Card> : null}
        </View>
      </View>
    </ScrollView>
  );
}

function Stepper({ sym, onPress, label }: { sym: string; onPress: () => void; label: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t(sym === '+' ? 'common.oneMore' : 'common.oneLess', { name: label })} onPress={onPress}
      style={({ pressed }) => ({ width: 48, height: 48, borderRadius: radius.sm, borderWidth: 1, borderColor: color.border, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.primaryTint : color.card })}>
      <Text style={{ fontSize: 22, fontWeight: '700', color: color.ink, fontFamily: font.family }}>{sym}</Text>
    </Pressable>
  );
}
