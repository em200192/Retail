'use client';
import { formatDateTimeUK, formatGBP, VAT_LABELS } from '@retail/shared';
import { ArrowLeft, Barcode, Plus, Tag, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, LoadingRows, Modal, MoneyInput, PageHeader, Select, Table, Td, Th, Toggle, useToast } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useMe } from '@/lib/me';

const AGE_OPTIONS = [{ v: '', l: 'No age restriction' }, { v: '16', l: '16+ (e.g. lottery, energy drinks policy)' }, { v: '18', l: '18+ (alcohol, tobacco, knives, solvents)' }, { v: '21', l: '21+ (store policy)' }];

const empty = { name: '', brand: '', size_text: '', category_id: '', vat_code: 'S', min_age: '', sku: '', track_stock: true, track_expiry: false,
  sold_by_weight: false, reorder_point: '', reorder_qty: '', is_active: true };

export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const router = useRouter();
  const toast = useToast();
  const { can, me } = useMe();
  const product = useApi<any>(isNew ? null : `/v1/products/${id}`);
  const history = useApi<any[]>(isNew ? null : `/v1/products/${id}/prices`);
  const cats = useApi<any[]>('/v1/categories');
  const levels = useApi<any[]>('/v1/price-levels');
  const [f, setF] = useState<any>(empty);
  const [price, setPrice] = useState<number | null>(null);
  const [barcode, setBarcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [priceOpen, setPriceOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const editable = can('products.edit');

  useEffect(() => {
    const p = product.data;
    if (!p) return;
    setF({ name: p.name, brand: p.brand ?? '', size_text: p.size_text ?? '', category_id: p.category_id ?? '', vat_code: p.vat_code,
      min_age: p.min_age ? String(p.min_age) : '', sku: p.sku ?? '', track_stock: p.track_stock, track_expiry: p.track_expiry,
      sold_by_weight: p.sold_by_weight, reorder_point: p.reorder_point ?? '', reorder_qty: p.reorder_qty ?? '', is_active: p.is_active });
  }, [product.data]);

  const onCategory = (catId: string) => {
    const c = cats.data?.find((x) => x.id === catId);
    setF({ ...f, category_id: catId, ...(isNew && c?.default_vat_code ? { vat_code: c.default_vat_code } : {}),
      ...(isNew && c?.default_min_age ? { min_age: String(c.default_min_age) } : {}) });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return setErr('Enter a product name');
    setBusy(true); setErr(null);
    const body: any = {
      name: f.name.trim(), brand: f.brand || null, size_text: f.size_text || null, category_id: f.category_id || null, vat_code: f.vat_code,
      min_age: f.min_age ? Number(f.min_age) : null, sku: f.sku || null, track_stock: f.track_stock, track_expiry: f.track_expiry,
      sold_by_weight: f.sold_by_weight, reorder_point: f.reorder_point === '' ? null : Number(f.reorder_point),
      reorder_qty: f.reorder_qty === '' ? null : Number(f.reorder_qty),
    };
    try {
      if (isNew) {
        const created = await api('/v1/products', { body: { ...body, price_pence: price ?? undefined,
          barcodes: barcode ? [{ barcode, barcode_type: barcode.length === 8 ? 'EAN8' : 'EAN13', is_primary: true }] : [] } });
        toast(`${created.name} added`);
        router.replace(`/products/${created.id}`);
      } else {
        await api(`/v1/products/${id}`, { method: 'PATCH', body: { ...body, is_active: f.is_active } });
        await product.mutate();
        toast('Changes saved');
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (!isNew && product.isLoading) return <Card><LoadingRows rows={8} /></Card>;
  const p = product.data;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const levelName = new Map((levels.data ?? []).map((l) => [l.id, l.name]));
  const branchName = new Map((me?.branches ?? []).map((b) => [b.id, b.name]));

  return (
    <>
      <Link href="/products" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink"><ArrowLeft className="size-4" aria-hidden />All products</Link>
      <PageHeader title={isNew ? 'Add a product' : p?.name ?? 'Product'}
        description={isNew ? 'Scan or type the barcode. VAT and age checks come from the category when you pick one.' : p?.archived_at ? 'This product is archived.' : undefined} />
      <ErrorNote error={product.error} />
      <div className="grid gap-6 xl:grid-cols-3">
        <form onSubmit={save} className="xl:col-span-2">
          <Card>
            <CardHeader title="Details" />
            <div className="grid gap-4 px-5 pb-5 sm:grid-cols-2">
              {err && <div role="alert" className="sm:col-span-2 rounded-lg border border-danger/30 bg-danger-tint px-3 py-2.5 text-sm text-danger">{err}</div>}
              <div className="sm:col-span-2"><Field label="Product name" htmlFor="name" hint="As customers see it on the receipt."><Input id="name" value={f.name} onChange={set('name')} disabled={!editable} /></Field></div>
              <Field label="Brand" htmlFor="brand"><Input id="brand" value={f.brand} onChange={set('brand')} disabled={!editable} /></Field>
              <Field label="Size" htmlFor="size" hint="For example 500ml or 4 x 440ml."><Input id="size" value={f.size_text} onChange={set('size_text')} disabled={!editable} /></Field>
              <Field label="Category" htmlFor="cat">
                <Select id="cat" value={f.category_id} onChange={(e) => onCategory(e.target.value)} disabled={!editable}>
                  <option value="">No category</option>
                  {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="VAT rate" htmlFor="vat" hint="Most food is zero-rated. Check HMRC VAT Notice 701/14 if unsure.">
                <Select id="vat" value={f.vat_code} onChange={set('vat_code')} disabled={!editable}>
                  {Object.entries(VAT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label="Age restriction" htmlFor="age" hint="Tills ask for a Challenge 25 check on these items.">
                <Select id="age" value={f.min_age} onChange={set('min_age')} disabled={!editable}>
                  {AGE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </Select>
              </Field>
              <Field label="SKU (optional)" htmlFor="sku"><Input id="sku" value={f.sku} onChange={set('sku')} disabled={!editable} /></Field>
              {isNew && (
                <>
                  <Field label="Barcode" htmlFor="barcode" hint="Scan it with a barcode scanner, or type the digits.">
                    <Input id="barcode" inputMode="numeric" value={barcode} onChange={(e) => setBarcode(e.target.value.trim())} className="font-mono" />
                  </Field>
                  {can('prices.edit') && <Field label="Shelf price (incl. VAT)" htmlFor="price"><MoneyInput id="price" value={price} onChange={setPrice} /></Field>}
                </>
              )}
            </div>
            <div className="border-t border-line px-5 py-5">
              <h3 className="text-sm font-semibold mb-3">Stock</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Reorder when stock reaches" htmlFor="rp"><Input id="rp" type="number" min={0} value={f.reorder_point} onChange={set('reorder_point')} disabled={!editable} /></Field>
                <Field label="Usual order quantity" htmlFor="rq"><Input id="rq" type="number" min={0} value={f.reorder_qty} onChange={set('reorder_qty')} disabled={!editable} /></Field>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {([['track_stock', 'Track stock'], ['track_expiry', 'Track use-by dates'], ['sold_by_weight', 'Sold by weight (kg)']] as const).map(([k, l]) => (
                  <div key={k} className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5">
                    <span className="text-sm">{l}</span><Toggle label={l} checked={!!f[k]} onChange={(v) => setF({ ...f, [k]: v })} disabled={!editable} />
                  </div>
                ))}
              </div>
            </div>
            {editable && (
              <div className="flex justify-end gap-2 border-t border-line bg-surface/60 px-5 py-4 rounded-b-[var(--radius-card)]">
                {!isNew && <Button type="button" variant="ghost" onClick={async () => {
                  await api(`/v1/products/${id}`, { method: 'PATCH', body: { archived: !p?.archived_at } }); await product.mutate();
                  toast(p?.archived_at ? 'Product restored' : 'Product archived — it will no longer appear on tills');
                }}>{p?.archived_at ? 'Restore' : 'Archive'}</Button>}
                <Button type="submit" loading={busy}>{isNew ? 'Add product' : 'Save changes'}</Button>
              </div>
            )}
          </Card>
        </form>

        {!isNew && p && (
          <div className="space-y-6">
            <Card>
              <CardHeader title="Prices" description="Shelf prices include VAT." action={can('prices.edit') &&
                <Button size="sm" variant="secondary" icon={<Tag className="size-4" />} onClick={() => setPriceOpen(true)}>Change price</Button>} />
              <ul className="divide-y divide-line/70 px-5 pb-3">
                {p.current_prices.length === 0 && <li className="py-3 text-sm text-warning">No price set — the till can’t sell this yet.</li>}
                {p.current_prices.map((cp: any) => (
                  <li key={cp.id} className="flex items-center justify-between py-2.5 text-sm">
                    <span>{levelName.get(cp.price_level_id) ?? cp.price_level_code}
                      {cp.branch_id && <span className="text-subtle"> · {branchName.get(cp.branch_id) ?? 'branch'}</span>}
                      {cp.min_qty > 1 && <Badge tone="accent" className="ml-2">{cp.min_qty}+ each</Badge>}
                    </span>
                    <span className="font-semibold tabular">{formatGBP(cp.price_pence)}</span>
                  </li>
                ))}
              </ul>
              {p.avg_cost_pence && <p className="border-t border-line px-5 py-3 text-sm text-muted">Average cost {formatGBP(p.avg_cost_pence)} · last paid {formatGBP(p.last_cost_pence)}</p>}
            </Card>
            <Card>
              <CardHeader title="Barcodes" action={editable && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setCodeOpen(true)}>Add</Button>} />
              <ul className="divide-y divide-line/70 px-5 pb-3">
                {p.barcodes.length === 0 && <li className="py-3 text-sm text-subtle">No barcodes yet.</li>}
                {p.barcodes.map((b: any) => (
                  <li key={b.id} className="flex items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="flex items-center gap-2"><Barcode className="size-4 text-subtle" aria-hidden /><span className="font-mono">{b.barcode}</span></span>
                    <span className="flex items-center gap-1.5">
                      {b.is_pmp && <Badge tone="accent">PMP {formatGBP(b.pmp_price_pence)}</Badge>}
                      {b.units_per_scan > 1 && <Badge>Case of {b.units_per_scan}</Badge>}
                      {b.barcode_type === 'PLU' && <Badge>Scale PLU</Badge>}
                      {editable && <button className="rounded p-1 text-subtle hover:bg-danger-tint hover:text-danger" aria-label={`Remove barcode ${b.barcode}`}
                        onClick={async () => { await api(`/v1/products/${id}/barcodes/${b.id}`, { method: 'DELETE' }); product.mutate(); }}><Trash2 className="size-4" /></button>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
            {p.stock && p.stock.length > 0 && (
              <Card>
                <CardHeader title="Stock" />
                <ul className="divide-y divide-line/70 px-5 pb-3">
                  {p.stock.map((s: any) => (
                    <li key={s.branch_id} className="flex justify-between py-2.5 text-sm"><span>{branchName.get(s.branch_id)}</span>
                      <span className="tabular"><span className="font-semibold">{s.available}</span> available{s.reserved > 0 && <span className="text-subtle"> · {s.reserved} held for orders</span>}</span></li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>

      {!isNew && history.data && history.data.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Price history" description="Old prices are never changed, so past receipts always add up." />
          <Table>
            <thead><tr><Th>From</Th><Th>Level</Th><Th>Branch</Th><Th align="right">Min qty</Th><Th align="right">Price</Th></tr></thead>
            <tbody>{history.data.map((h) => (
              <tr key={h.id}><Td>{formatDateTimeUK(h.valid_from)}</Td><Td>{levelName.get(h.price_level_id)}</Td><Td>{h.branch_id ? branchName.get(h.branch_id) : 'All branches'}</Td>
                <Td align="right">{h.min_qty}</Td><Td align="right" className="font-medium">{formatGBP(h.price_pence)}</Td></tr>
            ))}</tbody>
          </Table>
        </Card>
      )}

      {!isNew && <PriceModal open={priceOpen} onClose={() => setPriceOpen(false)} productId={id} levels={levels.data ?? []} branches={me?.branches ?? []}
        onDone={() => { product.mutate(); history.mutate(); toast('New price saved — tills update on their next sync'); }} />}
      {!isNew && <BarcodeModal open={codeOpen} onClose={() => setCodeOpen(false)} productId={id} onDone={() => { product.mutate(); toast('Barcode added'); }} />}
    </>
  );
}

function PriceModal({ open, onClose, productId, levels, branches, onDone }: { open: boolean; onClose: () => void; productId: string;
  levels: any[]; branches: { id: string; name: string }[]; onDone: () => void }) {
  const [price, setPrice] = useState<number | null>(null);
  const [level, setLevel] = useState('');
  const [branch, setBranch] = useState('');
  const [minQty, setMinQty] = useState('1');
  const [from, setFrom] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (price === null) return setErr('Enter the new price');
    setBusy(true); setErr(null);
    try {
      await api(`/v1/products/${productId}/prices`, { body: { price_pence: price, price_level_id: level || undefined, branch_id: branch || null,
        min_qty: Number(minQty) || 1, valid_from: from ? new Date(from).toISOString() : undefined } });
      onDone(); onClose(); setPrice(null);
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Change price" description="Adds a new price from the date you choose. The old price stays in the history."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy}>Save price</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <div className="grid grid-cols-2 gap-4">
        <Field label="New price (incl. VAT)" htmlFor="np"><MoneyInput id="np" value={price} onChange={setPrice} autoFocus /></Field>
        <Field label="Price level" htmlFor="pl"><Select id="pl" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">Retail (default)</option>{levels.filter((l) => !l.is_default).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
        <Field label="Branch" htmlFor="pb"><Select id="pb" value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label="When buying at least" htmlFor="mq" hint="1 = normal price. Higher = multibuy break."><Input id="mq" type="number" min={1} value={minQty} onChange={(e) => setMinQty(e.target.value)} /></Field>
        <div className="col-span-2"><Field label="Starts (optional)" htmlFor="vf" hint="Leave blank to start now."><Input id="vf" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></Field></div>
      </div>
    </Modal>
  );
}

function BarcodeModal({ open, onClose, productId, onDone }: { open: boolean; onClose: () => void; productId: string; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'unit' | 'case' | 'pmp' | 'plu'>('unit');
  const [units, setUnits] = useState('12');
  const [pmp, setPmp] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!code) return setErr('Scan or type the barcode');
    if (kind === 'pmp' && pmp === null) return setErr('Enter the price printed on the pack');
    try {
      await api(`/v1/products/${productId}/barcodes`, { body: {
        barcode: code, barcode_type: kind === 'plu' ? 'PLU' : kind === 'case' && code.length === 14 ? 'ITF14' : code.length === 8 ? 'EAN8' : 'EAN13',
        units_per_scan: kind === 'case' ? Number(units) : 1, is_pmp: kind === 'pmp', pmp_price_pence: kind === 'pmp' ? pmp : null } });
      onDone(); onClose(); setCode(''); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add a barcode" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit}>Add barcode</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <Field label="Barcode" htmlFor="bc"><Input id="bc" className="font-mono" value={code} onChange={(e) => setCode(e.target.value.trim())} autoFocus /></Field>
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-1.5 text-sm font-medium">What is this barcode?</legend>
        {([['unit', 'Single item'], ['case', 'Case / multipack'], ['pmp', 'Price-marked pack'], ['plu', 'Scale PLU code']] as const).map(([k, l]) => (
          <label key={k} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${kind === k ? 'border-brand bg-brand-tint' : 'border-line'}`}>
            <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} className="accent-[var(--color-brand)]" />{l}
          </label>
        ))}
      </fieldset>
      {kind === 'case' && <Field label="Units in the case" htmlFor="u"><Input id="u" type="number" min={2} value={units} onChange={(e) => setUnits(e.target.value)} /></Field>}
      {kind === 'pmp' && <Field label="Printed price" htmlFor="pp" hint="The till will never charge more than this."><MoneyInput id="pp" value={pmp} onChange={setPmp} /></Field>}
    </Modal>
  );
}
