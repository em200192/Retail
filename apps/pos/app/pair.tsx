import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { errorMessage } from '../src/api';
import { pairDevice } from '../src/state/store';
import { Logo } from '../src/ui/chrome';
import { Banner, Button, Card, Field, Row, T } from '../src/ui/components';
import { color, radius, space } from '../src/ui/theme';

export default function Pair() {
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
          <Logo size={44} />
          <T v="display" style={{ maxWidth: 420 }}>Set up this till</T>
          <T v="body" muted style={{ maxWidth: 440, fontSize: 18, lineHeight: 27 }}>
            Pair this device with your shop once. After that it keeps selling even when the internet drops, and catches up by itself.
          </T>
          <View style={{ gap: space.md, marginTop: space.sm }}>
            {['In the back office, open Settings → Tills & devices.', 'Choose “Add till” and copy its pairing code.', 'Paste the code here and press Pair.'].map((s, i) => (
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
          <T v="h2" accessibilityRole="header">Pairing code</T>
          <Field
            testID="pairing-code"
            label="Paste the pairing code"
            value={code}
            onChangeText={setCode}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="eyJhcGkiOiJodHRwczovL…"
            inputStyle={{ minHeight: 140, paddingTop: 12, fontFamily: 'monospace', fontSize: 14, textAlignVertical: 'top' }}
            error={error}
          />
          <Button testID="pair-submit" label={busy ? 'Checking with the server…' : 'Pair this till'} size="lg" onPress={submit} disabled={busy || !code.trim()} />
          <Banner tone="primary" symbol="i" text="The code contains a device secret. It is stored in this device's secure storage and never shown again." />
        </Card>
      </View>
    </ScrollView>
  );
}
