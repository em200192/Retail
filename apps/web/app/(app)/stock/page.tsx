'use client';
import { formatGBP, todayUK } from '@retail/shared';
import { formatDateTimeUK, formatDateUK } from '@/lib/format';
import { Boxes, CalendarClock, ClipboardCheck, PackagePlus, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ProductPicker } from '@/components/product-picker';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, LoadingRows, Modal, MoneyInput, PageHeader, Select, Table, Tabs, Td, Th, useToast } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';

const REASONS: Record<string, string> = { expired: 'Out of date', damaged: 'Damaged', spoiled: 'Spoiled / chiller fault', theft_known: 'Known theft',
  sampling: 'Tasting / sampling', count_correction: 'Count correction', supplier_short: 'Supplier short-delivered', other: 'Other' };
const MOVES: Record<string, { label: string; tone: 'success' | 'danger' | 'neutral' | 'brand' | 'warning' }> = {
  sale: { label: 'Sale', tone: 'neutral' }, refund: { label: 'Refund', tone: 'brand' }, receipt: { label: 'Delivery', tone: 'success' },
  opening: { label: 'Opening stock', tone: 'success' }, adjustment: { label: 'Adjustment', tone: 'warning' }, waste: { label: 'Waste', tone: 'danger' },
  transfer_in: { label: 'Transfer in', tone: 'brand' }, transfer_out: { label: 'Transfer out', tone: 'brand' }, stocktake: { label: 'Stocktake', tone: 'warning' },
  online_order: { label: 'Online order', tone: 'neutral' }, return_to_supplier: { label: 'Returned', tone: 'neutral' },
};

type Action = { kind: 'receive' | 'adjust' | 'waste'; product?: { id: string; name: string } | null; batchId?: string };

