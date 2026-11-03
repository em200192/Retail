import { formatGBP, type Permission } from '@retail/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ApiError, errorMessage } from '../src/api';
import { getReceiptMode, LANGUAGES, type ReceiptLanguageMode, setReceiptMode, t, useLang } from '../src/i18n';
import { isEmpty } from '../src/logic/basket';
import { can, isOwner } from '../src/logic/permissions';
import { api, lock, logout, setState, toast, unpairDevice, useApp } from '../src/state/store';
import { type ApprovalRequest, type ApprovalResult, ApprovalSheet } from '../src/ui/approval';
import { applyAmountKey, Badge, Banner, Button, Field, Keypad, Money, Row, Segmented, Sheet, T } from '../src/ui/components';
import { color, font, radius, shadow, space } from '../src/ui/theme';
import { LanguageSwitch } from '../src/ui/language';
import { type ZReport, ZReportView } from '../src/ui/zreport';

type Movement = 'no_sale' | 'paid_out' | 'cash_drop';
interface ExpenseCategory { id: string; name: string; vat_reclaimable: boolean }

export default function Menu() {
  const lang = useLang();
  const staff = useApp((s) => s.session?.staff ?? null);
  const training = useApp((s) => s.training);
  const basketEmpty = useApp((s) => isEmpty(s.basket));
  const session = useApp((s) => s.tillSession);
  const online = useApp((s) => s.online);
  const [sheet, setSheet] = useState<null | 'paid_out' | 'cash_drop' | 'x_read' | 'unpair'>(null);
  const [approval, setApproval] = useState<{ request: ApprovalRequest; retry: (r: ApprovalResult) => void } | null>(null);

  const needSession = !session ? t('menu.needSession') : !online ? t('menu.needOnline') : null;

  /** Cash movements are online calls; the server checks limits and (if needed) the manager PIN itself. */
  const move = async (type: Movement, body: Record<string, unknown> = {}, approvalBody?: ApprovalResult) => {
    try {
      await api('POST', `/v1/till-sessions/${session!.id}/cash-movements`, {
        movement_type: type, ...body,
        ...(approvalBody ? { approval: { approver_staff_id: approvalBody.approverId, approver_pin: approvalBody.pin } } : {}),
      });
      toast(type === 'no_sale' ? t('menu.noSaleDone') : type === 'paid_out' ? t('menu.paidOutDone') : t('menu.cashDropDone'), 'success');
      setSheet(null);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.needsApproval && !approvalBody) {
        const perm = (type === 'no_sale' ? 'pos.no_sale' : 'pos.paid_out') as Permission;
        setApproval({
          request: { action: perm, mode: 'collect', title: t('approval.title'), description: e.message },
          retry: (r) => { setApproval(null); void move(type, body, r); },
        });
        return false;
      }
      toast(errorMessage(e), 'danger');
      return false;
    }
  };

  const items: { key: string; title: string; sub: string; icon: string; perm?: Permission; onPress: () => void; disabled?: string | null; tone?: 'accent' }[] = [
    { key: 'refund', title: t('menu.refund'), sub: t('menu.refundSub'), icon: '↺', perm: 'pos.refund', onPress: () => router.push('/refund') },
    { key: 'no_sale', title: t('menu.noSale'), sub: t('menu.noSaleSub'), icon: '⊡', perm: 'pos.no_sale', onPress: () => void move('no_sale'), disabled: needSession },
    { key: 'paid_out', title: t('menu.paidOut'), sub: t('menu.paidOutSub'), icon: '£', perm: 'pos.paid_out', onPress: () => setSheet('paid_out'), disabled: needSession },
    { key: 'cash_drop', title: t('menu.cashDrop'), sub: t('menu.cashDropSub'), icon: '⇣', perm: 'pos.close_till', onPress: () => setSheet('cash_drop'), disabled: needSession },
    { key: 'x_read', title: t('menu.xRead'), sub: t('menu.xReadSub'), icon: '≡', perm: 'pos.z_report', onPress: () => setSheet('x_read'), disabled: needSession },
    { key: 'cash_up', title: t('menu.cashUp'), sub: t('menu.cashUpSub'), icon: '✓', perm: 'pos.close_till', onPress: () => router.push('/cash-up'), disabled: needSession },
    { key: 'staff', title: t('menu.staff'), sub: t('menu.staffSub'), icon: '☺', onPress: () => router.push('/staff') },
    { key: 'sync', title: t('menu.sync'), sub: t('menu.syncSub'), icon: '⇅', onPress: () => router.push('/sync') },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 1180, width: '100%', alignSelf: 'center' }}>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View>
          <T v="caption" muted>{t('menu.caption')}</T>
          <T v="title" accessibilityRole="header">{t('menu.title', { name: staff?.display_name ?? '' })}</T>
        </View>
        <Button kind="secondary" label={t('common.backToTill')} onPress={() => router.replace('/sell')} />
      </Row>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        {items.map((it) => {
          const allowed = !it.perm || can(staff, it.perm);
          const disabled = !allowed ? t('menu.notAllowed') : it.disabled ?? null;
          return (
            <Pressable key={it.key} testID={`menu-${it.key}`} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }}
              accessibilityLabel={t('menu.itemA11y', { title: it.title, sub: disabled ?? it.sub })} onPress={disabled ? undefined : it.onPress}
              style={({ pressed }) => [{
                width: 260, flexGrow: 1, minHeight: 112, padding: space.lg, borderRadius: radius.md, backgroundColor: color.card,
                borderWidth: 1, borderColor: color.border, gap: 6, opacity: disabled ? 0.5 : 1,
              }, shadow, pressed && !disabled && { backgroundColor: color.primaryTint }]}>
              <Row>
                <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: color.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 20, color: color.primary, fontWeight: '800', fontFamily: font.family }}>{it.icon}</Text>
                </View>
                <T v="h3" style={{ flexShrink: 1 }}>{it.title}</T>
              </Row>
              <T v="small" muted>{disabled ?? it.sub}</T>
            </Pressable>
          );
        })}
      </View>

      <View style={{ backgroundColor: training ? '#FFF4D1' : color.card, borderRadius: radius.md, borderWidth: 1, borderColor: training ? '#F2D27A' : color.border, padding: space.lg, gap: space.sm }}>
        <Row style={{ justifyContent: 'space-between' }} wrap>
          <View style={{ flex: 1, minWidth: 240 }}>
            <Row><T v="h3">{t('menu.training')}</T><Badge label={training ? t('common.on') : t('common.off')} tone={training ? 'accent' : 'neutral'} symbol={training ? '▲' : '○'} /></Row>
            <T v="small" muted>{t('menu.trainingBody')}</T>
          </View>
          <Button testID="toggle-training" kind={training ? 'accent' : 'secondary'} label={training ? t('menu.trainingTurnOff') : t('menu.trainingTurnOn')}
            disabled={!can(staff, 'pos.training_mode') || !basketEmpty}
            hint={!basketEmpty ? t('menu.trainingHint') : undefined}
            onPress={() => { setState({ training: !training }); toast(training ? t('menu.trainingIsOff') : t('menu.trainingIsOn')); }} />
        </Row>
        {!basketEmpty ? <T v="small" tone={color.warning}>{t('menu.trainingWarn')}</T> : null}
      </View>

      <LanguageCard lang={lang} />

      <Row wrap>
        <Button kind="secondary" label={t('menu.lockTill')} icon="⏻" onPress={lock} />
        <Button kind="secondary" label={t('menu.logout')} onPress={logout} />
        {isOwner(staff) ? <Button kind="danger" label={t('menu.unpair')} onPress={() => setSheet('unpair')} /> : null}
      </Row>

      <AmountSheet visible={sheet === 'cash_drop'} title={t('menu.cashDrop')} cta={t('menu.cashDropCta')} onClose={() => setSheet(null)}
        onSubmit={(amount) => move('cash_drop', { amount_pence: amount, reason: 'Cash drop to safe' })} />
      <PaidOutSheet visible={sheet === 'paid_out'} onClose={() => setSheet(null)}
        onSubmit={(amount, category, description) => move('paid_out', { amount_pence: amount, reason: description,
          expense: category ? { category_id: category, description } : null })} />
      <XReadSheet visible={sheet === 'x_read'} sessionId={session?.id ?? null} onClose={() => setSheet(null)} />
      <Sheet visible={sheet === 'unpair'} title={t('menu.unpairTitle')} onClose={() => setSheet(null)}>
        <Banner tone="danger" text={t('menu.unpairWarn')} />
        <Button kind="danger" label={t('menu.unpairConfirm')} onPress={() => { void unpairDevice(); }} />
      </Sheet>
      <ApprovalSheet request={approval?.request ?? null} onCancel={() => setApproval(null)} onApproved={(r) => approval?.retry(r)} />
    </ScrollView>
  );
}

