import { formatGBP } from '@retail/shared';
import { router } from 'expo-router';
import { Platform, ScrollView, View } from 'react-native';
import { useApp } from '../src/state/store';
import { Badge, Button, Card, Money, T } from '../src/ui/components';
import { ReceiptPaper } from '../src/ui/receiptView';
import { color, radius, space } from '../src/ui/theme';

export default function ReceiptScreen() {
  const receipt = useApp((s) => s.lastReceipt);
  const synced = useApp((s) => s.queue.pending === 0 && s.queue.rejected === 0);
  const online = useApp((s) => s.online);
  if (!receipt) {
    return <View style={{ padding: space.xl }}><T>No receipt yet.</T><Button label="Back to till" onPress={() => router.replace('/sell')} /></View>;
  }
  const change = receipt.sale.payments.reduce((a, p) => a + (p.change_pence ?? 0), 0);
  const card = receipt.sale.payments.find((p) => p.method === 'card');
  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.xl, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }}>
      <View style={{ flex: 1, minWidth: 320, maxWidth: 560, gap: space.lg }}>
        <Card style={{ padding: space.xl, gap: space.md, borderRadius: radius.lg, backgroundColor: change > 0 ? '#FFF8E1' : color.successTint, borderColor: change > 0 ? '#F2D27A' : '#B7D9C8' }}>
          {change > 0 ? (
            <>
              <T v="caption" tone="#6B4A00">Give the customer their change</T>
              <Money pence={formatGBP(change)} size={96} />
              <T v="h3">Change due</T>
            </>
          ) : (
            <>
              <T v="caption" tone={color.success}>Payment complete</T>
              <T v="display" tone={color.success}>✓ Paid {formatGBP(receipt.sale.total_pence)}</T>
              {card ? <T>Card •••• {card.card_last4} approved</T> : null}
            </>
          )}
        </Card>
        <Card style={{ gap: space.sm }}>
          <T v="label">Receipt {receipt.sale.receipt_number}</T>
          <Badge tone={synced ? 'success' : online ? 'primary' : 'accent'} symbol={synced ? '✓' : '↑'}
            label={synced ? 'Saved to the server' : online ? 'Sending to the server…' : 'Saved on this till — will sync when back online'} />
        </Card>
        <Button testID="new-sale" label="New sale" size="xl" onPress={() => router.replace('/sell')} />
        {Platform.OS === 'web' ? <Button kind="secondary" label="Print receipt" icon="⎙" onPress={() => window.print()} /> : null}
      </View>
      <ReceiptPaper receipt={receipt} />
    </ScrollView>
  );
}
