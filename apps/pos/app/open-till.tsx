import { formatGBP, formatDateTimeUK } from '@retail/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { errorMessage } from '../src/api';
import { can } from '../src/logic/permissions';
import { openTill, useApp } from '../src/state/store';
import { applyAmountKey, Banner, Button, Card, Keypad, Money, Row, T } from '../src/ui/components';
import { color, space } from '../src/ui/theme';

export default function OpenTill() {
  const staff = useApp((s) => s.session?.staff ?? null);
  const tillName = useApp((s) => s.hello?.till?.name ?? null);
  const online = useApp((s) => s.online);
  const [typed, setTyped] = useState('15000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pence = Number(typed || '0');
  const allowed = can(staff, 'pos.open_till');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await openTill(pence);
      router.replace('/sell');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
      <Card style={{ width: '100%', maxWidth: 760, padding: space.xl, gap: space.lg }}>
        <View>
          <T v="caption" muted>Start of shift · {formatDateTimeUK(new Date())}</T>
          <T v="title" accessibilityRole="header">Open {tillName ?? 'the till'}</T>
          <T muted>Count the float in the drawer and enter it. Cash-up compares against this at the end of the day.</T>
        </View>
        {!allowed ? <Banner tone="warning" text="You can’t open the till. Ask a supervisor or manager." /> : null}
        {!tillName ? <Banner tone="danger" text="No till is linked to this device. Link one in the back office (Settings → Tills)." /> : null}
        {!online ? <Banner tone="warning" text="Offline — opening the till needs a connection. You can still sell; sales sync later without a till session." /> : null}
        {error ? <Banner tone="danger" text={error} /> : null}
        <Row gap={space.xl} wrap style={{ alignItems: 'flex-start' }}>
          <View style={{ flex: 1, minWidth: 240, gap: space.md }}>
            <T v="label" muted>Opening float</T>
            <Money pence={formatGBP(pence)} size={56} />
            <Row wrap>
              {[5000, 10000, 15000, 20000].map((v) => (
                <Button key={v} kind="secondary" label={formatGBP(v)} onPress={() => setTyped(String(v))} selected={pence === v} />
              ))}
            </Row>
          </View>
          <Keypad onKey={(k) => setTyped((t) => applyAmountKey(t, k))} keys={['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫']} size={68} testIDPrefix="float" />
        </Row>
        <Row wrap>
          <Button testID="open-till" label={busy ? 'Opening…' : `Open till with ${formatGBP(pence)}`} size="xl" disabled={!allowed || busy || !online || !tillName}
            onPress={submit} style={{ flex: 1, minWidth: 280 }} />
          <Button kind="secondary" size="xl" label="Sell without opening" onPress={() => router.replace('/sell')}
            hint="Sales are recorded without a till session" style={{ minWidth: 240 }} />
        </Row>
        <T v="small" tone={color.muted}>Tip: “Sell without opening” is for emergencies — those sales won’t appear on a till’s Z report.</T>
      </Card>
    </ScrollView>
  );
}
