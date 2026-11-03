import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { errorMessage } from '../src/api';
import { LTR_TEXT, t, useLang } from '../src/i18n';
import { pairDevice } from '../src/state/store';
import { Logo } from '../src/ui/chrome';
import { Banner, Button, Card, Field, Row, T } from '../src/ui/components';
import { LanguageSwitch } from '../src/ui/language';
import { color, radius, space } from '../src/ui/theme';

export default function Pair() {
  useLang();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await pairDevice(code);
      router.replace('/login');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
      <View style={{ width: '100%', maxWidth: 980, flexDirection: 'row', flexWrap: 'wrap', gap: space.xl, alignItems: 'stretch' }}>
        <View style={{ flex: 1, minWidth: 300, justifyContent: 'center', gap: space.lg, padding: space.md }}>
          <Row style={{ justifyContent: 'space-between' }} wrap gap={space.md}>
            <Logo size={44} />
            <LanguageSwitch />
          </Row>
          <T v="display" style={{ maxWidth: 420 }}>{t('pair.title')}</T>
          <T v="body" muted style={{ maxWidth: 440, fontSize: 18, lineHeight: 28 }}>{t('pair.intro')}</T>
          <View style={{ gap: space.md, marginTop: space.sm }}>
            {[t('pair.step1'), t('pair.step2'), t('pair.step3')].map((s, i) => (
              <Row key={s} gap={space.md}>
                <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: color.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
                  <T v="label" tone={color.primary}>{i + 1}</T>
                </View>
                <T v="body" style={{ flex: 1 }}>{s}</T>
              </Row>
            ))}
          </View>
        </View>
        <Card style={{ flex: 1, minWidth: 320, padding: space.xl, gap: space.lg, borderRadius: radius.lg }}>
          <T v="h2" accessibilityRole="header">{t('pair.heading')}</T>
          <Field
            testID="pairing-code"
            label={t('pair.field')}
            value={code}
            onChangeText={setCode}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="eyJhcGkiOiJodHRwczovL…"
            inputStyle={[{ minHeight: 140, paddingTop: 12, fontFamily: 'monospace', fontSize: 14, textAlignVertical: 'top', textAlign: 'left', direction: 'ltr' }, LTR_TEXT]}
            error={error}
          />
          <Button testID="pair-submit" label={busy ? t('pair.checking') : t('pair.submit')} size="lg" onPress={submit} disabled={busy || !code.trim()} />
          <Banner tone="primary" symbol="i" text={t('pair.secretNote')} />
        </Card>
      </View>
    </ScrollView>
  );
}
