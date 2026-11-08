'use client';
import { formatGBP } from '@retail/shared';
import { formatDateUK } from '@/lib/format';
import { AlertTriangle, Check, Inbox, ListChecks, Plus, Send, Sparkles, Truck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ProductPicker } from '@/components/product-picker';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, LoadingRows, Modal, PageHeader, Select, Table, Tabs, Td, Th, useToast } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';

const SOURCE: Record<string, { label: string; tone: 'brand' | 'accent' | 'neutral' | 'warning' }> = {
  reorder_point: { label: 'Low stock', tone: 'warning' }, staff_request: { label: 'Staff request', tone: 'brand' },
  ai_forecast: { label: 'Forecast', tone: 'accent' }, manual: { label: 'Added by you', tone: 'neutral' },
};
const PO_STATUS: Record<string, 'neutral' | 'brand' | 'success' | 'warning'> = { draft: 'neutral', sent: 'brand', partially_received: 'warning', received: 'success', cancelled: 'neutral' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function PurchasingPage() {
  const { branchId, can, me } = useMe();
  const manage = can('purchasing.manage_list');
  const [tab, setTab] = useState<'requests' | 'list' | 'orders' | 'suppliers' | null>(null);
  // Pick the default tab once permissions are known (managers start on the list).
  useEffect(() => { if (tab === null && me) setTab(manage ? 'list' : 'requests'); }, [me, manage, tab]);
  const requests = useApi<any[]>(branchId ? `/v1/purchase-requests?branch_id=${branchId}` : null);
  const pending = (requests.data ?? []).filter((r) => r.status === 'pending');
  return (
    <>
      <PageHeader title={t("Ordering")} description={t("Staff requests, low stock and your own additions all land on one shopping list. Turn it into orders in one click.")} />
      {tab && <Tabs value={tab} onChange={setTab} tabs={[
        ...(manage ? [{ id: 'list' as const, label: t('Shopping list') }] : []),
        { id: 'requests', label: manage ? t('Staff requests') : t('My requests'), count: manage ? pending.length : undefined },
        ...(can('purchasing.order') ? [{ id: 'orders' as const, label: t('Purchase orders') }] : []),
        ...(can('suppliers.manage') ? [{ id: 'suppliers' as const, label: t('Suppliers') }] : []),
      ]} />}
      {tab === 'list' && <ShoppingList />}
      {tab === 'requests' && <Requests data={requests.data} loading={requests.isLoading} reload={() => requests.mutate()} manage={manage} />}
      {tab === 'orders' && <Orders />}
      {tab === 'suppliers' && <Suppliers />}
    </>
  );
}

function Requests({ data, loading, reload, manage }: { data?: any[]; loading: boolean; reload: () => void; manage: boolean }) {
  const toast = useToast();
  const { branchId } = useMe();
  const [open, setOpen] = useState(false);
  const review = async (id: string, decision: 'approve' | 'reject') => {
    try {
      await api(`/v1/purchase-requests/${id}/review`, { body: { decision } });
      toast(decision === 'approve' ? t('Added to the shopping list') : t('Request declined'));
    } catch (e) { toast((e as Error).message, 'danger'); }
    reload();
  };
  return (
    <Card>
      <CardHeader title={manage ? t('What your team needs') : t('Your requests')} description={t("Staff can ask from the till app: “We need this”.")}
        action={<Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>{t("New request")}</Button>} />
      {loading && !data ? <LoadingRows /> : !data?.length ? <EmptyState icon={<Inbox className="size-6" />} title={t("No requests")}>{t("When staff spot an empty shelf, their request appears here.")}</EmptyState> : (
        <Table>
          <thead><tr><Th>{t("Item")}</Th><Th align="right">{t("Qty")}</Th><Th>{t("Asked by")}</Th><Th>{t("When")}</Th><Th>{t("Status")}</Th>{manage && <Th><span className="sr-only">{t("Actions")}</span></Th>}</tr></thead>
          <tbody>{data.map((r) => (
            <tr key={r.id}>
              <Td><p className="font-medium">{r.product_name ?? r.free_text}</p>{r.note && <p className="text-xs text-subtle">“{r.note}”</p>}</Td>
              <Td align="right">{r.quantity ?? '—'}</Td>
              <Td>{r.requested_by_name}</Td>
              <Td className="text-muted">{formatDateUK(r.created_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</Td>
              <Td>{r.priority === 'urgent' && r.status === 'pending' ? <Badge tone="danger"><AlertTriangle className="size-3" aria-hidden />{t("Urgent")}</Badge>
                : <Badge tone={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'neutral' : 'brand'}>{t(r.status[0].toUpperCase() + r.status.slice(1))}</Badge>}</Td>
              {manage && <Td align="right">{r.status === 'pending' && (
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => review(r.id, 'reject')}>{t("Decline")}</Button>
                  <Button size="sm" icon={<Check className="size-4" />} onClick={() => review(r.id, 'approve')}>{t("Add to list")}</Button>
                </div>)}</Td>}
            </tr>
          ))}</tbody>
        </Table>
      )}
      <NewRequest open={open} onClose={() => setOpen(false)} branchId={branchId!} onDone={() => { reload(); toast(t('Request sent to the manager')); }} />
    </Card>
  );
}

function NewRequest({ open, onClose, branchId, onDone }: { open: boolean; onClose: () => void; branchId: string; onDone: () => void }) {
  const [product, setProduct] = useState<{ id: string; name: string } | null>(null);
  const [text, setText] = useState('');
  const [qty, setQty] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!product && !text.trim()) return setErr(t('Choose a product or describe what you need'));
    try {
      await api('/v1/purchase-requests', { body: { branch_id: branchId, product_id: product?.id ?? null, free_text: product ? null : text,
        quantity: qty ? Number(qty) : null, priority: urgent ? 'urgent' : 'normal' } });
      onDone(); onClose(); setProduct(null); setText(''); setQty(''); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("We need this")} footer={<><Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button><Button onClick={submit}>{t("Send request")}</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <Field label={t("Product")} htmlFor="rp"><ProductPicker id="rp" value={product} onChange={setProduct} /></Field>
      {!product && <Field label={t("Or describe it")} htmlFor="rt" hint={t("For things we don’t stock yet.")}><Input id="rt" value={text} onChange={(e) => setText(e.target.value)} /></Field>}
      <div className="grid grid-cols-2 gap-4 items-end">
        <Field label={t("How many? (optional)")} htmlFor="rq"><Input id="rq" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} className="size-4 accent-[var(--color-danger)]" />{t("It’s urgent")}</label>
      </div>
    </Modal>
  );
}

