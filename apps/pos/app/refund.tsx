import { formatDateTimeUK, formatGBP, formatQuantity, uuidv7 } from '@retail/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { ApiError, errorMessage } from '../src/api';
import { can, limitDecision } from '../src/logic/permissions';
import { buildRefundPayload, refundableLines, refundAmount, type RefundableLine, type SaleDetail } from '../src/logic/refund';
import { api, getState, queueRefund, recentSale, toast, useApp } from '../src/state/store';
import { type ApprovalRequest, type ApprovalResult, ApprovalSheet } from '../src/ui/approval';
import { Badge, Banner, Button, Card, Field, Money, Row, Segmented, T } from '../src/ui/components';
import { color, space } from '../src/ui/theme';

const REASONS = [
  { code: 'changed_mind', label: 'Changed mind' }, { code: 'faulty', label: 'Faulty' },
  { code: 'damaged', label: 'Damaged' }, { code: 'wrong_item', label: 'Wrong item' }, { code: 'out_of_date', label: 'Out of date' },
];

export default function Refund() {
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
    return <View style={{ padding: space.xl, gap: space.md }}><Banner tone="warning" text="You can’t do refunds. Ask a supervisor or manager to log in." /><Button kind="secondary" label="← Back" onPress={() => router.back()} /></View>;
  }

  const find = async () => {
    const rn = receiptNo.trim().toUpperCase();
    if (!rn) return;
    setBusy(true); setError(null); setSale(null); setQty({}); setRestock({});
    try {
      const rows = await api<{ id: string }[]>('GET', `/v1/sales?branch_id=${branchId}&receipt_number=${encodeURIComponent(rn)}&limit=1`);
      if (!rows[0]) throw new Error(`No sale with receipt number ${rn}`);
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
  const blocked = sale && (sale.is_training ? 'Training sales cannot be refunded.' : !['completed', 'partially_refunded'].includes(sale.status) ? `This sale is ${sale.status.replace('_', ' ')}.` : null);

  const submit = async () => {
    if (!staff || !sale) return;
    setError(null);
    let approvalRow: Record<string, unknown> | null = null;
    if (limitDecision(staff, 'pos.refund.max_amount_pence', total) === 'needs_approval') {
      const r = await new Promise<ApprovalResult | null>((resolve) => setApproval({
        resolve, request: { action: 'pos.refund', limit: { code: 'pos.refund.max_amount_pence', value: total }, title: 'Manager approval: refund',
          description: `A refund of ${formatGBP(total)} is over ${staff.display_name}’s refund limit.` },
      }));
      setApproval(null);
      if (!r) return;
      approvalRow = { id: uuidv7(), action_code: 'pos.refund', requested_by: staff.id, approved_by: r.approverId, outcome: 'approved', value: total, occurred_at: new Date().toISOString() };
    }
    try {
      const payload = buildRefundPayload({ saleId: sale.id, tillSessionId: getState().tillSession?.id ?? null, staffId: staff.id,
        reasonCode: reason, method, picks, approval: approvalRow });
      await queueRefund(payload, `of ${sale.receipt_number}`);
      toast(`Refund ${formatGBP(payload.total_pence)} ${method === 'cash' ? '— give cash from the drawer' : 'to card'}`, 'success');
      router.replace('/sell');
    } catch (e) { setError(errorMessage(e)); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 1000, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View><T v="caption" muted>Refund</T><T v="title" accessibilityRole="header">Find the receipt</T></View>
        <Button kind="secondary" label="← Back" onPress={() => router.back()} />
      </Row>
      <Card style={{ gap: space.md }}>
        <Row style={{ alignItems: 'flex-end' }}>
          <Field testID="receipt-number" style={{ flex: 1 }} label="Receipt number" value={receiptNo} onChangeText={setReceiptNo}
            placeholder="e.g. MAN1-1-1083" autoCapitalize="characters" onSubmitEditing={find} />
          <Button label={busy ? 'Looking…' : 'Find'} onPress={find} disabled={busy || !receiptNo.trim()} />
        </Row>
        {error ? <Banner tone="danger" text={error} /> : null}
      </Card>
      {sale ? (
        <Card style={{ gap: space.md }}>
          <Row style={{ justifyContent: 'space-between' }} wrap>
            <T v="h2">{sale.receipt_number}</T>
            <Row>
              <T muted>{sale.completed_at ? formatDateTimeUK(sale.completed_at) : ''} · {formatGBP(sale.total_pence)}</T>
              {source === 'local' ? <Badge label="From this till (offline)" tone="accent" symbol="○" /> : null}
            </Row>
          </Row>
          {blocked ? <Banner tone="warning" text={blocked} /> : null}
          {lines.map((l) => <RefundRow key={l.saleLineId} line={l} qty={qty[l.saleLineId] ?? 0} restock={restock[l.saleLineId] ?? true}
            onQty={(n) => setQty((q) => ({ ...q, [l.saleLineId]: n }))} onRestock={(b) => setRestock((r) => ({ ...r, [l.saleLineId]: b }))} />)}
          <T v="label">Reason</T>
          <Row wrap>{REASONS.map((r) => <Button key={r.code} kind={reason === r.code ? 'primary' : 'secondary'} label={r.label} selected={reason === r.code} onPress={() => setReason(r.code)} />)}</Row>
          <Segmented label="Refund method" value={method} onChange={setMethod} options={[{ value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' }]} />
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="h3">Refund total</T>
            <Money pence={formatGBP(total)} size={36} />
          </Row>
          <Button testID="refund-submit" label={`Refund ${formatGBP(total)}`} size="xl" disabled={!!blocked || total <= 0} onPress={submit} />
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
          <T v="small" muted>Bought {formatQuantity(line.soldQty)} · {formatGBP(line.lineTotalPence)}{line.refundedQty ? ` · already refunded ${formatQuantity(line.refundedQty)}` : ''}</T>
        </View>
        {line.remainingQty <= 0 ? <Badge label="Fully refunded" tone="neutral" symbol="✓" /> : (
          <Row>
            <Button kind="secondary" label="−" accessibilityLabel={`Refund one less ${line.description}`} disabled={qty <= 0} onPress={() => onQty(Math.max(0, qty - step))} style={{ width: 52 }} />
            <T v="h3" style={{ minWidth: 40, textAlign: 'center' }}>{formatQuantity(qty)}</T>
            <Button kind="secondary" label="+" accessibilityLabel={`Refund one more ${line.description}`} disabled={qty >= line.remainingQty} onPress={() => onQty(Math.min(line.remainingQty, qty + step))} style={{ width: 52 }} />
            <Money pence={qty > 0 ? formatGBP(refundAmount(line, qty)) : '—'} size={17} style={{ minWidth: 70, textAlign: 'right' }} />
          </Row>
        )}
      </Row>
      {qty > 0 ? (
        <Segmented label={`What happens to ${line.description}`} value={restock ? 'restock' : 'waste'} onChange={(v) => onRestock(v === 'restock')}
          options={[{ value: 'restock', label: 'Back on the shelf' }, { value: 'waste', label: 'Damaged – write off' }]} />
      ) : null}
    </View>
  );
}