function StockInner() {
  const { branchId, can } = useMe();
  const initial = useSearchParams().get('view');
  const [tab, setTab] = useState<'levels' | 'expiring' | 'movements'>(initial === 'expiring' ? 'expiring' : initial === 'movements' ? 'movements' : 'levels');
  const [onlyLow, setOnlyLow] = useState(initial === 'low');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [action, setAction] = useState<Action | null>(null);
  const levels = useApi<any[]>(branchId ? `/v1/stock?branch_id=${branchId}${onlyLow ? '&only_low=true' : ''}${dq ? `&q=${encodeURIComponent(dq)}` : ''}` : null);
  const expiring = useApi<any[]>(branchId ? `/v1/stock/expiring?branch_id=${branchId}` : null);
  const moves = useApi<any[]>(branchId && tab === 'movements' ? `/v1/stock/movements?branch_id=${branchId}&limit=200` : null);
  const names = new Map((levels.data ?? []).map((l) => [l.product_id, l.name]));
  const lowCount = (levels.data ?? []).filter((l) => l.reorder_point !== null && l.on_hand <= l.reorder_point).length;
  const refresh = () => { levels.mutate(); expiring.mutate(); moves.mutate(); };

  return (
    <>
      <PageHeader title={t("Stock")} description={t("Every change is recorded in the stock ledger — nothing is ever overwritten.")}
        actions={<>
          {can('stock.waste') && <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setAction({ kind: 'waste' })}>{t("Record waste")}</Button>}
          {can('stock.adjust') && <Button variant="secondary" icon={<SlidersHorizontal className="size-4" />} onClick={() => setAction({ kind: 'adjust' })}>{t("Adjust")}</Button>}
          {can('stock.adjust') && <Button icon={<PackagePlus className="size-4" />} onClick={() => setAction({ kind: 'receive' })}>{t("Goods in")}</Button>}
        </>} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'levels', label: t('Stock levels') }, { id: 'expiring', label: t('Use by soon'), count: expiring.data?.length }, { id: 'movements', label: t('History') }]} />

      {tab === 'levels' && (
        <Card>
          <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
              <label htmlFor="sq" className="sr-only">{t("Search stock")}</label>
              <Input id="sq" placeholder={t("Search products")} value={q} onChange={(e) => setQ(e.target.value)} className="ps-9" />
            </div>
            <div className="flex gap-1 rounded-lg bg-surface p-1" role="group" aria-label={t("Filter")}>
              <button onClick={() => setOnlyLow(false)} aria-pressed={!onlyLow} className={`rounded-md px-3 py-1.5 text-sm font-medium ${!onlyLow ? 'bg-white shadow-sm' : 'text-muted'}`}>{t("All")}</button>
              <button onClick={() => setOnlyLow(true)} aria-pressed={onlyLow} className={`rounded-md px-3 py-1.5 text-sm font-medium ${onlyLow ? 'bg-white shadow-sm' : 'text-muted'}`}>
                {t('Running low')} {!onlyLow && lowCount > 0 && <span className="ms-1 rounded-full bg-warning-tint px-1.5 text-xs text-warning">{lowCount}</span>}</button>
            </div>
          </div>
          <ErrorNote error={levels.error} />
          {levels.isLoading && !levels.data ? <LoadingRows /> : levels.data?.length === 0 ? (
            <EmptyState icon={<Boxes className="size-6" />} title={onlyLow ? t('Nothing is running low') : t('No stock yet')}>{onlyLow ? t('Every product is above its reorder point.') : t('Record a delivery to get started.')}</EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>{t("Product")}</Th><Th align="right">{t("On hand")}</Th><Th align="right">{t("Held for orders")}</Th><Th align="right">{t("Reorder at")}</Th><Th>{t("Status")}</Th><Th><span className="sr-only">{t("Actions")}</span></Th></tr></thead>
              <tbody>{levels.data?.map((l) => {
                const low = l.reorder_point !== null && l.on_hand <= l.reorder_point;
                const out = l.on_hand <= 0;
                return (
                  <tr key={l.product_id} className="hover:bg-surface/60">
                    <Td className="font-medium">{l.name}{l.shelf_location && <span className="ms-2 text-xs text-subtle">{l.shelf_location}</span>}</Td>
                    <Td align="right" className="font-semibold">{l.on_hand}</Td>
                    <Td align="right" className="text-muted">{l.reserved || '—'}</Td>
                    <Td align="right" className="text-muted">{l.reorder_point ?? '—'}</Td>
                    <Td>{out ? <Badge tone="danger">{t("Out of stock")}</Badge> : low ? <Badge tone="warning">{t("Running low")}</Badge> : <Badge tone="success">{t("In stock")}</Badge>}</Td>
                    <Td align="right">
                      {can('stock.adjust') && <Button size="sm" variant="ghost" onClick={() => setAction({ kind: 'receive', product: { id: l.product_id, name: l.name } })}>{t("Goods in")}</Button>}
                    </Td>
                  </tr>
                );
              })}</tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'expiring' && (
        <Card>
          {expiring.data?.length === 0 ? <EmptyState icon={<CalendarClock className="size-6" />} title={t("Nothing to clear")}>{t("No batches reach their use-by date in the next 3 days.")}</EmptyState> : (
            <Table>
              <thead><tr><Th>{t("Product")}</Th><Th>{t("Use by")}</Th><Th align="right">{t("Left")}</Th><Th>{t("Suggested action")}</Th><Th><span className="sr-only">{t("Actions")}</span></Th></tr></thead>
              <tbody>{expiring.data?.map((e) => (
                <tr key={e.batch_id}>
                  <Td className="font-medium">{e.name}</Td>
                  <Td>{formatDateUK(e.expiry_date, { weekday: 'short', day: 'numeric', month: 'short' })}
                    <Badge tone={e.days_left <= 0 ? 'danger' : 'warning'} className="ms-2">{e.days_left < 0 ? t('Expired') : e.days_left === 0 ? t('Today') : e.days_left === 1 ? t('Tomorrow') : t('{n} days', { n: e.days_left })}</Badge></Td>
                  <Td align="right">{e.qty_remaining}</Td>
                  <Td className="text-muted">{e.days_left <= 0 ? t('Remove from sale and record as waste') : t('Reduce to clear and print a yellow sticker')}</Td>
                  <Td align="right">{can('stock.waste') && <Button size="sm" variant="secondary" onClick={() => setAction({ kind: 'waste', product: { id: e.product_id, name: e.name }, batchId: e.batch_id })}>{t("Waste")}</Button>}</Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'movements' && (
        <Card>
          {moves.isLoading ? <LoadingRows /> : (
            <Table>
              <thead><tr><Th>{t("When")}</Th><Th>{t("Product")}</Th><Th>{t("Type")}</Th><Th align="right">{t("Change")}</Th><Th>{t("Reason")}</Th><Th align="right">{t("Unit cost")}</Th></tr></thead>
              <tbody>{moves.data?.map((m) => (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap text-muted">{formatDateTimeUK(m.occurred_at)}</Td>
                  <Td>{names.get(m.product_id) ?? '—'}</Td>
                  <Td><Badge tone={MOVES[m.movement_type]?.tone ?? 'neutral'}>{t(MOVES[m.movement_type]?.label ?? m.movement_type)}</Badge></Td>
                  <Td align="right" className={m.quantity > 0 ? 'font-semibold text-success' : 'font-semibold'}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</Td>
                  <Td className="text-muted">{m.reason_code ? t(REASONS[m.reason_code] ?? '') : ''}{m.reason ? ` — ${m.reason}` : ''}</Td>
                  <Td align="right" className="text-muted">{m.unit_cost_pence ? formatGBP(m.unit_cost_pence) : '—'}</Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Card>
      )}
      {action && <StockActionModal action={action} onClose={() => setAction(null)} onDone={refresh} branchId={branchId!} />}
    </>
  );
}

function StockActionModal({ action, onClose, onDone, branchId }: { action: Action; onClose: () => void; onDone: () => void; branchId: string }) {
  const toast = useToast();
  const [product, setProduct] = useState(action.product ?? null);
  const [qty, setQty] = useState('');
  const [direction, setDirection] = useState<'up' | 'down'>('down');
  const [reason, setReason] = useState(action.kind === 'waste' ? 'expired' : 'count_correction');
  const [note, setNote] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [expiry, setExpiry] = useState('');
  const [approval, setApproval] = useState<{ staff: string; pin: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const staff = useApi<any[]>(approval ? `/v1/branches/${branchId}/staff-tiles` : null);
  const title = { receive: t('Goods in'), adjust: t('Adjust stock'), waste: t('Record waste') }[action.kind];

  const submit = async () => {
    const n = Number(qty);
    if (!product) return setErr(t('Choose a product'));
    if (!(n > 0)) return setErr(t('Enter a quantity greater than 0'));
    setBusy(true); setErr(null);
    try {
      if (action.kind === 'receive') {
        await api('/v1/stock/receipts', { body: { branch_id: branchId, lines: [{ product_id: product.id, quantity: n, unit_cost_pence: cost, expiry_date: expiry || null }] } });
        toast(t('{n} × {name} booked in', { n, name: product.name }));
      } else if (action.kind === 'waste') {
        const r = await api('/v1/stock/waste', { body: { branch_id: branchId, product_id: product.id, quantity: n, reason_code: reason, reason: note || null, batch_id: action.batchId ?? null } });
        toast(t('Waste recorded · {amount} at cost', { amount: formatGBP(r.cost_pence) }));
      } else {
        const r = await api('/v1/stock/adjustments', { body: { branch_id: branchId, product_id: product.id, quantity: direction === 'up' ? n : -n,
          reason_code: reason, reason: note || null, approval: approval ? { approver_staff_id: approval.staff, approver_pin: approval.pin } : null } });
        toast(t('Stock adjusted — {n} now on hand', { n: r.on_hand }));
      }
      onDone(); onClose();
    } catch (e) {
      const ae = e as ApiError;
      if (ae.needsApproval && !approval) { setApproval({ staff: '', pin: '' }); setErr(t('This is over your limit. A manager needs to approve it with their PIN.')); }
      else setErr(ae.message);
    } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={title}
      description={action.kind === 'adjust' ? 'Use this when a count shows the system is wrong. It adds a correcting entry.' : undefined}
      footer={<><Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button><Button variant={action.kind === 'waste' ? 'danger' : 'primary'} onClick={submit} loading={busy}>{title}</Button></>}>
      {err && <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm font-medium text-danger">{err}</p>}
      <Field label={t("Product")} htmlFor="pp"><ProductPicker id="pp" value={product} onChange={setProduct} /></Field>
      {action.kind === 'adjust' && (
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("Direction")}>
          {(['down', 'up'] as const).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={direction === d} onClick={() => setDirection(d)}
              className={`rounded-lg border px-3 py-2.5 text-sm font-medium ${direction === d ? 'border-brand bg-brand-tint text-brand-dark' : 'border-line'}`}>
              {d === 'down' ? t('Fewer than the system says') : t('More than the system says')}</button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field label={action.kind === 'adjust' ? t('Difference') : t('Quantity')} htmlFor="qty"><Input id="qty" type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        {action.kind === 'receive' ? (
          <Field label={t("Cost per unit (ex VAT)")} htmlFor="cost"><MoneyInput id="cost" value={cost} onChange={setCost} /></Field>
        ) : (
          <Field label={t("Reason")} htmlFor="reason"><Select id="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(REASONS).filter(([k]) => action.kind === 'waste' ? !['count_correction', 'supplier_short'].includes(k) : true)
              .map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field>
        )}
      </div>
      {action.kind === 'receive' && <Field label={t("Use-by date (if it has one)")} htmlFor="exp"><Input id="exp" type="date" min={todayUK()} value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>}
      {action.kind !== 'receive' && <Field label={t("Note (optional)")} htmlFor="note"><Input id="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
      {approval && (
        <div className="rounded-xl border border-accent/40 bg-accent-tint p-4 space-y-3">
          <p className="flex items-center gap-2 text-sm font-semibold"><ClipboardCheck className="size-4" aria-hidden />{t("Manager approval")}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Manager")} htmlFor="ap"><Select id="ap" value={approval.staff} onChange={(e) => setApproval({ ...approval, staff: e.target.value })}>
              <option value="">{t("Choose…")}</option>{(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}</Select></Field>
            <Field label={t("Their PIN")} htmlFor="apin"><Input id="apin" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={approval.pin}
              onChange={(e) => setApproval({ ...approval, pin: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function StockPage() { return <Suspense><StockInner /></Suspense>; }
