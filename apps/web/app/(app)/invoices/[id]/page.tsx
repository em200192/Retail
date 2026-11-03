'use client';
import { formatDateUK, formatGBP } from '@retail/shared';
import { ArrowLeft, Ban, CheckCircle2, CircleDashed, PackageCheck, Pencil, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ProductPicker } from '@/components/product-picker';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, LoadingRows, Modal, PageHeader, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useMe } from '@/lib/me';
import { INVOICE_STATUS } from '@/lib/labels';

function matchInfo(l: any): { label: string; tone: 'success' | 'brand' | 'warning' | 'neutral' | 'danger'; icon: React.ReactNode } {
  if (l.match_status === 'ignored') return { label: 'Ignored', tone: 'neutral', icon: <Ban className="size-3" aria-hidden /> };
  if (l.match_status === 'matched_manual') return { label: 'Checked by you', tone: 'success', icon: <CheckCircle2 className="size-3" aria-hidden /> };
  if (l.match_status === 'matched_auto' && l.match_confidence >= 0.99) return { label: 'Known supplier code', tone: 'success', icon: <Sparkles className="size-3" aria-hidden /> };
  if (l.match_status === 'matched_auto' && l.match_confidence >= 0.95) return { label: 'Matched by barcode', tone: 'success', icon: <Sparkles className="size-3" aria-hidden /> };
  if (l.match_status === 'matched_auto') return { label: `Best guess · ${Math.round(l.match_confidence * 100)}%`, tone: 'warning', icon: <CircleDashed className="size-3" aria-hidden /> };
  return { label: 'Needs a product', tone: 'danger', icon: <CircleDashed className="size-3" aria-hidden /> };
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can } = useMe();
  const inv = useApi<any>(`/v1/invoices/${id}`, { refreshInterval: (d) => (d && ['uploaded', 'processing'].includes(d.status) ? 3000 : 0) });
  const suppliers = useApi<any[]>('/v1/suppliers');
  const [editing, setEditing] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const approve = can('invoices.approve');
  const d = inv.data;
  if (inv.isLoading) return <Card><LoadingRows rows={8} /></Card>;
  if (!d) return <ErrorNote error={inv.error} />;
  const open = ['needs_review', 'approved'].includes(d.status);
  const lines: any[] = d.lines;
  const unresolved = lines.filter((l) => l.match_status !== 'ignored' && !l.product_id).length;
  const guesses = lines.filter((l) => l.match_status === 'matched_auto' && l.match_confidence < 0.95).length;
  const linesTotal = lines.reduce((a, l) => a + (l.line_total_pence ?? 0), 0);

  const patchLine = async (lineId: string, body: any) => { await api(`/v1/invoices/${id}/lines/${lineId}`, { method: 'PATCH', body }); inv.mutate(); };
  const post = async () => {
    setBusy(true);
    try { const r = await api(`/v1/invoices/${id}/post`, { body: {} }); toast(`${r.lines_received} lines booked into stock. We’ll remember these supplier codes.`); inv.mutate(); }
    catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };

  return (
    <>
      <Link href="/invoices" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink"><ArrowLeft className="size-4" aria-hidden />All invoices</Link>
      <PageHeader title={`${d.supplier_name ?? 'Supplier invoice'}${d.invoice_number ? ` · ${d.invoice_number}` : ''}`}
        description={<span className="inline-flex items-center gap-2"><Badge tone={INVOICE_STATUS[d.status]?.tone}>{INVOICE_STATUS[d.status]?.label}</Badge>
          {d.invoice_date && <>Dated {formatDateUK(d.invoice_date)}</>}{d.ocr_confidence !== null && <span className="text-subtle">· read with {Math.round(d.ocr_confidence * 100)}% confidence</span>}</span>}
        actions={open && approve && <>
          <Button variant="ghost" onClick={() => setRejecting(true)}>Reject</Button>
          <Button icon={<PackageCheck className="size-4" />} disabled={unresolved > 0} loading={busy} onClick={post}>Book into stock</Button>
        </>} />
      {d.ocr_error && <div role="alert" className="mb-6 rounded-xl border border-danger/30 bg-danger-tint p-4 text-sm text-danger">{d.ocr_error}</div>}
      {['uploaded', 'processing'].includes(d.status) && <Card className="mb-6 p-5 text-sm text-muted">We’re reading this invoice. This usually takes under a minute — the page updates by itself.</Card>}

      {open && (
        <div className="mb-6 grid gap-4 md:grid-cols-3">
          <Card className="p-5"><p className="text-sm text-muted">Lines</p><p className="mt-1 text-2xl font-semibold tabular">{lines.length}</p></Card>
          <Card className={`p-5 ${unresolved ? 'border-danger/40' : ''}`}><p className="text-sm text-muted">Need a product</p>
            <p className={`mt-1 text-2xl font-semibold tabular ${unresolved ? 'text-danger' : 'text-success'}`}>{unresolved}</p></Card>
          <Card className="p-5"><p className="text-sm text-muted">Best guesses to check</p><p className={`mt-1 text-2xl font-semibold tabular ${guesses ? 'text-warning' : ''}`}>{guesses}</p></Card>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-4">
        <Card className="xl:col-span-3">
          <CardHeader title="Lines" description="Tick off best guesses or pick the right product. Each fix teaches Counter for next time." />
          <Table>
            <thead><tr><Th>On the invoice</Th><Th>Matched to</Th><Th align="right">Qty</Th><Th align="right">Pack</Th><Th align="right">Cost</Th><Th align="right">Line</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>{lines.map((l) => {
              const m = matchInfo(l);
              return (
                <tr key={l.id} className={l.match_status === 'ignored' ? 'opacity-55' : ''}>
                  <Td><p className="font-medium">{l.description}</p>
                    <p className="font-mono text-xs text-subtle">{[l.supplier_code && `code ${l.supplier_code}`, l.barcode].filter(Boolean).join(' · ')}
                      {l.is_pmp && <Badge tone="accent" className="ml-2 font-sans">PMP {formatGBP(l.pmp_price_pence)}</Badge>}</p></Td>
                  <Td><p>{l.product_name ?? <span className="text-subtle">—</span>}</p><Badge tone={m.tone} className="mt-1">{m.icon}{m.label}</Badge></Td>
                  <Td align="right">{l.quantity ?? '—'}</Td>
                  <Td align="right" className="text-muted">{l.pack_size ? `×${l.pack_size}` : '—'}</Td>
                  <Td align="right">{l.unit_cost_pence !== null ? formatGBP(l.unit_cost_pence) : '—'}</Td>
                  <Td align="right" className="font-medium">{l.line_total_pence !== null ? formatGBP(l.line_total_pence) : '—'}</Td>
                  <Td align="right">{open && approve && (
                    <div className="flex justify-end gap-1">
                      {l.match_status === 'matched_auto' && l.match_confidence < 0.95 && <Button size="sm" variant="secondary" onClick={() => patchLine(l.id, { product_id: l.product_id })}>Confirm</Button>}
                      <Button size="sm" variant="ghost" aria-label={`Edit line ${l.line_no}`} onClick={() => setEditing(l)}><Pencil className="size-4" /></Button>
                    </div>)}</Td>
                </tr>
              );
            })}</tbody>
          </Table>
        </Card>
        <Card className="h-fit">
          <CardHeader title="Totals" />
          <dl className="space-y-2 px-5 pb-5 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Net</dt><dd className="tabular">{formatGBP(d.subtotal_pence ?? 0)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">VAT</dt><dd className="tabular">{formatGBP(d.vat_pence ?? 0)}</dd></div>
            <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>Total</dt><dd className="tabular">{formatGBP(d.total_pence ?? 0)}</dd></div>
            {d.subtotal_pence !== null && linesTotal !== d.subtotal_pence && (
              <p className="rounded-lg bg-warning-tint p-2 text-xs text-warning">Lines add up to {formatGBP(linesTotal)}, which doesn’t match the printed net. Check for missed lines.</p>
            )}
          </dl>
          {open && approve && (
            <div className="border-t border-line px-5 py-4">
              <Field label="Supplier" htmlFor="sup"><Select id="sup" value={d.supplier_id ?? ''} onChange={async (e) => {
                await api(`/v1/invoices/${id}`, { method: 'PATCH', body: { supplier_id: e.target.value } }); inv.mutate(); }}>
                <option value="" disabled>Choose…</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            </div>
          )}
        </Card>
      </div>

      {editing && <LineEditor line={editing} onClose={() => setEditing(null)} onSave={async (body) => { await patchLine(editing.id, body); setEditing(null); }} />}
      <Modal open={rejecting} onClose={() => setRejecting(false)} title="Reject this invoice?" description="Nothing is booked into stock. You can upload it again later."
        footer={<><Button variant="secondary" onClick={() => setRejecting(false)}>Cancel</Button><Button variant="danger" disabled={!reason} onClick={async () => {
          await api(`/v1/invoices/${id}/reject`, { body: { reason } }); setRejecting(false); inv.mutate(); toast('Invoice rejected'); }}>Reject invoice</Button></>}>
        <Field label="Why?" htmlFor="rr"><Input id="rr" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong shop, duplicate, unreadable…" /></Field>
      </Modal>
    </>
  );
}

function LineEditor({ line, onClose, onSave }: { line: any; onClose: () => void; onSave: (body: any) => Promise<void> }) {
  const [product, setProduct] = useState<{ id: string; name: string } | null>(line.product_id ? { id: line.product_id, name: line.product_name } : null);
  const [qty, setQty] = useState(String(line.quantity ?? ''));
  const [pack, setPack] = useState(String(line.pack_size ?? 1));
  return (
    <Modal open onClose={onClose} title="Check this line" description={line.description}
      footer={<><Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => onSave({ ignore: true })}>Not stock (ignore)</Button>
        <Button onClick={() => onSave({ product_id: product?.id, quantity: Number(qty) || undefined, pack_size: Number(pack) || undefined })} disabled={!product}>Save</Button></>}>
      <Field label="Our product" htmlFor="lp"><ProductPicker id="lp" value={product} onChange={setProduct} /></Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Quantity (as printed)" htmlFor="lq"><Input id="lq" type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label="Units per case" htmlFor="lk" hint="e.g. 24 for 24 × 500ml"><Input id="lk" type="number" min={1} value={pack} onChange={(e) => setPack(e.target.value)} /></Field>
      </div>
      <p className="text-sm text-muted">We’ll book in <span className="font-semibold text-ink tabular">{(Number(qty) || 0) * (Number(pack) || 1)}</span> units.</p>
    </Modal>
  );
}