function ShoppingList() {
  const { branchId, can } = useMe();
  const toast = useToast();
  const list = useApi<any>(branchId ? `/v1/purchase-list?branch_id=${branchId}` : null);
  const suppliers = useApi<any[]>('/v1/suppliers');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const items: any[] = list.data?.items ?? [];
  const active = items.filter((i) => ['pending', 'approved'].includes(i.status));
  const approved = active.filter((i) => i.status === 'approved' && i.supplier_id && i.product_id);
  const groups = new Map<string, any[]>();
  for (const i of active) groups.set(i.supplier_name ?? t('No supplier yet'), [...(groups.get(i.supplier_name ?? t('No supplier yet')) ?? []), i]);
  const est = (i: any) => (i.estimated_unit_cost_pence ?? 0) * i.quantity;
  const update = async (id: string, body: any) => {
    try { await api(`/v1/purchase-list/items/${id}`, { method: 'PATCH', body }); } catch (e) { toast((e as Error).message, 'danger'); }
    list.mutate();
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-semibold">{t('{n} items on the list · {m} ready to order', { n: active.length, m: approved.length })}</p>
          <p className="text-sm text-muted">{t("Estimated cost")}{" "}<span className="tabular font-medium text-ink">{formatGBP(active.reduce((a, i) => a + est(i), 0))}</span>{" "}{t("ex VAT")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Sparkles className="size-4" />} loading={busy === 'gen'} onClick={async () => {
            setBusy('gen');
            try {
              const r = await api('/v1/purchase-list/generate', { body: { branch_id: branchId } }); list.mutate();
              toast(r.added.length ? t('{n} low-stock items added', { n: r.added.length }) : t('Nothing new is running low'));
            } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(null); }
          }}>{t("Add low-stock items")}</Button>
          <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t("Add item")}</Button>
          {can('purchasing.order') && <Button icon={<Truck className="size-4" />} disabled={!approved.length} loading={busy === 'po'} onClick={async () => {
            setBusy('po');
            try { const r = await api('/v1/purchase-orders/from-list', { body: { branch_id: branchId } }); toast(t(r.length > 1 ? '{n} purchase orders created' : '{n} purchase order created', { n: r.length })); list.mutate(); }
            catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(null); }
          }}>{t("Create orders")}</Button>}
        </div>
      </Card>
      {list.isLoading ? <Card><LoadingRows /></Card> : active.length === 0 ? (
        <Card><EmptyState icon={<ListChecks className="size-6" />} title={t("Your shopping list is empty")}>{t("Add low-stock items or approve staff requests to fill it.")}</EmptyState></Card>
      ) : [...groups.entries()].map(([supplier, rows]) => (
        <Card key={supplier}>
          <CardHeader title={supplier} description={t('{n} items · about {amount}', { n: rows.length, amount: formatGBP(rows.reduce((a, i) => a + est(i), 0)) })} />
          <Table>
            <thead><tr><Th>{t("Item")}</Th><Th>{t("Why")}</Th><Th align="right">{t("Qty")}</Th><Th>{t("Supplier")}</Th><Th align="right">{t("Est. cost")}</Th><Th>{t("Status")}</Th></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id}>
                <Td><p className="font-medium">{i.product_name ?? i.free_text}</p>{i.ai_reason && <p className="text-xs text-subtle">{i.ai_reason}</p>}</Td>
                <Td><Badge tone={SOURCE[i.source]?.tone}>{t(SOURCE[i.source]?.label ?? '')}</Badge></Td>
                <Td align="right"><label className="sr-only" htmlFor={`q-${i.id}`}>{t("Quantity")}</label>
                  <Input id={`q-${i.id}`} type="number" min={1} defaultValue={i.quantity} className="ms-auto h-8 w-20 text-end"
                    onBlur={(e) => Number(e.target.value) !== i.quantity && Number(e.target.value) > 0 && update(i.id, { quantity: Number(e.target.value) })} /></Td>
                <Td><label className="sr-only" htmlFor={`s-${i.id}`}>{t("Supplier")}</label>
                  <Select id={`s-${i.id}`} value={i.supplier_id ?? ''} className="h-8 w-36" onChange={(e) => update(i.id, { supplier_id: e.target.value || null })}>
                    <option value="">{t("Choose…")}</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Td>
                <Td align="right" className="text-muted">{i.estimated_unit_cost_pence ? formatGBP(est(i)) : '—'}</Td>
                <Td>{i.status === 'approved' ? (
                  <button onClick={() => update(i.id, { status: 'pending' })} className="inline-flex"><Badge tone="success"><Check className="size-3" aria-hidden />{t("Approved")}</Badge></button>
                ) : (
                  <div className="flex gap-1">
                    <Button size="sm" onClick={() => update(i.id, { status: 'approved' })}>{t("Approve")}</Button>
                    <Button size="sm" variant="ghost" aria-label={t("Remove from list")} onClick={() => update(i.id, { status: 'rejected' })}><X className="size-4" /></Button>
                  </div>
                )}</Td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>
      ))}
      <AddItem open={adding} onClose={() => setAdding(false)} branchId={branchId!} onDone={() => { list.mutate(); toast(t('Added to the list')); }} />
    </div>
  );
}

