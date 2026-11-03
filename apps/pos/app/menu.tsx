import { formatGBP, type Permission } from '@retail/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ApiError, errorMessage } from '../src/api';
import { isEmpty } from '../src/logic/basket';
import { can, isOwner } from '../src/logic/permissions';
import { api, lock, logout, setState, toast, unpairDevice, useApp } from '../src/state/store';
import { type ApprovalRequest, type ApprovalResult, ApprovalSheet } from '../src/ui/approval';
import { applyAmountKey, Badge, Banner, Button, Field, Keypad, Money, Row, Sheet, T } from '../src/ui/components';
import { color, font, radius, shadow, space } from '../src/ui/theme';
import { type ZReport, ZReportView } from '../src/ui/zreport';

type Movement = 'no_sale' | 'paid_out' | 'cash_drop';
interface ExpenseCategory { id: string; name: string; vat_reclaimable: boolean }

export default function Menu() {
  const staff = useApp((s) => s.session?.staff ?? null);
  const training = useApp((s) => s.training);
  const basketEmpty = useApp((s) => isEmpty(s.basket));
  const session = useApp((s) => s.tillSession);
  const online = useApp((s) => s.online);
  const [sheet, setSheet] = useState<null | 'paid_out' | 'cash_drop' | 'x_read' | 'unpair'>(null);
  const [approval, setApproval] = useState<{ request: ApprovalRequest; retry: (r: ApprovalResult) => void } | null>(null);

  const needSession = !session ? 'Open the till first' : !online ? 'Needs a connection' : null;

  /** Cash movements are online calls; the server checks limits and (if needed) the manager PIN itself. */
  const move = async (type: Movement, body: Record<string, unknown> = {}, approvalBody?: ApprovalResult) => {
    try {
      await api('POST', `/v1/till-sessions/${session!.id}/cash-movements`, {
        movement_type: type, ...body,
        ...(approvalBody ? { approval: { approver_staff_id: approvalBody.approverId, approver_pin: approvalBody.pin } } : {}),
      });
      toast(type === 'no_sale' ? 'Drawer opened (no sale recorded)' : type === 'paid_out' ? 'Paid out recorded' : 'Cash drop recorded', 'success');
      setSheet(null);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.needsApproval && !approvalBody) {
        const perm = (type === 'no_sale' ? 'pos.no_sale' : 'pos.paid_out') as Permission;
        setApproval({
          request: { action: perm, mode: 'collect', title: 'Manager approval', description: e.message },
          retry: (r) => { setApproval(null); void move(type, body, r); },
        });
        return false;
      }
      toast(errorMessage(e), 'danger');
      return false;
    }
  };

  const items: { key: string; title: string; sub: string; icon: string; perm?: Permission; onPress: () => void; disabled?: string | null; tone?: 'accent' }[] = [
    { key: 'refund', title: 'Refund', sub: 'Find a receipt and refund items', icon: '↺', perm: 'pos.refund', onPress: () => router.push('/refund') },
    { key: 'no_sale', title: 'No sale', sub: 'Open the drawer (logged)', icon: '⊡', perm: 'pos.no_sale', onPress: () => void move('no_sale'), disabled: needSession },
    { key: 'paid_out', title: 'Paid out', sub: 'Pay a cost from the till', icon: '£', perm: 'pos.paid_out', onPress: () => setSheet('paid_out'), disabled: needSession },
    { key: 'cash_drop', title: 'Cash drop', sub: 'Move notes to the safe', icon: '⇣', perm: 'pos.close_till', onPress: () => setSheet('cash_drop'), disabled: needSession },
    { key: 'x_read', title: 'X-read', sub: 'Takings so far, till stays open', icon: '≡', perm: 'pos.z_report', onPress: () => setSheet('x_read'), disabled: needSession },
    { key: 'cash_up', title: 'Cash up', sub: 'Count the drawer and close the till', icon: '✓', perm: 'pos.close_till', onPress: () => router.push('/cash-up'), disabled: needSession },
    { key: 'staff', title: 'Staff tools', sub: '“We need this”, stock check, clock in', icon: '☺', onPress: () => router.push('/staff') },
    { key: 'sync', title: 'Sync status', sub: 'Offline queue and sync issues', icon: '⇅', onPress: () => router.push('/sync') },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 1180, width: '100%', alignSelf: 'center' }}>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View>
          <T v="caption" muted>Till menu</T>
          <T v="title" accessibilityRole="header">What do you need, {staff?.display_name}?</T>
        </View>
        <Button kind="secondary" label="← Back to the till" onPress={() => router.replace('/sell')} />
      </Row>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        {items.map((it) => {
          const allowed = !it.perm || can(staff, it.perm);
          const disabled = !allowed ? 'Not allowed for your role' : it.disabled ?? null;
          return (
            <Pressable key={it.key} testID={`menu-${it.key}`} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }}
              accessibilityLabel={`${it.title}. ${disabled ?? it.sub}`} onPress={disabled ? undefined : it.onPress}
              style={({ pressed }) => [{
                width: 260, flexGrow: 1, minHeight: 112, padding: space.lg, borderRadius: radius.md, backgroundColor: color.card,
                borderWidth: 1, borderColor: color.border, gap: 6, opacity: disabled ? 0.5 : 1,
              }, shadow, pressed && !disabled && { backgroundColor: color.primaryTint }]}>
              <Row>
                <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: color.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 20, color: color.primary, fontWeight: '800', fontFamily: font.family }}>{it.icon}</Text>
                </View>
                <T v="h3">{it.title}</T>
              </Row>
              <T v="small" muted>{disabled ?? it.sub}</T>
            </Pressable>
          );
        })}
      </View>

      <View style={{ backgroundColor: training ? '#FFF4D1' : color.card, borderRadius: radius.md, borderWidth: 1, borderColor: training ? '#F2D27A' : color.border, padding: space.lg, gap: space.sm }}>
        <Row style={{ justifyContent: 'space-between' }} wrap>
          <View style={{ flex: 1, minWidth: 240 }}>
            <Row><T v="h3">Training mode</T><Badge label={training ? 'On' : 'Off'} tone={training ? 'accent' : 'neutral'} symbol={training ? '▲' : '○'} /></Row>
            <T v="small" muted>Practice sales: never touch stock or reports, receipts are marked “not a valid receipt”.</T>
          </View>
          <Button testID="toggle-training" kind={training ? 'accent' : 'secondary'} label={training ? 'Turn training off' : 'Turn training on'}
            disabled={!can(staff, 'pos.training_mode') || !basketEmpty}
            hint={!basketEmpty ? 'Finish or void the current sale first' : undefined}
            onPress={() => { setState({ training: !training }); toast(training ? 'Training mode off' : 'Training mode on'); }} />
        </Row>
        {!basketEmpty ? <T v="small" tone={color.warning}>! Finish or void the current sale before switching.</T> : null}
      </View>

      <Row wrap>
        <Button kind="secondary" label="Lock till" icon="⏻" onPress={lock} />
        <Button kind="secondary" label="Log out" onPress={logout} />
        {isOwner(staff) ? <Button kind="danger" label="Unpair this device" onPress={() => setSheet('unpair')} /> : null}
      </Row>

      <AmountSheet visible={sheet === 'cash_drop'} title="Cash drop" cta="Record cash drop" onClose={() => setSheet(null)}
        onSubmit={(amount) => move('cash_drop', { amount_pence: amount, reason: 'Cash drop to safe' })} />
      <PaidOutSheet visible={sheet === 'paid_out'} onClose={() => setSheet(null)}
        onSubmit={(amount, category, description) => move('paid_out', { amount_pence: amount, reason: description,
          expense: category ? { category_id: category, description } : null })} />
      <XReadSheet visible={sheet === 'x_read'} sessionId={session?.id ?? null} onClose={() => setSheet(null)} />
      <Sheet visible={sheet === 'unpair'} title="Unpair this device?" onClose={() => setSheet(null)}>
        <Banner tone="danger" text="Sales still waiting to sync on this till will be lost. The device must be paired again with a new code." />
        <Button kind="danger" label="Unpair" onPress={() => { void unpairDevice(); }} />
      </Sheet>
      <ApprovalSheet request={approval?.request ?? null} onCancel={() => setApproval(null)} onApproved={(r) => approval?.retry(r)} />
    </ScrollView>
  );
}

