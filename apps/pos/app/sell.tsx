import { formatGBP, formatQuantity, lineAmount, uuidv7 } from '@retail/shared';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import {
  addAgeCheck, addApproval, addItem, type Basket, type DiscountSpec, discountPercent, isEmpty, lineDiscountPence, priceOf,
  setBasketDiscount, setLineDiscount, setQuantity, type TillLine, voidLine,
} from '../src/logic/basket';
import { popularProducts, primaryBarcode, type Product, searchProducts } from '../src/logic/catalog';
import { ltr, type MessageKey, t, textDir, tn, useLang, vatLabel } from '../src/i18n';
import { can, discountDecision, limitDecision } from '../src/logic/permissions';
import { resolveProduct, resolveScan, type ScannedItem, type ScanOutcome } from '../src/logic/pricing';
import {
  countVoid, getState, newAgeCheck, newApproval, pull, setBasket, toast, useApp, voidSale, voidsSoFar,
} from '../src/state/store';
import { type ApprovalRequest, type ApprovalResult, ApprovalSheet } from '../src/ui/approval';
import { Challenge25Sheet } from '../src/ui/challenge25';
import { applyAmountKey, Badge, Banner, Button, Card, Divider, Keypad, Money, Row, Segmented, Sheet, T } from '../src/ui/components';
import { color, font, radius, shadow, space } from '../src/ui/theme';

type Pending = { item: ScannedItem } | null;
type DiscountTarget = { kind: 'line'; lineId: string } | { kind: 'basket' } | null;
type ApprovalCtx = { request: ApprovalRequest; resolve: (r: ApprovalResult) => void } | null;

/** The English text is what is recorded on the sale (void_reason); staff see it in their language. */
const VOID_REASONS: { value: string; key: MessageKey }[] = [
  { value: 'Scanned in error', key: 'void.reason.scannedInError' },
  { value: 'Customer changed mind', key: 'void.reason.changedMind' },
  { value: 'Damaged item', key: 'void.reason.damaged' },
  { value: 'Price query', key: 'void.reason.priceQuery' },
];
const voidReasonLabel = (value: string | null | undefined) => {
  const r = VOID_REASONS.find((x) => x.value === value);
  return r ? t(r.key) : value ?? '';
};
const DISCOUNT_REASONS = ['damaged_packaging', 'short_date', 'price_match', 'staff_discount', 'goodwill'] as const;