/** Till language (instant, no restart) and the customer receipt language. */
function LanguageCard({ lang }: { lang: keyof typeof LANGUAGES }) {
  const [mode, setMode] = useState<ReceiptLanguageMode>(getReceiptMode());
  return (
    <View testID="language-card" style={{ backgroundColor: color.card, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, padding: space.lg, gap: space.md }}>
      <Row wrap style={{ justifyContent: 'space-between' }} gap={space.md}>
        <View style={{ flex: 1, minWidth: 200, gap: 4 }}>
          <T v="h3">{lang === 'en' ? t('lang.till') : `${t('lang.till')} · Language`}</T>
        </View>
        <LanguageSwitch onChange={() => toast(t('lang.changed'))} />
      </Row>
      <View style={{ gap: 6 }}>
        <T v="label">{t('lang.receipt')}</T>
        <Segmented<ReceiptLanguageMode> label={t('lang.receipt')} value={mode}
          onChange={(v) => { setMode(v); setReceiptMode(v); }}
          options={[{ value: 'en', label: t('lang.receiptEnglish') }, { value: 'till', label: t('lang.receiptFollow') }]} />
        <T v="small" muted>{t('lang.receiptHint')}</T>
      </View>
    </View>
  );
}

function AmountSheet({ visible, title, cta, onClose, onSubmit, children }: {
  visible: boolean; title: string; cta: string; onClose: () => void; onSubmit: (pence: number) => Promise<boolean> | void; children?: React.ReactNode;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (visible) setTyped(''); }, [visible]);
  const pence = Number(typed || '0');
  return (
    <Sheet visible={visible} title={title} onClose={onClose} footer={<Button label={t('menu.amountCta', { cta, amount: formatGBP(pence) })} size="lg" disabled={pence <= 0} onPress={() => void onSubmit(pence)} />}>
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
    <AmountSheet visible={visible} title={t('menu.paidOut')} cta={t('menu.payOutCta')} onClose={onClose}
      onSubmit={(p) => (description.trim() ? onSubmit(p, category, description.trim()) : setError(t('menu.paidOutWhy')))}>
      <T v="label">{t('menu.expenseCategory')}</T>
      <Row wrap>
        {cats.map((c) => <Button key={c.id} kind={category === c.id ? 'primary' : 'secondary'} label={c.name} selected={category === c.id} onPress={() => setCategory(c.id)} />)}
      </Row>
      <Field label={t('menu.whatFor')} value={description} onChangeText={setDescription} placeholder={t('menu.whatForPlaceholder')} />
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
    <Sheet visible={visible} title={t('menu.xReadTitle')} onClose={onClose} width={520}>
      {error ? <Banner tone="danger" text={error} /> : null}
      {z ? <ZReportView z={z} /> : !error ? <T muted>{t('common.loadingDots')}</T> : null}
      <T v="small" muted>{t('menu.xReadNote')}</T>
    </Sheet>
  );
}
