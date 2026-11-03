import { router, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lock, useApp } from '../state/store';
import { Row, T } from './components';
import { color, font, radius, space } from './theme';

/** Persistent connection + queue indicator: text and symbol, not colour alone. */
export function StatusPill({ compact }: { compact?: boolean }) {
  const online = useApp((s) => s.online);
  const pending = useApp((s) => s.queue.pending);
  const rejected = useApp((s) => s.queue.rejected);
  const syncError = useApp((s) => s.syncError);
  let label: string, symbol: string, bg: string, fg: string, border: string;
  if (!online) {
    label = pending ? `Offline · ${pending} waiting` : 'Offline'; symbol = '○'; bg = '#FFF4D1'; fg = '#6B4A00'; border = '#F2D27A';
  } else if (rejected) {
    label = `${rejected} sync issue${rejected === 1 ? '' : 's'}`; symbol = '!'; bg = color.dangerTint; fg = color.danger; border = '#EDB9B9';
  } else if (pending) {
    label = `Online · ${pending} sending`; symbol = '↑'; bg = color.primaryTint; fg = color.primary; border = '#B9DAD7';
  } else {
    label = syncError ? 'Online · sync paused' : 'Online'; symbol = '●'; bg = color.successTint; fg = color.success; border = '#B7D9C8';
  }
  return (
    <Pressable testID="status-pill" accessibilityRole="button" accessibilityLabel={`Connection: ${label}. Open sync status`}
      onPress={() => router.push('/sync')} style={[styles.pill, { backgroundColor: bg, borderColor: border }]}>
      <Text style={{ color: fg, fontWeight: '800', fontSize: 13, fontFamily: font.family }}>{symbol}</Text>
      <Text style={{ color: fg, fontWeight: '700', fontSize: 14, fontFamily: font.family }}>
        {compact ? (rejected && online ? `${rejected} issue${rejected === 1 ? '' : 's'}` : `${online ? 'Online' : 'Offline'}${pending ? ` · ${pending}` : ''}`) : label}
      </Text>
    </Pressable>
  );
}

export function Logo({ size = 30, mark }: { size?: number; mark?: boolean }) {
  return (
    <Row gap={10}>
      <View style={[styles.logo, { width: size, height: size, borderRadius: size * 0.3 }]}>
        <View style={{ width: size * 0.5, height: size * 0.14, borderRadius: 3, backgroundColor: color.accent, marginBottom: size * 0.08 }} />
        <View style={{ width: size * 0.5, height: size * 0.14, borderRadius: 3, backgroundColor: '#fff' }} />
      </View>
      {mark ? null : <Text style={{ fontSize: size * 0.68, fontWeight: '800', color: color.ink, letterSpacing: -0.4, fontFamily: font.family }}>Counter</Text>}
    </Row>
  );
}

export function TopBar() {
  const insets = useSafeAreaInsets();
  const session = useApp((s) => s.session);
  const locked = useApp((s) => s.locked);
  const shop = useApp((s) => s.catalog.tenant?.trading_name ?? s.hello?.tenant.trading_name ?? null);
  const branch = useApp((s) => s.catalog.branch?.name ?? s.hello?.branch.name ?? null);
  const till = useApp((s) => s.hello?.till?.name ?? null);
  const path = usePathname();
  const paired = useApp((s) => !!s.pairing);
  const showNav = !!session && !locked;
  const { width } = useWindowDimensions();
  const compact = width < 700;
  return (
    <View style={[styles.bar, { paddingTop: insets.top + space.sm }, compact && { paddingHorizontal: space.md, gap: space.sm }]}>
      <Row gap={space.lg} style={{ flex: 1, minWidth: 0 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Counter – go to the till" onPress={() => showNav && router.replace('/sell')}>
          <Logo mark={compact && showNav} />
        </Pressable>
        {shop && !compact ? (
          <View style={{ flexShrink: 1 }}>
            <T v="label" numberOfLines={1}>{shop}</T>
            <T v="small" muted numberOfLines={1}>{[branch, till].filter(Boolean).join(' · ')}</T>
          </View>
        ) : null}
      </Row>
      <Row gap={space.sm}>
        {paired ? <StatusPill compact={compact} /> : null}
        {showNav ? (
          <>
            <View style={styles.staff} accessibilityLabel={`Logged in as ${session.staff.display_name}`}>
              <View style={styles.avatar}><Text style={styles.avatarText}>{session.staff.display_name.slice(0, 1)}</Text></View>
              {compact ? null : <T v="label" style={{ maxWidth: 140 }} numberOfLines={1}>{session.staff.display_name}</T>}
            </View>
            {path !== '/menu' ? <BarButton label="Menu" icon="☰" onPress={() => router.push('/menu')} testID="open-menu" iconOnly={compact} /> : null}
            <BarButton label="Lock" icon="⏻" onPress={lock} testID="lock" iconOnly={compact} />
          </>
        ) : null}
      </Row>
    </View>
  );
}

function BarButton({ label, icon, onPress, testID, iconOnly }: { label: string; icon: string; onPress: () => void; testID?: string; iconOnly?: boolean }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.barBtn, iconOnly && { paddingHorizontal: 0, width: 48, justifyContent: 'center' }, pressed && { backgroundColor: color.primaryTint }]}>
      <Text style={{ fontSize: 16, color: color.ink, fontFamily: font.family }} aria-hidden>{icon}</Text>
      {iconOnly ? null : <Text style={{ fontSize: 15, fontWeight: '700', color: color.ink, fontFamily: font.family }}>{label}</Text>}
    </Pressable>
  );
}

export function TrainingBanner() {
  const training = useApp((s) => s.training && !!s.session && !s.locked);
  if (!training) return null;
  return (
    <View accessibilityRole="alert" style={styles.training} testID="training-banner">
      <Text style={styles.trainingText}>▲ TRAINING MODE – not a real sale</Text>
    </View>
  );
}

export function Toast() {
  const t = useApp((s) => s.toast);
  if (!t) return null;
  const bg = t.tone === 'success' ? color.success : t.tone === 'danger' ? color.danger : color.ink;
  return (
    <View pointerEvents="none" style={styles.toastWrap}>
      <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={[styles.toast, { backgroundColor: bg }]}>
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15, fontFamily: font.family }}>
          {t.tone === 'success' ? '✓ ' : t.tone === 'danger' ? '! ' : ''}{t.text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingHorizontal: space.xl, paddingBottom: space.sm,
    backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.border, minHeight: 64,
  },
  logo: { backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1 },
  staff: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: color.primaryTint, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: color.primary, fontWeight: '800', fontSize: 15, fontFamily: font.family },
  barBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, paddingHorizontal: 14, borderRadius: radius.md, borderWidth: 1, borderColor: color.border },
  training: { backgroundColor: color.accent, paddingVertical: 8, alignItems: 'center' },
  trainingText: { color: color.accentInk, fontWeight: '800', fontSize: 15, letterSpacing: 0.5, fontFamily: font.family },
  toastWrap: { position: 'absolute', left: 0, right: 0, bottom: 28, alignItems: 'center' },
  toast: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.pill, maxWidth: 560 },
});
