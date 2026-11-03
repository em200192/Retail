import { formatGBP } from '@retail/shared';
import { router } from 'expo-router';
import { Platform, ScrollView, View } from 'react-native';
import { LANGUAGES, t, useLang, useReceiptLang } from '../src/i18n';
import { useApp } from '../src/state/store';
import { Badge, Button, Card, Money, T } from '../src/ui/components';
import { ReceiptPaper } from '../src/ui/receiptView';
import { color, radius, space } from '../src/ui/theme';

export default function ReceiptScreen() {
  useLang();
  const paperLang = useReceiptLang();
  const receipt = useApp((s) => s.lastReceipt);
  const synced = useApp((s) => s.queue.pending === 0 && s.queue.rejected === 0);
  const online = useApp((s) => s.online);
  if (!receipt) {
    return <View style={{ padding: space.xl }}><T>{t('receipt.none')}</T><Button label={t('receipt.backToTill')} onPress={() => router.replace('/sell')} /></View>;
  }
  const change = receipt.sale.payments.reduce((a, p) => a + (p.change_pence ?? 0), 0);
  const card = receipt.sale.payments.find((p) => p.method === 'card');
  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.xl, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }}>
      <View style={{ flex: 1, minWidth: 320, maxWidth: 560, gap: space.lg }}>
        <Card style={{ padding: space.xl, gap: space.md, borderRadius: radius.lg, backgroundColor: change > 0 ? '#FFF8E1' : color.successTint, borderColor: change > 0 ? '#F2D27A' : '#B7D9C8' }}>
          {change > 0 ? (
            <>
              <T v="caption" tone="#6B4A00">{t('receipt.giveChange')}</T>
              <Money pence={formatGBP(change)} size={96} />
              <T v="h3">{t('receipt.changeDue')}</T>
            </>
          ) : (
            <>
              <T v="caption" tone={color.success}>{t('receipt.complete')}</T>
              <T v="display" tone={color.success}>{t('receipt.paid', { amount: formatGBP(receipt.sale.total_pence) })}</T>
              {card ? <T>{t('receipt.cardApproved', { card: `•••• ${card.card_last4 ?? ''}` })}</T> : null}
            </>
          )}
        </Card>
        <Card style={{ gap: space.sm }}>
          <T v="label">{t('receipt.number', { number: receipt.sale.receipt_number })}</T>
          <Badge tone={synced ? 'success' : online ? 'primary' : 'accent'} symbol={synced ? '✓' : '↑'}
            label={synced ? t('receipt.saved') : online ? t('receipt.sending') : t('receipt.savedLocal')} />
          <T v="small" muted>{t('receipt.paperLanguage', { language: LANGUAGES[paperLang].nativeName })}</T>
        </Card>
        <Button testID="new-sale" label={t('receipt.newSale')} size="xl" onPress={() => router.replace('/sell')} />
        {Platform.OS === 'web' ? <Button kind="secondary" label={t('receipt.print')} icon="⎙" onPress={() => window.print()} /> : null}
      </View>
      <ReceiptPaper receipt={receipt} />
    </ScrollView>
  );
}
