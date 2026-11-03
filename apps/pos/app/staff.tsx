import { formatQuantity } from '@retail/shared';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { errorMessage } from '../src/api';
import { t, useLang } from '../src/i18n';
import { type Product, searchProducts } from '../src/logic/catalog';
import { can } from '../src/logic/permissions';
import { api, toast, useApp } from '../src/state/store';
import { Badge, Banner, Button, Card, Field, Row, Segmented, T } from '../src/ui/components';
import { color, radius, space } from '../src/ui/theme';

interface StockRow { product_id: string; name: string; on_hand: number; available: number; reorder_point: number | null; shelf_location: string | null }

export default function StaffTools() {
  useLang();
  const staff = useApp((s) => s.session?.staff ?? null);
  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 1100, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View><T v="caption" muted>{t('staff.caption')}</T><T v="title" accessibilityRole="header">{t('staff.title')}</T></View>
        <Button kind="secondary" label={t('common.backToTill')} onPress={() => router.replace('/sell')} />
      </Row>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, alignItems: 'flex-start' }}>
        {can(staff, 'purchasing.request') ? <WeNeedThis /> : null}
        {can(staff, 'stock.view') ? <StockCheck /> : null}
        <Card style={{ flex: 1, minWidth: 280, gap: space.sm }}>
          <Row><T v="h3">{t('staff.clock')}</T><Badge label={t('common.comingSoon')} tone="neutral" /></Row>
          <T muted>{t('staff.clockBody')}</T>
        </Card>
      </View>
    </ScrollView>
  );
}

function ProductPicker({ value, onChange }: { value: Product | null; onChange: (p: Product | null) => void }) {
  const catalog = useApp((s) => s.catalog);
  const [q, setQ] = useState('');
  const hits = useMemo(() => (q.trim().length >= 2 ? searchProducts(catalog, q, 6) : []), [catalog, q]);
  if (value) {
    return (
      <Row style={{ justifyContent: 'space-between', backgroundColor: color.primaryTint, borderRadius: radius.sm, padding: space.md }}>
        <T v="label" style={{ flex: 1 }}>✓ {value.name}</T>
        <Button kind="ghost" label={t('staff.change')} onPress={() => onChange(null)} />
      </Row>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      <Field label={t('staff.product')} value={q} onChangeText={setQ} placeholder={t('staff.productPlaceholder')} autoCorrect={false} />
      {hits.map((p) => (
        <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={t('staff.choose', { name: p.name })} onPress={() => { onChange(p); setQ(''); }}
          style={({ pressed }) => ({ minHeight: 48, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: color.border, backgroundColor: pressed ? color.primaryTint : color.card })}>
          <T>{p.name}</T>
        </Pressable>
      ))}
    </View>
  );
}

function WeNeedThis() {
  const branchId = useApp((s) => s.catalog.branch?.id ?? '');
  const [product, setProduct] = useState<Product | null>(null);
  const [freeText, setFreeText] = useState('');
  const [qty, setQty] = useState('');
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      await api('POST', '/v1/purchase-requests', { branch_id: branchId, product_id: product?.id ?? null, free_text: product ? null : freeText.trim() || null,
        quantity: qty ? Number(qty) : null, priority, note: note.trim() || null });
      toast(t('staff.requestSent'), 'success');
      setProduct(null); setFreeText(''); setQty(''); setNote(''); setPriority('normal');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Card style={{ flex: 1.3, minWidth: 320, gap: space.md }}>
      <T v="h3">{t('staff.weNeed')}</T>
      <T v="small" muted>{t('staff.weNeedBody')}</T>
      <ProductPicker value={product} onChange={setProduct} />
      {!product ? <Field label={t('staff.describe')} value={freeText} onChangeText={setFreeText} placeholder={t('staff.describePlaceholder')} /> : null}
      <Row wrap style={{ alignItems: 'flex-end' }}>
        <Field label={t('staff.howMany')} value={qty} onChangeText={(t) => setQty(t.replace(/[^\d]/g, ''))} keyboardType="number-pad" style={{ width: 180 }} />
        <View style={{ flex: 1, minWidth: 220, gap: 6 }}>
          <T v="label">{t('staff.priority')}</T>
          <Segmented label={t('staff.priority')} value={priority} onChange={setPriority} options={[{ value: 'normal', label: t('staff.normal') }, { value: 'urgent', label: t('staff.urgent') }]} />
        </View>
      </Row>
      <Field label={t('staff.note')} value={note} onChangeText={setNote} placeholder={t('staff.notePlaceholder')} />
      {error ? <Banner tone="danger" text={error} /> : null}
      <Button label={busy ? t('staff.sending') : t('staff.send')} size="lg" disabled={busy || (!product && !freeText.trim())} onPress={send} />
    </Card>
  );
}

function StockCheck() {
  const branchId = useApp((s) => s.catalog.branch?.id ?? '');
  const [product, setProduct] = useState<Product | null>(null);
  const [row, setRow] = useState<StockRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = async (p: Product | null) => {
    setProduct(p); setRow(null); setError(null);
    if (!p) return;
    try {
      const rows = await api<StockRow[]>('GET', `/v1/stock?branch_id=${branchId}&q=${encodeURIComponent(p.name)}`);
      const r = rows.find((x) => x.product_id === p.id);
      if (!r) setError(p.track_stock ? t('staff.noStockRecord') : t('staff.notTracked'));
      else setRow(r);
    } catch (e) { setError(errorMessage(e)); }
  };
  const low = row && row.reorder_point !== null && row.on_hand <= row.reorder_point;
  return (
    <Card style={{ flex: 1, minWidth: 280, gap: space.md }}>
      <T v="h3">{t('staff.stockCheck')}</T>
      <ProductPicker value={product} onChange={(p) => void check(p)} />
      {error ? <Banner tone="warning" text={error} /> : null}
      {row ? (
        <View style={{ gap: 6 }}>
          <T v="display">{formatQuantity(row.on_hand)}</T>
          <T muted>{t('staff.inStock', { available: formatQuantity(row.available) })}</T>
          {low ? <Badge label={t('staff.low', { qty: formatQuantity(row.reorder_point!) })} tone="warning" symbol="!" /> : <Badge label={t('staff.ok')} tone="success" symbol="✓" />}
          {row.shelf_location ? <T muted>{t('staff.shelf', { shelf: row.shelf_location })}</T> : null}
        </View>
      ) : null}
    </Card>
  );
}
