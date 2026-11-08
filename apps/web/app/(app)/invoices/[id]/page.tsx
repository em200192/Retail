'use client';
import { formatGBP, productNameFromInvoice, VAT_LABELS } from '@retail/shared';
import { formatDateUK } from '@/lib/format';
import { ArrowLeft, Ban, CheckCircle2, CircleDashed, PackageCheck, PackagePlus, Pencil, Sparkles, Wand2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ProductPicker } from '@/components/product-picker';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, LoadingRows, Modal, MoneyInput, PageHeader, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useMe } from '@/lib/me';
import { INVOICE_STATUS } from '@/lib/labels';
import { t } from '@/lib/i18n';

function matchInfo(l: any): { label: string; tone: 'success' | 'brand' | 'warning' | 'neutral' | 'danger'; icon: React.ReactNode } {
  if (l.match_status === 'ignored') return { label: t('Ignored'), tone: 'neutral', icon: <Ban className="size-3" aria-hidden /> };
  if (l.match_status === 'matched_manual') return { label: t('Checked by you'), tone: 'success', icon: <CheckCircle2 className="size-3" aria-hidden /> };
  if (l.match_status === 'new_product_created') return { label: t('New product'), tone: 'brand', icon: <PackagePlus className="size-3" aria-hidden /> };
  if (l.match_status === 'matched_auto' && l.match_confidence >= 0.99) return { label: t('Known supplier code'), tone: 'success', icon: <Sparkles className="size-3" aria-hidden /> };
  if (l.match_status === 'matched_auto' && l.match_confidence >= 0.95) return { label: t('Matched by barcode'), tone: 'success', icon: <Sparkles className="size-3" aria-hidden /> };
  if (l.match_status === 'matched_auto') return { label: t('Best guess · {n}%', { n: Math.round(l.match_confidence * 100) }), tone: 'warning', icon: <CircleDashed className="size-3" aria-hidden /> };
  return { label: t('Needs a product'), tone: 'danger', icon: <CircleDashed className="size-3" aria-hidden /> };
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can } = useMe();
  const inv = useApi<any>(`/v1/invoices/${id}`, { refreshInterval: (d) => (d && ['uploaded', 'processing'].includes(d.status) ? 3000 : 0) });
  const suppliers = useApi<any[]>('/v1/suppliers');
  const [editing, setEditing] = useState<any | null>(null);
  const [creating, setCreating] = useState<any | null>(null);
  const [bulk, setBulk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const approve = can('invoices.approve');
  const d = inv.data;
  if (inv.isLoading) return <Card><LoadingRows rows={8} /></Card>;
  if (!d) return <ErrorNote error={inv.error} />;
  const open = ['needs_review', 'approved'].includes(d.status);
  // The worker moves an invoice to 'processing' within seconds. Still 'uploaded' after 2 minutes = reading isn't running.
  const stuck = d.status === 'uploaded' && Date.now() - new Date(d.created_at).getTime() > 2 * 60 * 1000;
  const rejectable = open || stuck || d.status === 'failed';
  const lines: any[] = d.lines;
  const unresolved = lines.filter((l) => l.match_status !== 'ignored' && !l.product_id).length;
  const guesses = lines.filter((l) => l.match_status === 'matched_auto' && l.match_confidence < 0.95).length;
  const linesTotal = lines.reduce((a, l) => a + (l.line_total_pence ?? 0), 0);

  const patchLine = async (lineId: string, body: any) => {
    try { await api(`/v1/invoices/${id}/lines/${lineId}`, { method: 'PATCH', body }); } catch (e) { toast((e as Error).message, 'danger'); }
    inv.mutate();
  };
  const post = async () => {
    setBusy(true);
    try { const r = await api(`/v1/invoices/${id}/post`, { body: {} }); toast(t('{n} products booked into stock. We’ll remember these supplier codes.', { n: r.lines_received })); inv.mutate(); }
    catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };

  return (
    <>
      <Link href="/invoices" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t("All invoices")}</Link>
      <PageHeader title={`${d.supplier_name ?? t('Supplier invoice')}${d.invoice_number ? ` · ${d.invoice_number}` : ''}`}
        description={<span className="inline-flex items-center gap-2"><Badge tone={INVOICE_STATUS[d.status]?.tone}>{t(INVOICE_STATUS[d.status]?.label ?? '')}</Badge>
          {d.invoice_date && <>{t('Dated {date}', { date: formatDateUK(d.invoice_date) })}</>}{d.ocr_confidence !== null && <span className="text-subtle">· {t('read with {n}% confidence', { n: Math.round(d.ocr_confidence * 100) })}</span>}</span>}
        actions={rejectable && approve && <>
          <Button variant="ghost" onClick={() => setRejecting(true)}>{t("Reject")}</Button>
          {open && unresolved > 0 && can('products.edit') && can('prices.edit') && <Button variant="secondary" icon={<Wand2 className="size-4" />} loading={bulk} onClick={async () => {
            setBulk(true);
            try { const r = await api(`/v1/invoices/${id}/create-missing-products`, { body: {} }); toast(t('{n} new products created from this invoice', { n: r.created.length })); inv.mutate(); }
            catch (e) { toast((e as Error).message, 'danger'); } finally { setBulk(false); }
          }}>{t('Create all missing products')}</Button>}
          {open && <Button icon={<PackageCheck className="size-4" />} disabled={unresolved > 0} loading={busy} onClick={post}>{t("Book into stock")}</Button>}
        </>} />
      {d.ocr_error && <div role="alert" className="mb-6 rounded-xl border border-danger/30 bg-danger-tint p-4 text-sm text-danger">{t(d.ocr_error)}</div>}
      {stuck && <div role="alert" className="mb-6 rounded-xl border border-warning/30 bg-warning-tint p-4 text-sm text-warning">{t("Counter hasn’t been able to start reading this invoice. Automatic reading may be switched off or busy. Try uploading it again later, or reject it and book the stock in with “Goods in” on the Stock page.")}</div>}
      {!stuck && ['uploaded', 'processing'].includes(d.status) && <Card className="mb-6 p-5 text-sm text-muted">{t("We’re reading this invoice. This usually takes under a minute — the page updates by itself.")}{d.ocr_progress && <span className="mt-1 block font-medium text-ink" role="status">{t(d.ocr_progress.text, d.ocr_progress.vars)}</span>}</Card>}

      {open && (
        <div className="mb-6 grid gap-4 md:grid-cols-3">
          <Card className="p-5"><p className="text-sm text-muted">{t("Lines")}</p><p className="mt-1 text-2xl font-semibold tabular">{lines.length}</p></Card>
          <Card className={`p-5 ${unresolved ? 'border-danger/40' : ''}`}><p className="text-sm text-muted">{t("Need a product")}</p>
            <p className={`mt-1 text-2xl font-semibold tabular ${unresolved ? 'text-danger' : 'text-success'}`}>{unresolved}</p></Card>
          <Card className="p-5"><p className="text-sm text-muted">{t("Best guesses to check")}</p><p className={`mt-1 text-2xl font-semibold tabular ${guesses ? 'text-warning' : ''}`}>{guesses}</p></Card>
        </div>
      )}

      {(lines.length > 0 || open) && <div className="grid grid-cols-1 gap-6 xl:grid-cols-4">
        <Card className="xl:col-span-3">
          <CardHeader title={t("Lines")} description={t("Tick off best guesses or pick the right product. Each fix teaches Counter for next time.")} />
          <Table>
            <thead><tr><Th>{t("On the invoice")}</Th><Th>{t("Matched to")}</Th><Th align="right">{t("Qty")}</Th><Th align="right">{t("Pack")}</Th><Th align="right">{t("Cost")}</Th><Th align="right">{t("Line")}</Th><Th align="right">{t("RRP")}</Th><Th><span className="sr-only">{t("Actions")}</span></Th></tr></thead>
            <tbody>{lines.map((l) => {
              const m = matchInfo(l);
              return (
                <tr key={l.id} className={l.match_status === 'ignored' ? 'opacity-55' : ''}>
                  <Td><p className="font-medium">{l.description}</p>
                    <p className="text-xs text-subtle tabular-nums">{[l.supplier_code && `${t('code')} ${l.supplier_code}`, l.barcode, l.vat_code && `${t('VAT')} ${l.vat_code}`].filter(Boolean).join(' · ')}
                      {l.is_pmp && <Badge tone="accent" className="ms-2 font-sans">{t('PMP')} <bdi>{formatGBP(l.pmp_price_pence)}</bdi></Badge>}</p></Td>
                  <Td><p>{l.product_name ?? <span className="text-subtle">—</span>}</p><Badge tone={m.tone} className="mt-1">{m.icon}{m.label}</Badge></Td>
                  <Td align="right">{l.quantity ?? '—'}</Td>
                  <Td align="right" className="text-muted">{l.pack_size ? `×${l.pack_size}` : '—'}</Td>
                  <Td align="right">{l.unit_cost_pence !== null ? formatGBP(l.unit_cost_pence) : '—'}</Td>
                  <Td align="right" className="font-medium">{l.line_total_pence !== null ? formatGBP(l.line_total_pence) : '—'}</Td>
                  <Td align="right" className="text-muted">{l.rrp_pence != null ? formatGBP(l.rrp_pence) : '—'}</Td>
                  <Td align="right">{open && approve && (
                    <div className="flex justify-end gap-1">
                      {l.match_status === 'matched_auto' && l.match_confidence < 0.95 && <Button size="sm" variant="secondary" onClick={() => patchLine(l.id, { product_id: l.product_id })}>{t("Confirm")}</Button>}
                      {!l.product_id && l.match_status !== 'ignored' && can('products.edit') && <Button size="sm" variant="secondary" icon={<PackagePlus className="size-4" />} onClick={() => setCreating(l)}>{t('Create product')}</Button>}
                      <Button size="sm" variant="ghost" aria-label={t('Edit line {n}', { n: l.line_no })} onClick={() => setEditing(l)}><Pencil className="size-4" /></Button>
                    </div>)}</Td>
                </tr>
              );
            })}</tbody>
          </Table>
        </Card>
        <Card className="h-fit">
          <CardHeader title={t("Totals")} />
          <dl className="space-y-2 px-5 pb-5 text-sm">
            <div className="flex justify-between"><dt className="text-muted">{t("Net")}</dt><dd className="tabular">{formatGBP(d.subtotal_pence ?? 0)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">VAT</dt><dd className="tabular">{formatGBP(d.vat_pence ?? 0)}</dd></div>
            <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>{t("Total")}</dt><dd className="tabular">{formatGBP(d.total_pence ?? 0)}</dd></div>
            {d.subtotal_pence !== null && linesTotal !== d.subtotal_pence && (
              <p className="rounded-lg bg-warning-tint p-2 text-xs text-warning">{t('Lines add up to {amount}, which doesn’t match the printed net. Check for missed lines.', { amount: formatGBP(linesTotal) })}</p>
            )}
          </dl>
          {open && approve && (
            <div className="border-t border-line px-5 py-4">
              <Field label={t("Supplier")} htmlFor="sup"><Select id="sup" value={d.supplier_id ?? ''} onChange={async (e) => {
                try { await api(`/v1/invoices/${id}`, { method: 'PATCH', body: { supplier_id: e.target.value } }); } catch (err) { toast((err as Error).message, 'danger'); }
                inv.mutate(); }}>
                <option value="" disabled>{t("Choose…")}</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            </div>
          )}
        </Card>
      </div>}

      {creating && <CreateProductModal line={creating} invoiceId={id} onClose={() => setCreating(null)} onDone={(name) => { setCreating(null); inv.mutate(); toast(t('{name} added to your products', { name })); }} />}
      {editing && <LineEditor line={editing} onClose={() => setEditing(null)} onSave={async (body) => { await patchLine(editing.id, body); setEditing(null); }} />}
      <Modal open={rejecting} onClose={() => setRejecting(false)} title={t("Reject this invoice?")} description={t("Nothing is booked into stock. You can upload it again later.")}
        footer={<><Button variant="secondary" onClick={() => setRejecting(false)}>{t("Cancel")}</Button><Button variant="danger" disabled={!reason} onClick={async () => {
          try { await api(`/v1/invoices/${id}/reject`, { body: { reason } }); toast(t('Invoice rejected')); } catch (e) { toast((e as Error).message, 'danger'); }
          setRejecting(false); inv.mutate(); }}>{t("Reject invoice")}</Button></>}>
        <Field label={t("Why?")} htmlFor="rr"><Input id="rr" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("Wrong shop, duplicate, unreadable…")} /></Field>
      </Modal>
    </>
  );
}

