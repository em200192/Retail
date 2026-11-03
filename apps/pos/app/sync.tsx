import { formatGBP } from '@retail/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { fmtDateTime, t, tn, useLang } from '../src/i18n';
import { can } from '../src/logic/permissions';
import type { QueueItem } from '../src/logic/queue';
import { queue, syncNow, toast, useApp } from '../src/state/store';
import { Badge, Banner, Button, Card, Row, T } from '../src/ui/components';
import { color, space } from '../src/ui/theme';

/** Queue labels are stored in English ("MAN1-1-7 (voided)", "of MAN1-1-7"); show them in the till language. */
function itemTitle(i: QueueItem): string {
  if (i.kind === 'sale') {
    const v = /^(.*) \(voided\)$/.exec(i.label);
    return v ? t('sync.saleVoided', { receipt: v[1]! }) : t('sync.sale', { label: i.label });
  }
  const of = /^of (.*)$/.exec(i.label);
  return of ? t('sync.refundOf', { receipt: of[1]! }) : t('sync.refund', { label: i.label });
}

export default function SyncStatus() {
  useLang();
  const online = useApp((s) => s.online);
  const counts = useApp((s) => s.queue);
  const lastSyncAt = useApp((s) => s.lastSyncAt);
  const lastPull = useApp((s) => s.catalog.serverTime);
  const products = useApp((s) => Object.keys(s.catalog.products).length);
  const syncError = useApp((s) => s.syncError);
  const staff = useApp((s) => s.session?.staff ?? null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = () => { void queue.items().then(setItems); };
    load();
    return queue.onChange(load);
  }, []);

  const rejected = items.filter((i) => i.status === 'rejected');
  const pending = items.filter((i) => i.status === 'pending');
  const manager = can(staff, 'pos.approve');

  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 1000, width: '100%', alignSelf: 'center' }}>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View>
          <T v="caption" muted>{t('sync.caption')}</T>
          <T v="title" accessibilityRole="header">{t('sync.title')}</T>
        </View>
        <Row>
          <Button testID="sync-now" label={busy ? t('sync.syncing') : t('sync.now')} disabled={busy}
            onPress={async () => { setBusy(true); await syncNow(); setBusy(false); toast(t('sync.finished')); }} />
          <Button kind="secondary" label={t('common.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/sell'))} />
        </Row>
      </Row>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        <Stat label={t('sync.connection')} value={online ? t('status.online') : t('status.offline')} badge={<Badge label={online ? t('sync.connected') : t('sync.noConnection')} tone={online ? 'success' : 'accent'} symbol={online ? '●' : '○'} />} />
        <Stat label={t('sync.waitingToSend')} value={String(counts.pending)} badge={<Badge label={counts.pending ? t('sync.willSend') : t('sync.allSent')} tone={counts.pending ? 'primary' : 'success'} symbol={counts.pending ? '↑' : '✓'} />} />
        <Stat label={t('sync.issues')} value={String(counts.rejected)} badge={<Badge label={counts.rejected ? t('sync.needsManager') : t('sync.none')} tone={counts.rejected ? 'danger' : 'success'} symbol={counts.rejected ? '!' : '✓'} />} />
      </View>
      <Card style={{ gap: 4 }}>
        <T muted>{t('sync.lastSync', { when: lastSyncAt ? fmtDateTime(lastSyncAt) : t('sync.notYet') })}</T>
        <T muted>{t('sync.catalogue', { count: products, when: lastPull ? fmtDateTime(lastPull) : t('sync.never') })}</T>
        {syncError ? <T tone={color.danger}>{t('sync.lastError', { error: syncError })}</T> : null}
      </Card>
      {!online ? <Banner tone="accent" text={t('sync.keepSelling')} /> : null}

      <T v="h2">{t('sync.issues')}</T>
      {rejected.length === 0 ? <T muted>{t('sync.noIssues')}</T> : null}
      {rejected.map((i) => (
        <Card key={i.id} style={{ gap: space.sm, borderColor: '#EDB9B9' }}>
          <Row style={{ justifyContent: 'space-between' }} wrap>
            <Row><Badge label={t('sync.rejected')} tone="danger" symbol="!" /><T v="label">{itemTitle(i)}</T></Row>
            <T v="small" muted>{fmtDateTime(i.createdAt)} · {formatGBP(Number((i.payload as { total_pence?: number }).total_pence ?? 0))}</T>
          </Row>
          <T tone={color.danger}>{i.message}</T>
          {Array.isArray(i.details) ? (i.details as { path?: string; message?: string }[]).slice(0, 4).map((d, n) => (
            <T key={n} v="small" muted>• {d.path ? `${d.path}: ` : ''}{d.message}</T>
          )) : null}
          {i.error ? <T v="small" muted>{t('sync.code', { code: i.error })}</T> : null}
          <Row>
            <Button kind="secondary" label={t('sync.retry')} onPress={() => void queue.retry(i.id).then(syncNow)} />
            {manager ? <Button kind="danger" label={t('sync.discard')} onPress={() => void queue.discard(i.id)} hint={t('sync.discardHint')} /> : null}
          </Row>
        </Card>
      ))}

      <T v="h2">{t('sync.waitingToSend')}</T>
      {pending.length === 0 ? <T muted>{t('sync.queueEmpty')}</T> : null}
      {pending.map((i) => (
        <Card key={i.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <T v="label">{itemTitle(i)}</T>
          <T v="small" muted>{fmtDateTime(i.createdAt)}{i.attempts ? ` · ${tn('sync.attempts', i.attempts)}` : ''}</T>
        </Card>
      ))}
    </ScrollView>
  );
}

function Stat({ label, value, badge }: { label: string; value: string; badge: React.ReactNode }) {
  return (
    <Card style={{ flexGrow: 1, width: 220, gap: 6 }}>
      <T v="caption" muted>{label}</T>
      <T v="title">{value}</T>
      {badge}
    </Card>
  );
}