function AddItem({ open, onClose, branchId, onDone }: { open: boolean; onClose: () => void; branchId: string; onDone: () => void }) {
  const [product, setProduct] = useState<{ id: string; name: string } | null>(null);
  const [qty, setQty] = useState('1');
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!product) return setErr(t('Choose a product'));
    try { await api('/v1/purchase-list/items', { body: { branch_id: branchId, product_id: product.id, quantity: Number(qty) || 1 } }); onDone(); onClose(); setProduct(null); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Add to shopping list")} footer={<><Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button><Button onClick={submit}>{t("Add")}</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <Field label={t("Product")} htmlFor="ap"><ProductPicker id="ap" value={product} onChange={setProduct} /></Field>
      <Field label={t("Quantity (units)")} htmlFor="aq" hint={t("We round up to whole cases when the supplier sells by the case.")}><Input id="aq" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
    </Modal>
  );
}

function Orders() {
  const { branchId } = useMe();
  const toast = useToast();
  const pos = useApi<any[]>(branchId ? `/v1/purchase-orders?branch_id=${branchId}` : null);
  const products = useApi<any[]>('/v1/products?limit=500');
  const names = new Map((products.data ?? []).map((p) => [p.id, p.name]));
  if (pos.isLoading) return <Card><LoadingRows /></Card>;
  if (!pos.data?.length) return <Card><EmptyState icon={<Truck className="size-6" />} title={t("No purchase orders yet")}>{t("Approve items on the shopping list, then choose “Create orders”.")}</EmptyState></Card>;
  return (
    <div className="space-y-4">
      {pos.data.map((po) => (
        <Card key={po.id}>
          <CardHeader title={<span className="flex items-center gap-2">{po.supplier_name}<span className="font-mono text-xs text-subtle">{po.po_number}</span></span>}
            description={`${t('Created {date}', { date: formatDateUK(po.created_at) })}${po.sent_at ? ` · ${t('sent {date} by {how}', { date: formatDateUK(po.sent_at), how: t(po.sent_via) })}` : ''}`}
            action={<div className="flex items-center gap-2"><Badge tone={PO_STATUS[po.status]}>{t(po.status.replace('_', ' '))}</Badge>
              {po.status === 'draft' && <Button size="sm" icon={<Send className="size-4" />} onClick={async () => {
                try { await api(`/v1/purchase-orders/${po.id}/send`, { body: {} }); toast(t('Order sent to supplier')); } catch (e) { toast((e as Error).message, 'danger'); }
                pos.mutate();
              }}>{t("Send")}</Button>}</div>} />
          <Table>
            <thead><tr><Th>{t("Product")}</Th><Th align="right">{t("Ordered")}</Th><Th align="right">{t("Received")}</Th><Th align="right">{t("Cost each")}</Th><Th align="right">{t("Line")}</Th></tr></thead>
            <tbody>{(po.lines ?? []).map((l: any) => (
              <tr key={l.id}><Td>{names.get(l.product_id) ?? '…'}</Td><Td align="right">{l.qty_ordered} {l.unit === 'case' ? (l.qty_ordered === 1 ? t('case') : t('cases')) : ''}</Td>
                <Td align="right" className="text-muted">{l.qty_received}</Td><Td align="right">{l.unit_cost_pence ? formatGBP(l.unit_cost_pence) : '—'}</Td>
                <Td align="right" className="font-medium">{l.unit_cost_pence ? formatGBP(l.unit_cost_pence * l.qty_ordered) : '—'}</Td></tr>
            ))}</tbody>
            <tfoot><tr><Td className="font-semibold">{t("Estimated total (ex VAT)")}</Td><Td /><Td /><Td /><Td align="right" className="font-semibold">{formatGBP(po.estimated_total_pence ?? 0)}</Td></tr></tfoot>
          </Table>
        </Card>
      ))}
    </div>
  );
}

