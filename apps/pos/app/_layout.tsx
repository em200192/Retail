import { router, Slot, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { dirStyle, t, useLang } from '../src/i18n';
import { boot, getState, lock, runtime, startBackgroundSync, useApp } from '../src/state/store';
import { Toast, TopBar, TrainingBanner } from '../src/ui/chrome';
import { color, WEB_CSS } from '../src/ui/theme';

const LOCK_AFTER_MS = 3 * 60_000;
const PUBLIC = new Set(['/pair', '/login']);

if (Platform.OS === 'web' && typeof document !== 'undefined' && !document.getElementById('counter-css')) {
  const el = document.createElement('style');
  el.id = 'counter-css';
  el.textContent = WEB_CSS;
  document.head.appendChild(el);
  document.title = t('app.title');
}

export default function RootLayout() {
  const booted = useApp((s) => s.booted);
  const paired = useApp((s) => !!s.pairing);
  const authed = useApp((s) => !!s.session && !s.locked);
  const path = usePathname();
  const lastActivity = useRef(Date.now());
  // The whole app re-renders when the language changes; the direction is set here (no restart).
  const lang = useLang();

  useEffect(() => {
    void boot().then(startBackgroundSync);
  }, []);

  // Route guard: pair -> PIN -> till.
  useEffect(() => {
    if (!booted) return;
    if (!paired) { if (path !== '/pair') router.replace('/pair'); return; }
    if (!authed) { if (path !== '/login') router.replace('/login'); return; }
    if (PUBLIC.has(path) || path === '/') router.replace(getState().tillSession ? '/sell' : '/open-till');
  }, [booted, paired, authed, path]);

  // Lock the till after inactivity (but never in the middle of taking a card).
  useEffect(() => {
    const bump = () => { lastActivity.current = Date.now(); };
    const w = Platform.OS === 'web' ? window : null;
    w?.addEventListener('keydown', bump);
    w?.addEventListener('pointerdown', bump);
    const t = setInterval(() => {
      const s = getState();
      if (s.session && !s.locked && Date.now() - lastActivity.current > LOCK_AFTER_MS && !runtime.cardInProgress) lock();
    }, 10_000);
    return () => {
      clearInterval(t);
      w?.removeEventListener('keydown', bump);
      w?.removeEventListener('pointerdown', bump);
    };
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <View style={[{ flex: 1, backgroundColor: color.surface }, dirStyle(lang)]} onTouchStart={() => { lastActivity.current = Date.now(); }}>
        {booted ? (
          <>
            <TopBar />
            <TrainingBanner />
            <View style={{ flex: 1 }}><Slot /></View>
            <Toast />
          </>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={color.primary} size="large" accessibilityLabel={t('app.starting')} />
          </View>
        )}
      </View>
    </SafeAreaProvider>
  );
}
