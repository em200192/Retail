import { formatGBP, formatQuantity, uuidv7 } from '@retail/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { ApiError, errorMessage } from '../src/api';
import { fmtDateTime, isRTL, type MessageKey, t, useLang } from '../src/i18n';
import { can, limitDecision } from '../src/logic/permissions';
import { buildRefundPayload, refundableLines, refundAmount, type RefundableLine, type SaleDetail } from '../src/logic/refund';
import { api, getState, queueRefund, recentSale, toast, useApp } from '../src/state/store';
import { type ApprovalRequest, type ApprovalResult, ApprovalSheet } from '../src/ui/approval';
import { Badge, Banner, Button, Card, Field, Money, Row, Segmented, T } from '../src/ui/components';
import { color, space } from '../src/ui/theme';

const REASONS = ['changed_mind', 'faulty', 'damaged', 'wrong_item', 'out_of_date'] as const;
const STATUS: Record<string, MessageKey> = {
  voided: 'refund.status.voided', refunded: 'refund.status.refunded', open: 'refund.status.open', parked: 'refund.status.parked',
};

export default function Refund() {
  useLang();
  const staff = useApp((s) => s.session?.staff ?? null);
  const branchId = useApp((s) => s.catalog.branch?.id ?? s.hello?.branch.id ?? '');
  const [receiptNo, setReceiptNo] = useState('');
  const [sale, setSale] = useState<SaleDetail | null>(null);
  const [source, setSource] = useState<'server' | 'local'>('server');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('changed_mind');
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ request: ApprovalRequest; resolve: (r: ApprovalResult | null) => void } | null>(null);

  if (!can(staff, 'pos.refund')) {
    return <View style={{ padding: space.xl, gap: space.md }}><Banner tone="warning" text={t('refund.notAllowed')} /><Button kind="secondary" label={t('common.back')} onPress={() => router.back()} /></View>;
  }

  const find = async () => {
    const rn = receiptNo.trim().toUpperCase();
    if (!rn) return;
    setBusy(true); setError(null); setSale(null); setQty({}); setRestock({});
    try {
      const rows = await api<{ id: string }[]>('GET', `/v1/sales?branch_id=${branchId}&receipt_number=${encodeURIComponent(rn)}&limit=1`);
      if (!rows[0]) throw new Error(t('refund.noSale', { number: rn }));
      setSale(await api<SaleDetail>('GET', `/v1/sales/${rows[0].id}`));
      setSource('server');
    } catch (e) {
      // Offline: this till keeps its last 100 sales, so recent receipts can still be refunded.
      const local = e instanceof ApiError && e.offline ? await recentSale(rn) : null;
      if (local) {
        setSale({ ...local, status: local.status, completed_at: local.completed_at, refunds: [],
          lines: local.lines.map((l) => ({ ...l, product_id: l.product_id ?? null, vat_code: l.vat_code })) } as unknown as SaleDetail);
        setSource('local');
      } else setError(errorMessage(e));
    } finally { setBusy(false); }
  };

  const lines = sale ? refundableLines(sale) : [];
  const picks = lines.filter((l) => (qty[l.saleLineId] ?? 0) > 0).map((l) => ({ line: l, qty: qty[l.saleLineId]!, restock: restock[l.saleLineId] ?? true }));
  const total = picks.reduce((a, p) => a + refundAmount(p.line, p.qty), 0);
  const blocked = sale && (sale.is_training ? t('refund.training')
    : !['completed', 'partially_refunded'].includes(sale.status) ? t('refund.status', { status: STATUS[sale.status] ? t(STATUS[sale.status]!) : sale.status.replace('_', ' ') }) : null);

  const submit = async () => {
    if (!staff || !sale) return;
    setError(null);
    let approvalRow: Record<string, unknown> | null = null;
    if (limitDecision(staff, 'pos.refund.max_amount_pence', total) === 'needs_approval') {
      const r = await new Promise<ApprovalResult | null>((resolve) => setApproval({
        resolve, request: { action: 'pos.refund', limit: { code: 'pos.refund.max_amount_pence', value: total }, title: t('refund.approvalTitle'),
          description: t('refund.approvalBody', { amount: formatGBP(total), name: staff.display_name }) },
      }));
      setApproval(null);
      if (!r) return;
      approvalRow = { id: uuidv7(), action_code: 'pos.refund', requested_by: staff.id, approved_by: r.approverId, outcome: 'approved', value: total, occurred_at: new Date().toISOString() };
    }
    try {
      const payload = buildRefundPayload({ saleId: sale.id, tillSessionId: getState().tillSession?.id ?? null, staffId: staff.id,
        reasonCode: reason, method, picks, approval: approvalRow });
      await queueRefund(payload, `of ${sale.receipt_number}`);
      toast(t(method === 'cash' ? 'refund.doneCash' : 'refund.doneCard', { amount: formatGBP(payload.total_pence) }), 'success');
      router.replace('/sell');
    } catch (e) { setError(errorMessage(e)); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 1000, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View><T v="caption" muted>{t('refund.caption')}</T><T v="title" accessibilityRole="header">{t('refund.title')}</T></View>
        <Button kind="secondary" label={t('common.back')} onPress={() => router.back()} />
      </Row>
      <Card style={{ gap: space.md }}>
        <Row style={{ alignItems: 'flex-end' }}>
          <Field testID="receipt-number" style={{ flex: 1 }} label={t('refund.receiptNumber')} value={receiptNo} onChangeText={setReceiptNo}
            placeholder={t('refund.receiptPlaceholder')} autoCapitalize="characters" onSubmitEditing={find} />
          <Button label={busy ? t('refund.looking') : t('refund.find')} onPress={find} disabled={busy || !receiptNo.trim()} />
        </Row>
        {error ? <Banner tone="danger" text={error} /> : null}
      </Card>
      {sale ? (
        <Card style={{ gap: space.md }}>
          <Row style={{ justifyContent: 'space-between' }} wrap>
            <T v="h2">{sale.receipt_number}</T>
            <Row>
              <T muted>{sale.completed_at ? fmtDateTime(sale.completed_at) : ''} · {formatGBP(sale.total_pence)}</T>
              {source === 'local' ? <Badge label={t('refund.local')} tone="accent" symbol="○" /> : null}
            </Row>
          </Row>
          {blocked ? <Banner tone="warning" text={blocked} /> : null}
          {lines.map((l) => <RefundRow key={l.saleLineId} line={l} qty={qty[l.saleLineId] ?? 0} restock={restock[l.saleLineId] ?? true}
            onQty={(n) => setQty((q) => ({ ...q, [l.saleLineId]: n }))} onRestock={(b) => setRestock((r) => ({ ...r, [l.saleLineId]: b }))} />)}
          <T v="label">{t('common.reason')}</T>
          <Row wrap>{REASONS.map((code) => <Button key={code} kind={reason === code ? 'primary' : 'secondary'} label={t(`refund.reason.${code}`)} selected={reason === code} onPress={() => setReason(code)} />)}</Row>
          <Segmented label={t('refund.method')} value={method} onChange={setMethod} options={[{ value: 'cash', label: t('common.cash') }, { value: 'card', label: t('common.card') }]} />
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="h3">{t('refund.total')}</T>
            <Money pence={formatGBP(total)} size={36} />
          </Row>
          <Button testID="refund-submit" label={t('refund.submit', { amount: formatGBP(total) })} size="xl" disabled={!!blocked || total <= 0} onPress={submit} />
        </Card>
      ) : null}
      <ApprovalSheet request={approval?.request ?? null} onCancel={() => approval?.resolve(null)} onApproved={(r) => approval?.resolve(r)} />
    </ScrollView>
  );
}

