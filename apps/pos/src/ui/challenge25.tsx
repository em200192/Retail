import type { AgeCheckRecord } from '@retail/shared';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { type MessageKey, t, textDir, useLang } from '../i18n';
import { Sheet, T } from './components';
import { color, font, radius, space } from './theme';

type Outcome = AgeCheckRecord['outcome'];

const OPTIONS: { outcome: Outcome; label: MessageKey; sub: MessageKey; symbol: string; tone: 'ok' | 'stop' }[] = [
  { outcome: 'looked_over_25', label: 'c25.lookedOver25', sub: 'c25.lookedOver25Sub', symbol: '✓', tone: 'ok' },
  { outcome: 'id_checked_ok', label: 'c25.idOk', sub: 'c25.idOkSub', symbol: '✓', tone: 'ok' },
  { outcome: 'refused', label: 'c25.refused', sub: 'c25.refusedSub', symbol: '✕', tone: 'stop' },
  { outcome: 'id_not_available', label: 'c25.noId', sub: 'c25.noIdSub', symbol: '✕', tone: 'stop' },
];

/** Challenge 25: shown whenever an item with a minimum age goes into the basket. */
export function Challenge25Sheet({ item, onResult, onCancel }: {
  item: { name: string; minAge: number } | null; onResult: (o: Outcome) => void; onCancel: () => void;
}) {
  useLang();
  const narrow = useWindowDimensions().width < 600;
  if (!item) return null;
  const explain = t('c25.explain');
  return (
    <Sheet visible title={t('c25.title')} onClose={onCancel} width={720} testID="challenge25">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg, backgroundColor: '#FFF4D1', borderRadius: radius.md, padding: space.lg, borderWidth: 1, borderColor: '#F2D27A' }}>
        <View style={{ width: narrow ? 48 : 64, height: narrow ? 48 : 64, borderRadius: 32, backgroundColor: color.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 22, fontWeight: '900', color: color.accentInk, fontFamily: font.family, writingDirection: 'ltr' }}>{item.minAge}+</Text>
        </View>
        <View style={{ flex: 1 }}>
          <T v="h2">{t('c25.question')}</T>
          <T muted>{t('c25.body', { name: item.name, age: item.minAge })}</T>
          {explain ? <T v="small" muted style={{ marginTop: 4 }}>{explain}</T> : null}
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        {OPTIONS.map((o) => (
          <Pressable key={o.outcome} testID={`c25-${o.outcome}`} accessibilityRole="button" accessibilityLabel={`${t(o.label)}. ${t(o.sub)}`}
            onPress={() => onResult(o.outcome)}
            style={({ pressed }) => [{
              flexBasis: narrow ? '100%' : '47%', flexGrow: 1, minHeight: narrow ? 64 : 88, borderRadius: radius.md, padding: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.md,
              backgroundColor: o.tone === 'ok' ? (pressed ? '#11603C' : color.success) : (pressed ? color.dangerTint : color.card),
              borderWidth: 2, borderColor: o.tone === 'ok' ? color.success : color.danger,
            }]}>
            <Text style={{ fontSize: 26, fontWeight: '900', color: o.tone === 'ok' ? '#fff' : color.danger, fontFamily: font.family }}>{o.symbol}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[{ fontSize: narrow ? 17 : 19, fontWeight: '800', color: o.tone === 'ok' ? '#fff' : color.danger, fontFamily: font.family }, textDir()]}>{t(o.label)}</Text>
              <Text style={[{ fontSize: 14, color: o.tone === 'ok' ? '#E8F3EE' : color.muted, fontFamily: font.family }, textDir()]}>{t(o.sub)}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      <T v="small" muted>{t('c25.logged')}</T>
    </Sheet>
  );
}
