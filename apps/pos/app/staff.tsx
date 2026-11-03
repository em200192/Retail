import { formatQuantity } from '@retail/shared';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { errorMessage } from '../src/api';
import { type Product, searchProducts } from '../src/logic/catalog';
import { can } from '../src/logic/permissions';
import { api, toast, useApp } from '../src/state/store';
import { Badge, Banner, Button, Card, Field, Row, Segmented, T } from '../src/ui/components';
import { color, radius, space } from '../src/ui/theme';

interface StockRow { product_id: string; name: string; on_hand: number; available: number; reorder_point: number | null; shelf_location: string | null }

export default function StaffTools() {
  const staff = useApp((s) => s.session?.staff ?? null);
  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 1100, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View><T v="caption" muted>Staff tools</T><T v="title" accessibilityRole="header">On the shop floor</T></View>
        <Button kind="secondary" label="← Back to the till" onPress={() => router.replace('/sell')} />
      </Row>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, alignItems: 'flex-start' }}>
        {can(staff, 'purchasing.request') ? <WeNeedThis /> : null}
        {can(staff, 'stock.view') ? <StockCheck /> : null}
        <Card style={{ flex: 1, minWidth: 280, gap: space.sm }}>
          <Row><T v="h3">Clock in / out</T><Badge label="Coming soon" tone="neutral" /></Row>
          <T muted>Clocking in from the till arrives with rotas and timesheets.</T>
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
        <Button kind="ghost" label="Change" onPress={() => onChange(null)} />
      </Row>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      <Field label="Product (name or barcode)" value={q} onChangeText={setQ} placeholder="Start typing…" autoCorrect={false} />
      {hits.map((p) => (
        <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={`Choose ${p.name}`} onPress={() => { onChange(p); setQ(''); }}
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
      toast('Request sent to the manager', 'success');
      setProduct(null); setFreeText(''); setQty(''); setNote(''); setPriority('normal');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Card style={{ flex: 1.3, minWidth: 320, gap: space.md }}>
      <T v="h3">“We need this”</T>
      <T v="small" muted>Tell the manager something is running out. It goes on the shopping list for approval.</T>
      <ProductPicker value={product} onChange={setProduct} />
      {!product ? <Field label="…or describe it" value={freeText} onChangeText={setFreeText} placeholder="e.g. Oat milk 1L — customers keep asking" /> : null}
      <Row wrap style={{ alignItems: 'flex-end' }}>
        <Field label="How many? (optional)" value={qty} onChangeText={(t) => setQty(t.replace(/[^\d]/g, ''))} keyboardType="number-pad" style={{ width: 180 }} />
        <View style={{ flex: 1, minWidth: 220, gap: 6 }}>
          <T v="label">Priority</T>
          <Segmented label="Priority" value={priority} onChange={setPriority} options={[{ value: 'normal', label: 'Normal' }, { value: 'urgent', label: 'Urgent' }]} />
        </View>
      </Row>
      <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. Fridge is empty" />
      {error ? <Banner tone="danger" text={error} /> : null}
      <Button label={busy ? 'Sending…' : 'Send request'} size="lg" disabled={busy || (!product && !freeText.trim())} onPress={send} />
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
      if (!r) setError(p.track_stock ? 'No stock record yet' : 'Stock is not tracked for this product');
      else setRow(r);
    } catch (e) { setError(errorMessage(e)); }
  };
  const low = row && row.reorder_point !== null && row.on_hand <= row.reorder_point;
  return (
    <Card style={{ flex: 1, minWidth: 280, gap: space.md }}>
      <T v="h3">Stock check</T>
      <ProductPicker value={product} onChange={(p) => void check(p)} />
      {error ? <Banner tone="warning" text={error} /> : null}
      {row ? (
        <View style={{ gap: 6 }}>
          <T v="display">{formatQuantity(row.on_hand)}</T>
          <T muted>in stock at this branch · {formatQuantity(row.available)} available</T>
          {low ? <Badge label={`Low — reorder point ${formatQuantity(row.reorder_point!)}`} tone="warning" symbol="!" /> : <Badge label="Stock OK" tone="success" symbol="✓" />}
          {row.shelf_location ? <T muted>Shelf: {row.shelf_location}</T> : null}
        </View>
      ) : null}
    </Card>
  );
}
