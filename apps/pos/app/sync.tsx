import { formatDateTimeUK, formatGBP } from '@retail/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { can } from '../src/logic/permissions';
import type { QueueItem } from '../src/logic/queue';
import { queue, syncNow, toast, useApp } from '../src/state/store';
import { Badge, Banner, Button, Card, Row, T } from '../src/ui/components';
import { color, space } from '../src/ui/theme';

export default function SyncStatus() {
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
          <T v="caption" muted>Offline queue</T>
          <T v="title" accessibilityRole="header">Sync status</T>
        </View>
        <Row>
          <Button testID="sync-now" label={busy ? 'Syncing…' : 'Sync now'} disabled={busy}
            onPress={async () => { setBusy(true); await syncNow(); setBusy(false); toast('Sync finished'); }} />
          <Button kind="secondary" label="← Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/sell'))} />
        </Row>
      </Row>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        <Stat label="Connection" value={online ? 'Online' : 'Offline'} badge={<Badge label={online ? 'Connected' : 'No connection'} tone={online ? 'success' : 'accent'} symbol={online ? '●' : '○'} />} />
        <Stat label="Waiting to send" value={String(counts.pending)} badge={<Badge label={counts.pending ? 'Will send automatically' : 'All sent'} tone={counts.pending ? 'primary' : 'success'} symbol={counts.pending ? '↑' : '✓'} />} />
        <Stat label="Sync issues" value={String(counts.rejected)} badge={<Badge label={counts.rejected ? 'Needs a manager' : 'None'} tone={counts.rejected ? 'danger' : 'success'} symbol={counts.rejected ? '!' : '✓'} />} />
      </View>
      <Card style={{ gap: 4 }}>
        <T muted>Last successful sync: {lastSyncAt ? formatDateTimeUK(lastSyncAt) : 'not yet'}</T>
        <T muted>Catalogue: {products} products · updated {lastPull ? formatDateTimeUK(lastPull) : 'never'}</T>
        {syncError ? <T tone={color.danger}>! Last error: {syncError}</T> : null}
      </Card>
      {!online ? <Banner tone="accent" text="Keep selling — sales are saved on this till and sent as soon as the connection is back." /> : null}

      <T v="h2">Sync issues</T>
      {rejected.length === 0 ? <T muted>Nothing was rejected by the server.</T> : null}
      {rejected.map((i) => (
        <Card key={i.id} style={{ gap: space.sm, borderColor: '#EDB9B9' }}>
          <Row style={{ justifyContent: 'space-between' }} wrap>
            <Row><Badge label="Rejected" tone="danger" symbol="!" /><T v="label">{i.kind === 'sale' ? 'Sale' : 'Refund'} {i.label}</T></Row>
            <T v="small" muted>{formatDateTimeUK(i.createdAt)} · {formatGBP(Number((i.payload as { total_pence?: number }).total_pence ?? 0))}</T>
          </Row>
          <T tone={color.danger}>{i.message}</T>
          {i.error ? <T v="small" muted>Code: {i.error}</T> : null}
          <Row>
            <Button kind="secondary" label="Retry" onPress={() => void queue.retry(i.id).then(syncNow)} />
            {manager ? <Button kind="danger" label="Discard" onPress={() => void queue.discard(i.id)} hint="Remove it from this till (managers only)" /> : null}
          </Row>
        </Card>
      ))}

      <T v="h2">Waiting to send</T>
      {pending.length === 0 ? <T muted>The queue is empty.</T> : null}
      {pending.map((i) => (
        <Card key={i.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <T v="label">{i.kind === 'sale' ? 'Sale' : 'Refund'} {i.label}</T>
          <T v="small" muted>{formatDateTimeUK(i.createdAt)}{i.attempts ? ` · ${i.attempts} attempt${i.attempts === 1 ? '' : 's'}` : ''}</T>
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