function RefundRow({ line, qty, restock, onQty, onRestock }: { line: RefundableLine; qty: number; restock: boolean; onQty: (n: number) => void; onRestock: (b: boolean) => void }) {
  const whole = Number.isInteger(line.remainingQty);
  const step = whole ? 1 : line.remainingQty;
  return (
    <View style={{ borderWidth: 1, borderColor: qty > 0 ? color.primary : color.border, borderRadius: 12, padding: space.md, gap: space.sm }}>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View style={{ flex: 1, minWidth: 200 }}>
          <T v="label">{line.description}</T>
          <T v="small" muted>{t('refund.bought', { qty: formatQuantity(line.soldQty), amount: formatGBP(line.lineTotalPence) })}{line.refundedQty ? ` · ${t('refund.already', { qty: formatQuantity(line.refundedQty) })}` : ''}</T>
        </View>
        {line.remainingQty <= 0 ? <Badge label={t('refund.fully')} tone="neutral" symbol="✓" /> : (
          <Row>
            <Button kind="secondary" label="−" accessibilityLabel={t('refund.oneLess', { name: line.description })} disabled={qty <= 0} onPress={() => onQty(Math.max(0, qty - step))} style={{ width: 52 }} />
            <T v="h3" style={{ minWidth: 40, textAlign: 'center' }}>{formatQuantity(qty)}</T>
            <Button kind="secondary" label="+" accessibilityLabel={t('refund.oneMore', { name: line.description })} disabled={qty >= line.remainingQty} onPress={() => onQty(Math.min(line.remainingQty, qty + step))} style={{ width: 52 }} />
            <Money pence={qty > 0 ? formatGBP(refundAmount(line, qty)) : '—'} size={17} style={{ minWidth: 70, textAlign: isRTL() ? 'left' : 'right' }} />
          </Row>
        )}
      </Row>
      {qty > 0 ? (
        <Segmented label={t('refund.whatHappens', { name: line.description })} value={restock ? 'restock' : 'waste'} onChange={(v) => onRestock(v === 'restock')}
          options={[{ value: 'restock', label: t('refund.restock') }, { value: 'waste', label: t('refund.waste') }]} />
      ) : null}
    </View>
  );
}