function LineEditor({ line, onClose, onSave }: { line: any; onClose: () => void; onSave: (body: any) => Promise<void> }) {
  const [product, setProduct] = useState<{ id: string; name: string } | null>(line.product_id ? { id: line.product_id, name: line.product_name } : null);
  const [qty, setQty] = useState(String(line.quantity ?? ''));
  const [pack, setPack] = useState(String(line.pack_size ?? 1));
  return (
    <Modal open onClose={onClose} title={t("Check this line")} description={line.description}
      footer={<><Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => onSave({ ignore: true })}>{t("Not stock (ignore)")}</Button>
        <Button onClick={() => onSave({ product_id: product?.id, quantity: Number(qty) || undefined, pack_size: Number(pack) || undefined })} disabled={!product}>{t("Save")}</Button></>}>
      <Field label={t("Our product")} htmlFor="lp"><ProductPicker id="lp" value={product} onChange={setProduct} /></Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label={t("Quantity (as printed)")} htmlFor="lq"><Input id="lq" type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label={t("Units per case")} htmlFor="lk" hint={t("e.g. 24 for 24 × 500ml")}><Input id="lk" type="number" min={1} value={pack} onChange={(e) => setPack(e.target.value)} /></Field>
      </div>
      <p className="text-sm text-muted">{t("We’ll book in")}{" "}<span className="font-semibold text-ink tabular">{(Number(qty) || 0) * (Number(pack) || 1)}</span>{" "}{t("units.")}</p>
    </Modal>
  );
}

