import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { errorMessage } from '../src/api';
import { getState, login, logout, refreshHello, staffTiles, useApp } from '../src/state/store';
import { Banner, Button, Card, Keypad, Row, T } from '../src/ui/components';
import { color, font, radius, shadow, space } from '../src/ui/theme';

const ROLE: Record<string, string> = { owner: 'Owner', manager: 'Manager', supervisor: 'Supervisor', cashier: 'Cashier', stock: 'Stock' };

export default function Login() {
  const locked = useApp((s) => s.locked);
  const lockedStaff = useApp((s) => (s.locked ? s.session?.staff ?? null : null));
  const hello = useApp((s) => s.hello);
  const catalogStaff = useApp((s) => s.catalog.staff);
  const online = useApp((s) => s.online);
  const basketItems = useApp((s) => s.basket.lines.filter((l) => !l.voidedBy).length);
  const tiles = hello || catalogStaff ? staffTiles() : [];
  const [staffId, setStaffId] = useState<string | null>(lockedStaff?.id ?? null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refreshHello().catch(() => {}); }, []);
  useEffect(() => { if (lockedStaff) setStaffId(lockedStaff.id); }, [lockedStaff?.id]);

  const submit = async (value = pin) => {
    if (!staffId || value.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(staffId, value);
    } catch (e) {
      setError(errorMessage(e));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const onKey = (k: string) => {
    setError(null);
    if (k === 'C') return setPin('');
    if (k === '⌫') return setPin((p) => p.slice(0, -1));
    setPin((p) => (p.length >= 8 ? p : p + k));
  };

  // Physical keyboard on the web till.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (/^\d$/.test(e.key)) onKey(e.key);
      else if (e.key === 'Backspace') onKey('⌫');
      else if (e.key === 'Enter') void submit();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const chosen = tiles.find((t) => t.id === staffId);

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, padding: space.xl, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: '100%', maxWidth: 1100, flexDirection: 'row', flexWrap: 'wrap', gap: space.xl }}>
        <View style={{ flex: 3, minWidth: 320, gap: space.lg }}>
          <View>
            <T v="caption" muted>{locked ? 'Till locked' : 'Staff login'}</T>
            <T v="title" accessibilityRole="header">{locked ? 'Enter your PIN to carry on' : 'Who’s on the till?'}</T>
          </View>
          {locked && basketItems > 0 ? <Banner tone="primary" symbol="i" text={`The basket is kept (${basketItems} item${basketItems === 1 ? '' : 's'}).`} /> : null}
          {!online ? <Banner tone="warning" text="Offline — only staff who have logged in on this till before can unlock it." /> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            {tiles.map((t) => {
              const on = t.id === staffId;
              return (
                <Pressable key={t.id} testID={`staff-${t.display_name}`} accessibilityRole="radio" accessibilityState={{ checked: on }}
                  accessibilityLabel={`${t.display_name}, ${ROLE[t.role_key ?? ''] ?? 'Staff'}`}
                  onPress={() => { setStaffId(t.id); setPin(''); setError(null); }}
                  style={({ pressed }) => [{
                    width: 150, padding: space.lg, borderRadius: radius.md, backgroundColor: on ? color.primary : color.card,
                    borderWidth: 2, borderColor: on ? color.primary : color.border, gap: space.sm, alignItems: 'center',
                  }, shadow, pressed && { transform: [{ scale: 0.98 }] }]}>
                  <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? 'rgba(255,255,255,0.18)' : color.primaryTint }}>
                    <Text style={{ fontSize: 24, fontWeight: '800', color: on ? '#fff' : color.primary, fontFamily: font.family }}>{t.display_name.slice(0, 1)}</Text>
                  </View>
                  <Text style={{ fontSize: 17, fontWeight: '700', color: on ? '#fff' : color.ink, fontFamily: font.family }} numberOfLines={1}>{t.display_name}</Text>
                  <Text style={{ fontSize: 13, color: on ? '#E6F2F1' : color.muted, fontFamily: font.family }}>{on ? '✓ ' : ''}{ROLE[t.role_key ?? ''] ?? 'Staff'}</Text>
                </Pressable>
              );
            })}
            {tiles.length === 0 ? <T muted>No staff with a till PIN yet. Set PINs in the back office (Staff → PIN).</T> : null}
          </View>
          {locked ? <Button kind="ghost" label="Switch user / log out" onPress={() => { logout(); setStaffId(null); }} style={{ alignSelf: 'flex-start' }} /> : null}
        </View>
        <Card style={{ flex: 2, minWidth: 300, alignItems: 'center', gap: space.lg, padding: space.xl }}>
          <T v="h3">{chosen ? `PIN for ${chosen.display_name}` : 'Choose your name first'}</T>
          <Row gap={14} style={{ minHeight: 24 }}>
            {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
              <View key={i} style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: color.primary, backgroundColor: i < pin.length ? color.primary : 'transparent' }} />
            ))}
          </Row>
          <Text accessibilityLiveRegion="polite" style={{ position: 'absolute', opacity: 0 }}>{pin.length} digits entered</Text>
          {error ? <Banner tone="danger" text={error} /> : null}
          <Keypad onKey={onKey} size={76} testIDPrefix="pin" />
          <Button testID="pin-enter" label={busy ? 'Checking…' : 'Enter'} size="lg" disabled={!staffId || pin.length < 4 || busy}
            onPress={() => submit()} style={{ width: 76 * 3 + space.sm * 2 }} />
        </Card>
      </View>
      <T v="small" muted style={{ marginTop: space.xl }}>{getState().hello?.device.name ?? ''}</T>
    </ScrollView>
  );
}
