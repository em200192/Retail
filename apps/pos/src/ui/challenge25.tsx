import type { AgeCheckRecord } from '@retail/shared';
import { Pressable, Text, View } from 'react-native';
import { Sheet, T } from './components';
import { color, font, radius, space } from './theme';

type Outcome = AgeCheckRecord['outcome'];

const OPTIONS: { outcome: Outcome; label: string; sub: string; symbol: string; tone: 'ok' | 'stop' }[] = [
  { outcome: 'looked_over_25', label: 'Looks over 25', sub: 'Sell', symbol: '✓', tone: 'ok' },
  { outcome: 'id_checked_ok', label: 'ID checked – OK', sub: 'Passport, driving licence or PASS card', symbol: '✓', tone: 'ok' },
  { outcome: 'refused', label: 'Refused', sub: 'Too young — remove the item', symbol: '✕', tone: 'stop' },
  { outcome: 'id_not_available', label: 'No ID', sub: 'Cannot prove age — remove the item', symbol: '✕', tone: 'stop' },
];

/** Challenge 25: shown whenever an item with a minimum age goes into the basket. */
export function Challenge25Sheet({ item, onResult, onCancel }: {
  item: { name: string; minAge: number } | null; onResult: (o: Outcome) => void; onCancel: () => void;
}) {
  if (!item) return null;
  return (
    <Sheet visible title="Challenge 25" onClose={onCancel} width={720} testID="challenge25">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg, backgroundColor: '#FFF4D1', borderRadius: radius.md, padding: space.lg, borderWidth: 1, borderColor: '#F2D27A' }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: color.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 22, fontWeight: '900', color: color.accentInk, fontFamily: font.family }}>{item.minAge}+</Text>
        </View>
        <View style={{ flex: 1 }}>
          <T v="h2">Does the customer look over 25?</T>
          <T muted>{item.name} can only be sold to people aged {item.minAge} or over. If they look under 25, ask for photo ID.</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        {OPTIONS.map((o) => (
          <Pressable key={o.outcome} testID={`c25-${o.outcome}`} accessibilityRole="button" accessibilityLabel={`${o.label}. ${o.sub}`}
            onPress={() => onResult(o.outcome)}
            style={({ pressed }) => [{
              flexBasis: '47%', flexGrow: 1, minHeight: 88, borderRadius: radius.md, padding: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.md,
              backgroundColor: o.tone === 'ok' ? (pressed ? '#11603C' : color.success) : (pressed ? color.dangerTint : color.card),
              borderWidth: 2, borderColor: o.tone === 'ok' ? color.success : color.danger,
            }]}>
            <Text style={{ fontSize: 26, fontWeight: '900', color: o.tone === 'ok' ? '#fff' : color.danger, fontFamily: font.family }}>{o.symbol}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 19, fontWeight: '800', color: o.tone === 'ok' ? '#fff' : color.danger, fontFamily: font.family }}>{o.label}</Text>
              <Text style={{ fontSize: 14, color: o.tone === 'ok' ? '#E8F3EE' : color.muted, fontFamily: font.family }}>{o.sub}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      <T v="small" muted>Every answer is logged for Challenge 25 due diligence.</T>
    </Sheet>
  );
}
