'use client';
import { formatDateUK, formatGBP } from '@retail/shared';
import { AlertTriangle, Check, Inbox, ListChecks, Plus, Send, Sparkles, Truck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ProductPicker } from '@/components/product-picker';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, LoadingRows, Modal, PageHeader, Select, Table, Tabs, Td, Th, useToast } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useMe } from '@/lib/me';

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
      <PageHeader title="Ordering" description="Staff requests, low stock and your own additions all land on one shopping list. Turn it into orders in one click." />
      {tab && <Tabs value={tab} onChange={setTab} tabs={[
        ...(manage ? [{ id: 'list' as const, label: 'Shopping list' }] : []),
        { id: 'requests', label: manage ? 'Staff requests' : 'My requests', count: manage ? pending.length : undefined },
        ...(can('purchasing.order') ? [{ id: 'orders' as const, label: 'Purchase orders' }] : []),
        ...(can('suppliers.manage') ? [{ id: 'suppliers' as const, label: 'Suppliers' }] : []),
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
    await api(`/v1/purchase-requests/${id}/review`, { body: { decision } });
    toast(decision === 'approve' ? 'Added to the shopping list' : 'Request declined'); reload();
  };
  return (
    <Card>
      <CardHeader title={manage ? 'What your team needs' : 'Your requests'} description="Staff can ask from the till app: “We need this”."
        action={<Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New request</Button>} />
      {loading && !data ? <LoadingRows /> : !data?.length ? <EmptyState icon={<Inbox className="size-6" />} title="No requests">When staff spot an empty shelf, their request appears here.</EmptyState> : (
        <Table>
          <thead><tr><Th>Item</Th><Th align="right">Qty</Th><Th>Asked by</Th><Th>When</Th><Th>Status</Th>{manage && <Th><span className="sr-only">Actions</span></Th>}</tr></thead>
          <tbody>{data.map((r) => (
            <tr key={r.id}>
              <Td><p className="font-medium">{r.product_name ?? r.free_text}</p>{r.note && <p className="text-xs text-subtle">“{r.note}”</p>}</Td>
              <Td align="right">{r.quantity ?? '—'}</Td>
              <Td>{r.requested_by_name}</Td>
              <Td className="text-muted">{formatDateUK(r.created_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</Td>
              <Td>{r.priority === 'urgent' && r.status === 'pending' ? <Badge tone="danger"><AlertTriangle className="size-3" aria-hidden />Urgent</Badge>
                : <Badge tone={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'neutral' : 'brand'}>{r.status[0].toUpperCase() + r.status.slice(1)}</Badge>}</Td>
              {manage && <Td align="right">{r.status === 'pending' && (
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => review(r.id, 'reject')}>Decline</Button>
                  <Button size="sm" icon={<Check className="size-4" />} onClick={() => review(r.id, 'approve')}>Add to list</Button>
                </div>)}</Td>}
            </tr>
          ))}</tbody>
        </Table>
      )}
      <NewRequest open={open} onClose={() => setOpen(false)} branchId={branchId!} onDone={() => { reload(); toast('Request sent to the manager'); }} />
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
    if (!product && !text.trim()) return setErr('Choose a product or describe what you need');
    try {
      await api('/v1/purchase-requests', { body: { branch_id: branchId, product_id: product?.id ?? null, free_text: product ? null : text,
        quantity: qty ? Number(qty) : null, priority: urgent ? 'urgent' : 'normal' } });
      onDone(); onClose(); setProduct(null); setText(''); setQty(''); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title="We need this" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit}>Send request</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <Field label="Product" htmlFor="rp"><ProductPicker id="rp" value={product} onChange={setProduct} /></Field>
      {!product && <Field label="Or describe it" htmlFor="rt" hint="For things we don’t stock yet."><Input id="rt" value={text} onChange={(e) => setText(e.target.value)} /></Field>}
      <div className="grid grid-cols-2 gap-4 items-end">
        <Field label="How many? (optional)" htmlFor="rq"><Input id="rq" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} className="size-4 accent-[var(--color-danger)]" />It’s urgent</label>
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
  for (const i of active) groups.set(i.supplier_name ?? 'No supplier yet', [...(groups.get(i.supplier_name ?? 'No supplier yet') ?? []), i]);
  const est = (i: any) => (i.estimated_unit_cost_pence ?? 0) * i.quantity;
  const update = async (id: string, body: any) => { await api(`/v1/purchase-list/items/${id}`, { method: 'PATCH', body }); list.mutate(); };

  return (
    <div className="space-y-4">
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-semibold">{active.length} items on the list · {approved.length} ready to order</p>
          <p className="text-sm text-muted">Estimated cost <span className="tabular font-medium text-ink">{formatGBP(active.reduce((a, i) => a + est(i), 0))}</span> ex VAT</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Sparkles className="size-4" />} loading={busy === 'gen'} onClick={async () => {
            setBusy('gen'); const r = await api('/v1/purchase-list/generate', { body: { branch_id: branchId } }); setBusy(null); list.mutate();
            toast(r.added.length ? `${r.added.length} low-stock items added` : 'Nothing new is running low');
          }}>Add low-stock items</Button>
          <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add item</Button>
          {can('purchasing.order') && <Button icon={<Truck className="size-4" />} disabled={!approved.length} loading={busy === 'po'} onClick={async () => {
            setBusy('po');
            try { const r = await api('/v1/purchase-orders/from-list', { body: { branch_id: branchId } }); toast(`${r.length} purchase order${r.length > 1 ? 's' : ''} created`); list.mutate(); }
            catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(null); }
          }}>Create orders</Button>}
        </div>
      </Card>
      {list.isLoading ? <Card><LoadingRows /></Card> : active.length === 0 ? (
        <Card><EmptyState icon={<ListChecks className="size-6" />} title="Your shopping list is empty">Add low-stock items or approve staff requests to fill it.</EmptyState></Card>
      ) : [...groups.entries()].map(([supplier, rows]) => (
        <Card key={supplier}>
          <CardHeader title={supplier} description={`${rows.length} items · about ${formatGBP(rows.reduce((a, i) => a + est(i), 0))}`} />
          <Table>
            <thead><tr><Th>Item</Th><Th>Why</Th><Th align="right">Qty</Th><Th>Supplier</Th><Th align="right">Est. cost</Th><Th>Status</Th></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id}>
                <Td><p className="font-medium">{i.product_name ?? i.free_text}</p>{i.ai_reason && <p className="text-xs text-subtle">{i.ai_reason}</p>}</Td>
                <Td><Badge tone={SOURCE[i.source]?.tone}>{SOURCE[i.source]?.label}</Badge></Td>
                <Td align="right"><label className="sr-only" htmlFor={`q-${i.id}`}>Quantity</label>
                  <Input id={`q-${i.id}`} type="number" min={1} defaultValue={i.quantity} className="ml-auto h-8 w-20 text-right"
                    onBlur={(e) => Number(e.target.value) !== i.quantity && Number(e.target.value) > 0 && update(i.id, { quantity: Number(e.target.value) })} /></Td>
                <Td><label className="sr-only" htmlFor={`s-${i.id}`}>Supplier</label>
                  <Select id={`s-${i.id}`} value={i.supplier_id ?? ''} className="h-8 w-36" onChange={(e) => update(i.id, { supplier_id: e.target.value || null })}>
                    <option value="">Choose…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Td>
                <Td align="right" className="text-muted">{i.estimated_unit_cost_pence ? formatGBP(est(i)) : '—'}</Td>
                <Td>{i.status === 'approved' ? (
                  <button onClick={() => update(i.id, { status: 'pending' })} className="inline-flex"><Badge tone="success"><Check className="size-3" aria-hidden />Approved</Badge></button>
                ) : (
                  <div className="flex gap-1">
                    <Button size="sm" onClick={() => update(i.id, { status: 'approved' })}>Approve</Button>
                    <Button size="sm" variant="ghost" aria-label="Remove from list" onClick={() => update(i.id, { status: 'rejected' })}><X className="size-4" /></Button>
                  </div>
                )}</Td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>
      ))}
      <AddItem open={adding} onClose={() => setAdding(false)} branchId={branchId!} onDone={() => { list.mutate(); toast('Added to the list'); }} />
    </div>
  );
}