function Suppliers() {
  const toast = useToast();
  const sup = useApi<any[]>('/v1/suppliers');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', email: '', phone: '', account_number: '', order_method: 'email', lead_time_days: '' });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!f.name.trim()) return setErr(t('Enter the supplier’s name'));
    if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) return setErr(t('Enter an email address in the correct format, like name@example.com'));
    if (f.order_method === 'email' && !f.email) return setErr(t('Enter the email address orders should go to'));
    setErr(null);
    try {
      await api('/v1/suppliers', { body: { ...f, name: f.name.trim(), email: f.email || null, phone: f.phone || null, account_number: f.account_number || null,
        lead_time_days: f.lead_time_days ? Number(f.lead_time_days) : null } });
      sup.mutate(); setOpen(false); toast(t('{name} added', { name: f.name }));
      setF({ name: '', email: '', phone: '', account_number: '', order_method: 'email', lead_time_days: '' });
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Card>
      <CardHeader title={t("Suppliers")} description={t("Wholesalers and cash & carries you buy from.")} action={<Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>{t("Add supplier")}</Button>} />
      {sup.isLoading ? <LoadingRows /> : (
        <Table>
          <thead><tr><Th>{t("Name")}</Th><Th>{t("Account")}</Th><Th>{t("Orders by")}</Th><Th>{t("Order days")}</Th><Th align="right">{t("Lead time")}</Th></tr></thead>
          <tbody>{(sup.data ?? []).map((s) => (
            <tr key={s.id}><Td className="font-medium">{s.name}</Td><Td className="font-mono text-xs text-muted">{s.account_number ?? '—'}</Td>
              <Td className="capitalize">{t(s.order_method.replace('_', ' '))}{s.email && <span className="block text-xs text-subtle normal-case">{s.email}</span>}</Td>
              <Td>{s.order_days?.length ? s.order_days.map((d: number) => t(DAYS[d - 1]!)).join(', ') : '—'}</Td>
              <Td align="right">{s.lead_time_days !== null ? t(s.lead_time_days === 1 ? '{n} day' : '{n} days', { n: s.lead_time_days }) : '—'}</Td></tr>
          ))}</tbody>
        </Table>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={t("Add supplier")} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>{t("Cancel")}</Button><Button onClick={save}>{t("Add supplier")}</Button></>}>
        {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
        <Field label={t("Name")} htmlFor="sn"><Input id="sn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("Email")} htmlFor="se"><Input id="se" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label={t("Phone")} htmlFor="sp"><Input id="sp" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label={t("Your account number")} htmlFor="sa"><Input id="sa" value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} /></Field>
          <Field label={t("How you order")} htmlFor="sm"><Select id="sm" value={f.order_method} onChange={(e) => setF({ ...f, order_method: e.target.value })}>
            <option value="email">{t("Email")}</option><option value="portal">{t("Online portal")}</option><option value="phone">{t("Phone")}</option><option value="in_person">{t("In person (cash & carry)")}</option></Select></Field>
          <Field label={t("Delivery lead time (days)")} htmlFor="sl"><Input id="sl" type="number" min={0} value={f.lead_time_days} onChange={(e) => setF({ ...f, lead_time_days: e.target.value })} /></Field>
        </div>
      </Modal>
    </Card>
  );
}