function AmountSheet({ visible, title, cta, onClose, onSubmit, children }: {
  visible: boolean; title: string; cta: string; onClose: () => void; onSubmit: (pence: number) => Promise<boolean> | void; children?: React.ReactNode;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (visible) setTyped(''); }, [visible]);
  const pence = Number(typed || '0');
  return (
    <Sheet visible={visible} title={title} onClose={onClose} footer={<Button label={`${cta} · ${formatGBP(pence)}`} size="lg" disabled={pence <= 0} onPress={() => void onSubmit(pence)} />}>
      <Row wrap gap={space.lg} style={{ justifyContent: 'space-between' }}>
        <Money pence={formatGBP(pence)} size={48} />
        <Keypad size={60} testIDPrefix="amt" keys={['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫']} onKey={(k) => setTyped((t) => applyAmountKey(t, k, 7))} />
      </Row>
      {children}
    </Sheet>
  );
}

function PaidOutSheet({ visible, onClose, onSubmit }: { visible: boolean; onClose: () => void; onSubmit: (pence: number, category: string | null, description: string) => Promise<boolean> }) {
  const [cats, setCats] = useState<ExpenseCategory[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setCategory(null); setDescription(''); setError(null);
    api<ExpenseCategory[]>('GET', '/v1/expense-categories').then(setCats).catch((e) => setError(errorMessage(e)));
  }, [visible]);
  return (
    <AmountSheet visible={visible} title="Paid out" cta="Pay out" onClose={onClose}
      onSubmit={(p) => (description.trim() ? onSubmit(p, category, description.trim()) : setError('Say what the money was for'))}>
      <T v="label">Expense category</T>
      <Row wrap>
        {cats.map((c) => <Button key={c.id} kind={category === c.id ? 'primary' : 'secondary'} label={c.name} selected={category === c.id} onPress={() => setCategory(c.id)} />)}
      </Row>
      <Field label="What was it for?" value={description} onChangeText={setDescription} placeholder="e.g. Window cleaner" />
      {error ? <Banner tone="danger" text={error} /> : null}
    </AmountSheet>
  );
}

function XReadSheet({ visible, sessionId, onClose }: { visible: boolean; sessionId: string | null; onClose: () => void }) {
  const [z, setZ] = useState<ZReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible || !sessionId) return;
    setZ(null); setError(null);
    api<ZReport>('GET', `/v1/till-sessions/${sessionId}/z-report`).then(setZ).catch((e) => setError(errorMessage(e)));
  }, [visible, sessionId]);
  return (
    <Sheet visible={visible} title="X-read (till stays open)" onClose={onClose} width={520}>
      {error ? <Banner tone="danger" text={error} /> : null}
      {z ? <ZReportView z={z} /> : !error ? <T muted>Loading…</T> : null}
      <T v="small" muted>Sales still waiting on this till’s offline queue are not included until they sync.</T>
    </Sheet>
  );
}