export default function Sell() {
  useLang();
  const { width } = useWindowDimensions();
  const wide = width >= 960;
  const catalog = useApp((s) => s.catalog);
  const basket = useApp((s) => s.basket);
  const staff = useApp((s) => s.session?.staff ?? null);
  const popularity = useApp((s) => s.popularity);
  const tillSession = useApp((s) => s.tillSession);
  const online = useApp((s) => s.online);
  const training = useApp((s) => s.training);
  const [query, setQuery] = useState('');
  const [pendingAge, setPendingAge] = useState<Pending>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [discountTarget, setDiscountTarget] = useState<DiscountTarget>(null);
  const [voidTarget, setVoidTarget] = useState<string | 'sale' | null>(null);
  const [approval, setApproval] = useState<ApprovalCtx>(null);
  const scanRef = useRef<TextInput>(null);

  const { priced, totals } = useMemo(() => priceOf(basket), [basket]);
  const popular = useMemo(() => popularProducts(catalog, popularity, 15), [catalog, popularity]);
  const results = useMemo(() => (query.trim().length >= 2 && !/^\d+$/.test(query.trim()) ? searchProducts(catalog, query, 15) : []), [catalog, query]);
  const modalOpen = !!(pendingAge || discountTarget || voidTarget || approval);
  const focusScan = () => setTimeout(() => scanRef.current?.focus(), 30);

  const askApproval = (request: ApprovalRequest) => new Promise<ApprovalResult | null>((resolve) => {
    setApproval({ request, resolve: (r) => resolve(r) });
    // cancel resolves null via onCancel below
    cancelRef.current = () => resolve(null);
  });
  const cancelRef = useRef<() => void>(() => {});

  // ------------------------------------------------------------------ adding items
  const addOutcome = (o: ScanOutcome) => {
    if (o.kind === 'unknown') return toast(t('sell.unknownBarcode', { barcode: o.barcode }), 'danger');
    if (o.kind === 'no_price') return toast(t('sell.noPrice', { name: o.product.name }), 'danger');
    const minAge = o.product.min_age;
    if (minAge) {
      const passed = getState().basket.ageChecks.find((a) => (a.outcome === 'looked_over_25' || a.outcome === 'id_checked_ok') && a.requiredAge >= minAge);
      if (!passed) { setPendingAge({ item: o }); return; }
      setBasket((b) => addItem(b, o, { ageCheckId: passed.id }).basket);
    } else {
      setBasket((b) => addItem(b, o).basket);
    }
    toast(t('sell.added', { name: o.product.name, amount: formatGBP(lineAmount(o.unitPricePence, o.quantity)) }), 'success');
    focusScan();
  };

  const handleCode = async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    if (!/^\d+$/.test(code)) {
      const hits = searchProducts(getState().catalog, code, 2);
      if (hits.length === 1) { pickProduct(hits[0]!); setQuery(''); }
      return;
    }
    setQuery('');
    let o = resolveScan(getState().catalog, code, { priceLevelId: getState().basket.priceLevelId });
    if (o.kind === 'unknown' && online) {
      // Maybe it was added in the back office a moment ago.
      await pull().catch(() => {});
      o = resolveScan(getState().catalog, code, { priceLevelId: getState().basket.priceLevelId });
    }
    addOutcome(o);
  };

  const pickProduct = (p: Product) => {
    addOutcome(resolveProduct(getState().catalog, p, primaryBarcode(getState().catalog, p.id), { priceLevelId: getState().basket.priceLevelId }));
  };

  const onAgeResult = (outcome: 'looked_over_25' | 'id_checked_ok' | 'refused' | 'id_not_available') => {
    const p = pendingAge;
    if (!p || !staff) return;
    const check = newAgeCheck({ productId: p.item.product.id, staffId: staff.id, requiredAge: p.item.product.min_age ?? 18, outcome });
    setPendingAge(null);
    if (outcome === 'looked_over_25' || outcome === 'id_checked_ok') {
      setBasket((b) => addItem(addAgeCheck(b, check), p.item, { ageCheckId: check.id }).basket);
      toast(t('sell.addedAgeOk', { name: p.item.product.name }), 'success');
    } else {
      setBasket((b) => addAgeCheck(b, check));
      toast(t('sell.ageRefused', { name: p.item.product.name }), 'danger');
    }
    focusScan();
  };

  // Keyboard-wedge scanners type fast then press Enter. Catch them even when the scan box lost focus.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let buf = '';
    let last = 0;
    const h = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || modalOpen) return;
      const now = Date.now();
      if (now - last > 80) buf = '';
      last = now;
      if (e.key === 'Enter') { if (buf.length >= 4) void handleCode(buf); buf = ''; return; }
      if (/^[0-9]$/.test(e.key)) buf += e.key;
      else if (e.key.length === 1) { scanRef.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // ------------------------------------------------------------------ line actions
  const changeQty = (l: TillLine, delta: number) => {
    const next = Math.round((l.quantity + delta) * 1000) / 1000;
    if (next <= 0) { setVoidTarget(l.id); return; }
    setBasket((b) => setQuantity(b, l.id, next));
  };

  const doVoid = async (reason: string) => {
    if (!staff || !voidTarget) return;
    const target = voidTarget;
    setVoidTarget(null);
    if (target === 'sale') {
      let voidedBy = staff.id;
      let rec;
      if (!can(staff, 'pos.void_sale')) {
        const r = await askApproval({ action: 'pos.void_sale', title: t('sell.voidSaleApprovalTitle'), description: t('sell.voidSaleApprovalBody', { name: staff.display_name, amount: formatGBP(totals.total) }) });
        if (!r) return focusScan();
        voidedBy = r.approverId;
        rec = newApproval({ actionCode: 'pos.void_sale', requestedBy: staff.id, approvedBy: r.approverId, outcome: 'approved', value: totals.total, reason });
      }
      await voidSale(voidedBy, reason, rec);
      toast(t('sell.saleVoided'), 'neutral');
      return focusScan();
    }
    const n = voidsSoFar(staff.id) + 1;
    if (limitDecision(staff, 'pos.void_line.max_per_shift', n) === 'needs_approval') {
      const r = await askApproval({ action: 'pos.void_line', limit: { code: 'pos.void_line.max_per_shift', value: n },
        title: t('sell.voidItemApprovalTitle'), description: t('sell.voidItemApprovalBody', { count: n, name: staff.display_name }) });
      if (!r) return focusScan();
      setBasket((b) => addApproval(b, newApproval({ saleLineId: target, actionCode: 'pos.void_line', requestedBy: staff.id, approvedBy: r.approverId, outcome: 'approved', value: n, reason })));
    }
    countVoid(staff.id);
    setBasket((b) => voidLine(b, target, staff.id, reason));
    setSelected(null);
    focusScan();
  };

  const applyDiscount = async (type: 'percent' | 'amount', value: number, reasonCode: string | null) => {
    if (!staff || !discountTarget) return;
    const target = discountTarget;
    setDiscountTarget(null);
    const b = getState().basket;
    const spec: DiscountSpec = { id: uuidv7(), type, value, staffId: staff.id, approvalId: null, reasonCode };
    let base: number, amount: number;
    if (target.kind === 'line') {
      const l = b.lines.find((x) => x.id === target.lineId)!;
      base = lineAmount(l.unitPricePence, l.quantity);
      amount = lineDiscountPence({ ...l, discount: spec });
    } else {
      const trial = setBasketDiscount(b, spec);
      base = priceOf(b).totals.subtotal;
      amount = priceOf(trial).totals.discount - priceOf(b).totals.discount;
    }
    if (amount <= 0) return toast(t('sell.discountWorthless'), 'danger');
    const pct = discountPercent(base, spec, amount);
    const decision = discountDecision(staff, pct, amount);
    let approvalRec;
    if (decision === 'needs_approval') {
      const r = await askApproval({ action: 'pos.discount', limit: { code: 'pos.discount.max_percent', value: pct },
        title: t('sell.discountApprovalTitle'), description: t('sell.discountApprovalBody', { amount: formatGBP(amount), percent: `${pct.toFixed(1)}%`, name: staff.display_name }) });
      if (!r) return focusScan();
      approvalRec = newApproval({ saleLineId: target.kind === 'line' ? target.lineId : null, actionCode: 'pos.discount', requestedBy: staff.id, approvedBy: r.approverId, outcome: 'approved', value: pct });
    } else {
      approvalRec = newApproval({ saleLineId: target.kind === 'line' ? target.lineId : null, actionCode: 'pos.discount', requestedBy: staff.id, approvedBy: null, outcome: 'self_authorised', value: pct });
    }
    const withApproval = { ...spec, approvalId: approvalRec.id };
    setBasket((bk) => {
      const next = addApproval(bk, approvalRec!);
      return target.kind === 'line' ? setLineDiscount(next, target.lineId, withApproval) : setBasketDiscount(next, withApproval);
    });
    toast(t('sell.discountApplied', { amount: formatGBP(amount) }), 'success');
    focusScan();
  };

  const canDiscount = can(staff, 'pos.discount');
  const canVoid = can(staff, 'pos.void_line');
  const liveCount = basket.lines.filter((l) => !l.voidedBy).length;

  // ------------------------------------------------------------------ render
  const left = (
    <View style={{ flex: wide ? 1.25 : undefined, gap: space.md, minWidth: 0 }}>
      <Card padded={false} style={{ padding: space.md }}>
        <Row gap={space.sm}>
          <View style={styles.scanIcon}><Text style={{ fontSize: 18, color: color.primary, fontWeight: '900', fontFamily: font.family }}>|||</Text></View>
          <TextInput
            ref={scanRef}
            testID="scan-input"
            accessibilityLabel={t('sell.scanLabel')}
            placeholder={t('sell.scanPlaceholder')}
            placeholderTextColor="#8A94A6"
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => void handleCode(query)}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            blurOnSubmit={false}
            returnKeyType="done"
            style={styles.scanInput}
          />
          {query ? <Button kind="ghost" label={t('common.clear')} onPress={() => { setQuery(''); focusScan(); }} /> : null}
        </Row>
      </Card>
      {!tillSession ? <Banner tone="warning" text={t('sell.noSession')} action={<Button kind="secondary" label={t('sell.openTill')} onPress={() => router.push('/open-till')} />} /> : null}
      <T v="caption" muted>{results.length ? tn('sell.matches', results.length) : query.trim().length >= 2 && !/^\d+$/.test(query.trim()) ? t('sell.noMatches') : t('sell.quickPicks')}</T>
      <View style={styles.grid}>
        {(results.length ? results : query.trim().length >= 2 && !/^\d+$/.test(query.trim()) ? [] : popular).map((p) => (
          <ProductTile key={p.id} product={p} onPress={() => { pickProduct(p); setQuery(''); }} />
        ))}
      </View>
    </View>
  );

  const right = (
    <Card padded={false} style={{ flex: wide ? 1 : undefined, minWidth: wide ? 400 : undefined, maxWidth: wide ? 520 : undefined, overflow: 'hidden' }}>
      <Row style={{ justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm }}>
        <T v="h2" accessibilityRole="header">{t('sell.basket')}</T>
        <T muted>{liveCount ? tn('sell.items', totals.items, { count: formatQuantity(totals.items) }) : t('sell.empty')}</T>
      </Row>
      <ScrollView style={{ flex: wide ? 1 : undefined, maxHeight: wide ? undefined : 380 }} contentContainerStyle={{ paddingHorizontal: space.md, gap: 6 }} testID="basket">
        {basket.lines.length === 0 ? (
          <View style={{ alignItems: 'center', padding: space.xxl, gap: space.sm }}>
            <T v="h3" muted>{t('sell.emptyTitle')}</T>
            <T v="small" muted>{t('sell.emptyHint')}</T>
          </View>
        ) : null}
        {priced.map((p) => {
          const l = basket.lines.find((x) => x.id === p.line.id)!;
          return (
            <BasketRow key={l.id} line={l} total={p.total} discount={p.lineDiscount} selected={selected === l.id}
              onSelect={() => setSelected(selected === l.id ? null : l.id)}
              onMinus={() => changeQty(l, -1)} onPlus={() => changeQty(l, 1)}
              onDiscount={canDiscount ? () => setDiscountTarget({ kind: 'line', lineId: l.id }) : undefined}
              onVoid={canVoid ? () => setVoidTarget(l.id) : undefined}
              canVoid={canVoid} />
          );
        })}
      </ScrollView>
      <View style={styles.totals}>
        <TotalRow label={t('sell.subtotal')} value={formatGBP(totals.subtotal)} />
        {totals.discount ? <TotalRow label={t('sell.discounts')} value={`−${formatGBP(totals.discount)}`} tone={color.success} /> : null}
        {Object.entries(totals.vatByCode).map(([code, v]) => (
          <TotalRow key={code} label={t('vat.line', { label: vatLabel(code) })} value={formatGBP(v.vat)} small />
        ))}
        <Divider />
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <T v="h3">{training ? t('sell.totalTraining') : t('sell.total')}</T>
          <Money pence={formatGBP(totals.total)} size={44} />
        </Row>
        <Row style={{ marginTop: space.sm }}>
          <Button kind="secondary" label={t('sell.discount')} icon="%" disabled={!canDiscount || isEmpty(basket)} onPress={() => setDiscountTarget({ kind: 'basket' })}
            hint={t('sell.discountHint')} style={{ flex: 1 }} />
          <Button kind="danger" label={t('sell.voidSale')} disabled={isEmpty(basket)} onPress={() => setVoidTarget('sale')} style={{ flex: 1 }} />
        </Row>
        <Button testID="pay" label={isEmpty(basket) ? t('sell.pay') : t('sell.payAmount', { amount: formatGBP(totals.total) })} size="xl" disabled={isEmpty(basket) || !can(staff, 'pos.sell')}
          onPress={() => router.push('/pay')} />
      </View>
    </Card>
  );

  return (
    <View style={{ flex: 1 }}>
      {wide ? (
        <View style={{ flex: 1, flexDirection: 'row', gap: space.lg, padding: space.lg }}>
          <ScrollView style={{ flex: 1.25 }} contentContainerStyle={{ gap: space.md }} keyboardShouldPersistTaps="handled">{left}</ScrollView>
          {right}
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: space.md, gap: space.md }} keyboardShouldPersistTaps="handled">
          {right}
          {left}
        </ScrollView>
      )}

      <Challenge25Sheet item={pendingAge ? { name: pendingAge.item.product.name, minAge: pendingAge.item.product.min_age ?? 18 } : null}
        onResult={onAgeResult} onCancel={() => { setPendingAge(null); focusScan(); }} />
      <VoidSheet target={voidTarget} basket={basket} onCancel={() => { setVoidTarget(null); focusScan(); }} onConfirm={doVoid} />
      <DiscountSheet target={discountTarget} basket={basket} onCancel={() => { setDiscountTarget(null); focusScan(); }} onApply={applyDiscount} />
      <ApprovalSheet request={approval?.request ?? null}
        onCancel={() => { setApproval(null); cancelRef.current(); }}
        onApproved={(r) => { const a = approval; setApproval(null); a?.resolve(r); }} />
    </View>
  );
}

