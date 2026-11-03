import { formatGBP, type PaymentInput, quickCashOptions, uuidv7 } from '@retail/shared';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { errorMessage } from '../src/api';
import { isEmpty, priceOf } from '../src/logic/basket';
import { completeSale, runtime, toast, useApp } from '../src/state/store';
import { terminal } from '../src/terminal';
import { applyAmountKey, Badge, Banner, Button, Card, Keypad, Money, Row, Segmented, T } from '../src/ui/components';
import { color, font, radius, space } from '../src/ui/theme';

export default function Pay() {
  const basket = useApp((s) => s.basket);
  const training = useApp((s) => s.training);
  const { width } = useWindowDimensions();
  const { totals } = useMemo(() => priceOf(basket), [basket]);
  const [payments, setPayments] = useState<PaymentInput[]>([]);
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const [typed, setTyped] = useState('');
  const [cardBusy, setCardBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const paid = payments.reduce((a, p) => a + p.amountPence, 0);
  const remaining = totals.total - paid;
  const typedPence = Number(typed || '0');

  useEffect(() => { if (isEmpty(basket) && payments.length === 0 && !busy) router.replace('/sell'); }, [basket]);

  const finish = async (all: PaymentInput[]) => {
    setBusy(true);
    try {
      await completeSale(all);
      router.replace('/receipt');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const takeCash = (tendered: number) => {
    if (tendered <= 0) return;
    const now = new Date().toISOString();
    if (tendered >= remaining) {
      const p: PaymentInput = { id: uuidv7(), method: 'cash', amountPence: remaining, tenderedPence: tendered, changePence: tendered - remaining, occurredAt: now };
      void finish([...payments, p]);
    } else {
      // Part payment in cash; the rest by another method (split).
      setPayments((ps) => [...ps, { id: uuidv7(), method: 'cash', amountPence: tendered, tenderedPence: tendered, changePence: 0, occurredAt: now }]);
      setTyped('');
      toast(`${formatGBP(tendered)} cash taken · ${formatGBP(remaining - tendered)} left to pay`);
    }
  };

  const takeCard = async () => {
    const amount = typedPence > 0 ? Math.min(typedPence, remaining) : remaining;
    if (amount <= 0) return;
    setCardBusy(true);
    runtime.cardInProgress = true;
    setError(null);
    abort.current = new AbortController();
    try {
      const r = await terminal.charge(amount, { signal: abort.current.signal });
      if (r.status !== 'approved') throw new Error(r.message ?? 'Card declined');
      const p: PaymentInput = { id: uuidv7(), method: 'card', amountPence: amount, provider: r.provider, providerTxnRef: r.providerTxnRef,
        cardBrand: r.cardBrand, cardLast4: r.cardLast4, authCode: r.authCode, occurredAt: new Date().toISOString() };
      const all = [...payments, p];
      setPayments(all);
      setTyped('');
      if (amount === remaining) await finish(all);
      else toast(`Card approved ${formatGBP(amount)} · ${formatGBP(remaining - amount)} left`, 'success');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCardBusy(false);
      runtime.cardInProgress = false;
    }
  };

  const wide = width >= 900;
  const quick = remaining > 0 ? quickCashOptions(remaining) : [];

  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 1180, width: '100%', alignSelf: 'center' }}>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <Button kind="ghost" label="← Back to basket" onPress={() => router.back()} disabled={payments.length > 0 || cardBusy || busy} />
        {training ? <Badge label="Training sale" tone="accent" symbol="▲" /> : null}
      </Row>
      <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.lg }}>
        <Card style={{ flex: 1, gap: space.md, padding: space.xl }}>
          <T v="caption" muted>{payments.length ? 'Left to pay' : 'To pay'}</T>
          <Money pence={formatGBP(Math.max(remaining, 0))} size={72} />
          <T muted>{formatGBP(totals.total)} total · {totals.items} item{totals.items === 1 ? '' : 's'} · VAT {formatGBP(totals.vat)}</T>
          {payments.length ? (
            <View style={{ gap: 6, marginTop: space.sm }}>
              <T v="label">Paid so far</T>
              {payments.map((p) => (
                <Row key={p.id} style={{ justifyContent: 'space-between' }}>
                  <T>{p.method === 'card' ? `✓ Card ${p.cardBrand ?? ''} •••• ${p.cardLast4 ?? ''}` : '✓ Cash'}</T>
                  <Money pence={formatGBP(p.amountPence)} />
                </Row>
              ))}
            </View>
          ) : null}
          {error ? <Banner tone="danger" text={error} /> : null}
          {totals.total === 0 ? <Button label="Complete sale (nothing to pay)" size="xl" onPress={() => finish([])} disabled={busy} /> : null}
        </Card>

        <Card style={{ flex: 1.3, gap: space.lg, padding: space.xl }}>
          <Segmented label="Payment method" value={method} onChange={(m) => { setMethod(m); setTyped(''); }}
            options={[{ value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' }]} />
          {cardBusy ? <PresentCard amount={typedPence > 0 ? Math.min(typedPence, remaining) : remaining} onCancel={() => abort.current?.abort()} /> : method === 'cash' ? (
            <View style={{ gap: space.md }}>
              <T v="label">Cash tendered</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {quick.map((v, i) => (
                  <Button key={v} testID={`cash-${v}`} kind={i === 0 ? 'primary' : 'secondary'} size="xl" label={i === 0 ? `Exact ${formatGBP(v)}` : formatGBP(v)}
                    onPress={() => takeCash(v)} disabled={busy} style={{ flexBasis: '47%', flexGrow: 1 }} />
                ))}
              </View>
              <Row gap={space.lg} wrap style={{ alignItems: 'flex-start' }}>
                <View style={{ flex: 1, minWidth: 200, gap: space.sm }}>
                  <T muted>Other amount</T>
                  <Money pence={formatGBP(typedPence)} size={40} />
                  {typedPence > 0 ? (
                    <T v="label" tone={typedPence >= remaining ? color.success : color.warning}>
                      {typedPence >= remaining ? `Change ${formatGBP(typedPence - remaining)}` : `Part payment — ${formatGBP(remaining - typedPence)} still to pay`}
                    </T>
                  ) : null}
                  <Button label={typedPence >= remaining ? 'Take cash' : 'Take part payment'} size="lg" disabled={typedPence <= 0 || busy} onPress={() => takeCash(typedPence)} />
                </View>
                <Keypad size={64} testIDPrefix="cash" keys={['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫']} onKey={(k) => setTyped((t) => applyAmountKey(t, k, 7))} />
              </Row>
            </View>
          ) : (
            <View style={{ gap: space.md }}>
              <T muted>Card terminal: {terminal.name === 'mock' ? 'demo terminal (simulated)' : terminal.name}</T>
              <Row gap={space.lg} wrap style={{ alignItems: 'flex-start' }}>
                <View style={{ flex: 1, minWidth: 200, gap: space.sm }}>
                  <T muted>Amount on card</T>
                  <Money pence={formatGBP(typedPence > 0 ? Math.min(typedPence, remaining) : remaining)} size={40} />
                  <T v="small" muted>Type a smaller amount to split the payment.</T>
                  <Button testID="card-charge" label="Charge card" size="xl" onPress={takeCard} disabled={busy || remaining <= 0} />
                </View>
                <Keypad size={64} testIDPrefix="card" keys={['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫']} onKey={(k) => setTyped((t) => applyAmountKey(t, k, 7))} />
              </Row>
            </View>
          )}
        </Card>
      </View>
    </ScrollView>
  );
}

function PresentCard({ amount, onCancel }: { amount: number; onCancel: () => void }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce) return;
      loop = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: false }),
      ]));
      loop.start();
    });
    return () => loop?.stop();
  }, []);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  return (
    <View accessibilityLiveRegion="polite" style={{ alignItems: 'center', gap: space.lg, paddingVertical: space.xl }}>
      <Animated.View style={{ transform: [{ scale }], width: 180, height: 116, borderRadius: radius.lg, backgroundColor: color.primary, padding: space.lg, justifyContent: 'space-between' }}>
        <View style={{ width: 36, height: 26, borderRadius: 6, backgroundColor: color.accent }} />
        <Text style={{ color: '#fff', fontSize: 16, letterSpacing: 2, fontFamily: font.family }}>•••• •••• ••••</Text>
      </Animated.View>
      <T v="title">Present card…</T>
      <Row><ActivityIndicator color={color.primary} /><T muted>Waiting for the terminal · {formatGBP(amount)}</T></Row>
      <Button kind="secondary" label="Cancel card payment" onPress={onCancel} />
    </View>
  );
}