function AddItem({ open, onClose, branchId, onDone }: { open: boolean; onClose: () => void; branchId: string; onDone: () => void }) {
  const [product, setProduct] = useState<{ id: string; name: string } | null>(null);
  const [qty, setQty] = useState('1');
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!product) return setErr('Choose a product');
    try { await api('/v1/purchase-list/items', { body: { branch_id: branchId, product_id: product.id, quantity: Number(qty) || 1 } }); onDone(); onClose(); setProduct(null); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add to shopping list" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit}>Add</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <Field label="Product" htmlFor="ap"><ProductPicker id="ap" value={product} onChange={setProduct} /></Field>
      <Field label="Quantity (units)" htmlFor="aq" hint="We round up to whole cases when the supplier sells by the case."><Input id="aq" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
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
  if (!pos.data?.length) return <Card><EmptyState icon={<Truck className="size-6" />} title="No purchase orders yet">Approve items on the shopping list, then choose “Create orders”.</EmptyState></Card>;
  return (
    <div className="space-y-4">
      {pos.data.map((po) => (
        <Card key={po.id}>
          <CardHeader title={<span className="flex items-center gap-2">{po.supplier_name}<span className="font-mono text-xs text-subtle">{po.po_number}</span></span>}
            description={`Created ${formatDateUK(po.created_at)}${po.sent_at ? ` · sent ${formatDateUK(po.sent_at)} by ${po.sent_via}` : ''}`}
            action={<div className="flex items-center gap-2"><Badge tone={PO_STATUS[po.status]}>{po.status.replace('_', ' ')}</Badge>
              {po.status === 'draft' && <Button size="sm" icon={<Send className="size-4" />} onClick={async () => { await api(`/v1/purchase-orders/${po.id}/send`, { body: {} }); pos.mutate(); toast('Order sent to supplier'); }}>Send</Button>}</div>} />
          <Table>
            <thead><tr><Th>Product</Th><Th align="right">Ordered</Th><Th align="right">Received</Th><Th align="right">Cost each</Th><Th align="right">Line</Th></tr></thead>
            <tbody>{(po.lines ?? []).map((l: any) => (
              <tr key={l.id}><Td>{names.get(l.product_id) ?? '…'}</Td><Td align="right">{l.qty_ordered} {l.unit === 'case' ? (l.qty_ordered === 1 ? 'case' : 'cases') : ''}</Td>
                <Td align="right" className="text-muted">{l.qty_received}</Td><Td align="right">{l.unit_cost_pence ? formatGBP(l.unit_cost_pence) : '—'}</Td>
                <Td align="right" className="font-medium">{l.unit_cost_pence ? formatGBP(l.unit_cost_pence * l.qty_ordered) : '—'}</Td></tr>
            ))}</tbody>
            <tfoot><tr><Td className="font-semibold">Estimated total (ex VAT)</Td><Td /><Td /><Td /><Td align="right" className="font-semibold">{formatGBP(po.estimated_total_pence ?? 0)}</Td></tr></tfoot>
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
  const save = async () => {
    await api('/v1/suppliers', { body: { ...f, email: f.email || null, phone: f.phone || null, account_number: f.account_number || null,
      lead_time_days: f.lead_time_days ? Number(f.lead_time_days) : null } });
    sup.mutate(); setOpen(false); toast(`${f.name} added`);
  };
  return (
    <Card>
      <CardHeader title="Suppliers" description="Wholesalers and cash & carries you buy from." action={<Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Add supplier</Button>} />
      {sup.isLoading ? <LoadingRows /> : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Account</Th><Th>Orders by</Th><Th>Order days</Th><Th align="right">Lead time</Th></tr></thead>
          <tbody>{(sup.data ?? []).map((s) => (
            <tr key={s.id}><Td className="font-medium">{s.name}</Td><Td className="font-mono text-xs text-muted">{s.account_number ?? '—'}</Td>
              <Td className="capitalize">{s.order_method.replace('_', ' ')}{s.email && <span className="block text-xs text-subtle normal-case">{s.email}</span>}</Td>
              <Td>{s.order_days?.length ? s.order_days.map((d: number) => DAYS[d - 1]).join(', ') : '—'}</Td>
              <Td align="right">{s.lead_time_days !== null ? `${s.lead_time_days} day${s.lead_time_days === 1 ? '' : 's'}` : '—'}</Td></tr>
          ))}</tbody>
        </Table>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Add supplier" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} disabled={!f.name}>Add supplier</Button></>}>
        <Field label="Name" htmlFor="sn"><Input id="sn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Email" htmlFor="se"><Input id="se" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Phone" htmlFor="sp"><Input id="sp" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Your account number" htmlFor="sa"><Input id="sa" value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} /></Field>
          <Field label="How you order" htmlFor="sm"><Select id="sm" value={f.order_method} onChange={(e) => setF({ ...f, order_method: e.target.value })}>
            <option value="email">Email</option><option value="portal">Online portal</option><option value="phone">Phone</option><option value="in_person">In person (cash & carry)</option></Select></Field>
          <Field label="Delivery lead time (days)" htmlFor="sl"><Input id="sl" type="number" min={0} value={f.lead_time_days} onChange={(e) => setF({ ...f, lead_time_days: e.target.value })} /></Field>
        </div>
      </Modal>
    </Card>
  );
}