// ------------------------------------------------------------------ pieces
function ProductTile({ product, onPress }: { product: Product; onPress: () => void }) {
  const catalog = useApp((s) => s.catalog);
  const o = useMemo(() => resolveProduct(catalog, product, primaryBarcode(catalog, product.id), { priceLevelId: null }), [catalog, product]);
  const price = o.kind === 'item' ? o.unitPricePence : null;
  return (
    <Pressable testID={`tile-${product.name}`} accessibilityRole="button"
      accessibilityLabel={[
        t('tile.a11y', { name: product.name, price: price !== null ? formatGBP(price) : t('tile.noPrice') }),
        product.min_age ? t('tile.agePlus', { age: product.min_age }) : null,
        o.kind === 'item' && o.isPmp ? t('tile.priceMarked') : null,
      ].filter(Boolean).join(t('common.listSep'))}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && { backgroundColor: color.primaryTint, transform: [{ scale: 0.985 }] }]}>
      <Text numberOfLines={2} style={[styles.tileName, textDir()]}>{product.name}</Text>
      <Row style={{ justifyContent: 'space-between', marginTop: 'auto' }}>
        <Text style={styles.tilePrice}>{ltr(`${price !== null ? formatGBP(price) : '—'}${product.sold_by_weight ? t('unit.perKg') : ''}`)}</Text>
        <Row gap={4}>
          {o.kind === 'item' && o.isPmp ? <Badge label={t('tile.pmp')} tone="primary" /> : null}
          {product.min_age ? <Badge label={ltr(`${product.min_age}+`)} tone="accent" /> : null}
        </Row>
      </Row>
    </Pressable>
  );
}