function CreateProductModal({ line, invoiceId, onClose, onDone }: { line: any; invoiceId: string; onClose: () => void; onDone: (name: string) => void }) {
  const cats = useApi<any[]>('/v1/categories');
  const [name, setName] = useState(productNameFromInvoice(line.description));
  const [vat, setVat] = useState<string>(line.vat_code ?? 'S');
  const [cat, setCat] = useState('');
  const [price, setPrice] = useState<number | null>(line.is_pmp && line.pmp_price_pence ? line.pmp_price_pence : line.rrp_pence ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unitCost = line.unit_cost_pence != null ? Math.round(line.unit_cost_pence / (line.pack_size || 1)) : null;
  const net = price != null ? (vat === 'S' ? price / 1.2 : vat === 'R' ? price / 1.05 : price) : null;
  const margin = net && unitCost != null ? ((net - unitCost) / net) * 100 : null;
  const submit = async () => {
    if (!name.trim()) return setErr(t('Enter a product name'));
    setBusy(true); setErr(null);
    try {
      const r = await api(`/v1/invoices/${invoiceId}/lines/${line.id}/create-product`, { body: { name: name.trim(), vat_code: vat, category_id: cat || null, price_pence: price } });
      onDone(r.name);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={t('Add as a new product')} description={line.description}
      footer={<><Button variant="secondary" onClick={onClose}>{t('Cancel')}</Button><Button loading={busy} onClick={submit}>{t('Create product')}</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <Field label={t('Product name')} htmlFor="cpn" hint={t('As customers see it on the receipt.')}><Input id="cpn" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('VAT rate')} htmlFor="cpv"><Select id="cpv" value={vat} onChange={(e) => setVat(e.target.value)}>
          {Object.entries(VAT_LABELS).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field>
        <Field label={t('Category')} htmlFor="cpc"><Select id="cpc" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">{t('No category')}</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label={t('Shelf price (incl. VAT)')} htmlFor="cpp" hint={line.is_pmp ? t('Price-marked: the till never charges more than {amount}.', { amount: formatGBP(line.pmp_price_pence) }) : undefined}>
          <MoneyInput id="cpp" value={price} onChange={setPrice} /></Field>
        <div className="rounded-lg bg-surface p-3 text-sm">
          <p className="text-muted">{t('Cost per unit')}</p><p className="font-semibold tabular">{unitCost != null ? formatGBP(unitCost) : '—'}</p>
          {margin != null && <p className={margin < 15 ? 'text-danger' : 'text-success'}>{t('Margin {n}%', { n: margin.toFixed(0) })}</p>}
        </div>
      </div>
      {line.barcode && <p className="text-sm text-muted">{t('Barcode {code} will be added so the till can scan it.', { code: line.barcode })}</p>}
    </Modal>
  );
}