function BasketRow({ line, total, discount, selected, onSelect, onMinus, onPlus, onDiscount, onVoid, canVoid }: {
  line: TillLine; total: number; discount: number; selected: boolean; onSelect: () => void; onMinus: () => void; onPlus: () => void;
  onDiscount?: () => void; onVoid?: () => void; canVoid: boolean;
}) {
  const voided = !!line.voidedBy;
  const weighed = line.embedded !== null;
  return (
    <View style={[styles.line, selected && { borderColor: color.primary, backgroundColor: '#FBFDFD' }, voided && { opacity: 0.6 }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={t(voided ? 'line.a11yVoided' : 'line.a11y', { name: line.description, qty: formatQuantity(line.quantity), amount: formatGBP(total) })}
        onPress={voided ? undefined : onSelect} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text numberOfLines={2} style={[styles.lineName, textDir(), voided && { textDecorationLine: 'line-through' }]}>{line.description}</Text>
          <Row gap={6} wrap>
            <T v="small" muted>{weighed && line.embedded === 'weight'
              ? t('line.weighed', { qty: formatQuantity(line.quantity), price: formatGBP(line.unitPricePence) })
              : t('line.qtyPrice', { qty: formatQuantity(line.quantity), price: formatGBP(line.unitPricePence) })}</T>
            {line.isPmp && line.pmpPricePence !== null ? <Badge label={t('line.pmp', { price: formatGBP(line.pmpPricePence) })} tone="primary" /> : null}
            {line.minAge ? <Badge label={t('line.ageChecked', { age: `${line.minAge}+` })} tone="accent" symbol="✓" /> : null}
            {discount > 0 ? <Badge label={ltr(`−${formatGBP(discount)}`)} tone="success" /> : null}
            {voided ? <Badge label={t('line.voided', { reason: voidReasonLabel(line.voidReason) })} tone="danger" symbol="✕" /> : null}
          </Row>
        </View>
        <Money pence={formatGBP(total)} size={18} style={voided ? { textDecorationLine: 'line-through', color: color.muted } : undefined} />
      </Pressable>
      {selected && !voided ? (
        <Row style={{ marginTop: space.sm }} wrap>
          {!weighed ? (
            <>
              <Button kind="secondary" label="−" accessibilityLabel={t('common.oneLess', { name: line.description })} onPress={onMinus} disabled={line.quantity <= 1 && !canVoid} style={{ width: 56 }} />
              <T v="h3" style={{ minWidth: 36, textAlign: 'center' }}>{formatQuantity(line.quantity)}</T>
              <Button kind="secondary" label="+" accessibilityLabel={t('common.oneMore', { name: line.description })} onPress={onPlus} style={{ width: 56 }} />
            </>
          ) : null}
          <View style={{ flex: 1 }} />
          {onDiscount ? <Button kind="secondary" label={t('sell.discount')} onPress={onDiscount} /> : null}
          <Button testID={`void-${line.description}`} kind="danger" label={t('line.void')} onPress={onVoid} disabled={!onVoid} />
        </Row>
      ) : null}
    </View>
  );
}

function TotalRow({ label, value, tone, small }: { label: string; value: string; tone?: string; small?: boolean }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <T v={small ? 'small' : 'body'} muted={small}>{label}</T>
      <Money pence={value} size={small ? 14 : 17} tone={tone ?? (small ? color.muted : color.ink)} />
    </Row>
  );
}

function VoidSheet({ target, basket, onCancel, onConfirm }: { target: string | 'sale' | null; basket: Basket; onCancel: () => void; onConfirm: (reason: string) => void }) {
  if (!target) return null;
  const line = target === 'sale' ? null : basket.lines.find((l) => l.id === target);
  return (
    <Sheet visible title={target === 'sale' ? t('void.saleTitle') : t('void.itemTitle', { name: line?.description ?? t('void.item') })} onClose={onCancel} testID="void-sheet">
      <T muted>{target === 'sale' ? t('void.saleBody') : t('void.itemBody')}</T>
      <T v="label">{t('common.reason')}</T>
      <View style={{ gap: space.sm }}>
        {VOID_REASONS.map((r) => <Button key={r.value} kind="secondary" label={t(r.key)} onPress={() => onConfirm(r.value)} style={{ alignItems: 'flex-start' }} />)}
      </View>
    </Sheet>
  );
}

function DiscountSheet({ target, basket, onCancel, onApply }: {
  target: DiscountTarget; basket: Basket; onCancel: () => void; onApply: (type: 'percent' | 'amount', value: number, reason: string | null) => void;
}) {
  const [type, setType] = useState<'percent' | 'amount'>('percent');
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => { setTyped(''); setReason(null); setType('percent'); }, [target]);
  if (!target) return null;
  const line = target.kind === 'line' ? basket.lines.find((l) => l.id === target.lineId) : null;
  const base = line ? lineAmount(line.unitPricePence, line.quantity) : priceOf(basket).totals.total;
  const value = type === 'percent' ? Math.min(Number(typed || '0'), 100) : Number(typed || '0');
  const preview = type === 'percent' ? Math.round((base * value) / 100) : Math.min(value, base);
  return (
    <Sheet visible title={line ? t('discount.lineTitle', { name: line.description }) : t('discount.basketTitle')} onClose={onCancel} testID="discount-sheet"
      footer={<Button label={t('discount.apply', { amount: `−${formatGBP(preview)}` })} size="lg" disabled={preview <= 0} onPress={() => onApply(type, value, reason)} />}>
      <Segmented label={t('discount.type')} value={type} onChange={(v) => { setType(v); setTyped(''); }}
        options={[{ value: 'percent', label: t('discount.percent') }, { value: 'amount', label: t('discount.amount') }]} />
      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }} wrap gap={space.lg}>
        <View>
          <T muted>{t('discount.off', { amount: formatGBP(base) })}</T>
          <Money pence={type === 'percent' ? `${value}%` : formatGBP(value)} size={44} />
          <T muted>{t('discount.saves', { amount: formatGBP(preview) })}</T>
        </View>
        <Keypad size={60} testIDPrefix="disc" onKey={(k) => setTyped((t) => applyAmountKey(t, k, type === 'percent' ? 3 : 6))} />
      </Row>
      <T v="label">{t('common.reason')}</T>
      <Row wrap>
        {DISCOUNT_REASONS.map((code) => (
          <Button key={code} kind={reason === code ? 'primary' : 'secondary'} label={t(`discount.reason.${code}`)} onPress={() => setReason(code)} selected={reason === code} />
        ))}
      </Row>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scanIcon: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: color.primaryTint, alignItems: 'center', justifyContent: 'center' },
  scanInput: { flex: 1, minWidth: 0, minHeight: 52, fontSize: 19, color: color.ink, fontFamily: font.family, paddingHorizontal: space.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  tile: {
    width: 176, flexGrow: 1, maxWidth: 240, minHeight: 104, padding: space.md, borderRadius: radius.md, backgroundColor: color.card,
    borderWidth: 1, borderColor: color.border, gap: space.sm, ...shadow,
  },
  tileName: { fontSize: 15, fontWeight: '600', color: color.ink, fontFamily: font.family, lineHeight: 20 },
  tilePrice: { fontSize: 18, fontWeight: '800', color: color.ink, fontVariant: ['tabular-nums'], fontFamily: font.family },
  line: { borderWidth: 1, borderColor: color.border, borderRadius: radius.md, padding: space.md, backgroundColor: color.card },
  lineName: { fontSize: 16, fontWeight: '600', color: color.ink, fontFamily: font.family },
  totals: { borderTopWidth: 1, borderTopColor: color.border, padding: space.lg, gap: 6, backgroundColor: '#FCFCFD' },
});
