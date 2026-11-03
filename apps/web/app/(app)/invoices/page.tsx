'use client';
import { formatDateUK } from '@/lib/format';
import { FileText, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, LoadingRows, Money, PageHeader, Table, Tabs, Td, Th, useToast } from '@/components/ui';
import { api, prepareInvoiceFile, useApi } from '@/lib/api';
import { INVOICE_STATUS } from '@/lib/labels';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';


export default function InvoicesPage() {
  const { branchId, can } = useMe();
  const router = useRouter();
  const toast = useToast();
  const [filter, setFilter] = useState<'todo' | 'all'>('todo');
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inv = useApi<any[]>(branchId ? `/v1/invoices?branch_id=${branchId}` : null, { refreshInterval: 5000 });
  const rows = (inv.data ?? []).filter((i) => filter === 'all' || ['uploaded', 'processing', 'needs_review', 'approved', 'failed'].includes(i.status));

  const upload = async (file: File) => {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf && !file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) return toast(t('Upload a PDF or a photo of the invoice'), 'danger');
    if (file.size > 40 * 1024 * 1024) return toast(t('The file must be smaller than 40 MB'), 'danger');
    setUploading(true);
    try {
      const f = await prepareInvoiceFile(file);
      if (f.base64.length > 27 * 1024 * 1024) throw new Error(t('The file must be smaller than 20 MB'));
      const created = await api('/v1/invoices', { body: { branch_id: branchId, file_name: f.name, mime_type: f.mime, content_base64: f.base64 } });
      toast(t('Invoice uploaded — we’re reading it now'));
      router.push(`/invoices/${created.id}`);
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setUploading(false); }
  };

  return (
    <>
      <PageHeader title={t("Supplier invoices")} description={t("Snap or upload an invoice. We read every line, match it to your products and book the stock in once you’ve checked it.")} />
      {can('invoices.upload') && (
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) upload(f); }}
          className={`mb-6 flex flex-col items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed px-6 py-10 text-center transition-colors ${drag ? 'border-brand bg-brand-tint' : 'border-line bg-white'}`}>
          <div className="rounded-full bg-brand-tint p-3 text-brand" aria-hidden><Upload className="size-6" /></div>
          <p className="mt-3 font-semibold">{t("Drop an invoice here")}</p>
          <p className="text-sm text-muted">{t("PDF, JPG or PNG up to 20 MB · Booker, Bestway, Costco and others")}</p>
          <input ref={input} type="file" accept="application/pdf,image/*" className="sr-only" id="file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          <Button className="mt-4" loading={uploading} onClick={() => input.current?.click()}>{t("Choose a file")}</Button>
        </div>
      )}
      <Tabs value={filter} onChange={setFilter} tabs={[{ id: 'todo', label: t('To do'), count: rows.length && filter === 'todo' ? rows.length : undefined }, { id: 'all', label: t('All invoices') }]} />
      <Card>
        {inv.isLoading && !inv.data ? <LoadingRows /> : rows.length === 0 ? (
          <EmptyState icon={<FileText className="size-6" />} title={filter === 'todo' ? 'All caught up' : 'No invoices yet'}>{t("Every invoice has been checked and booked in.")}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>{t("Supplier")}</Th><Th>{t("Invoice no.")}</Th><Th>{t("Date")}</Th><Th align="right">{t("Total")}</Th><Th>{t("Status")}</Th></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id} className="cursor-pointer hover:bg-surface/70" onClick={() => router.push(`/invoices/${i.id}`)}>
                <Td><Link href={`/invoices/${i.id}`} className="font-medium hover:text-brand" onClick={(e) => e.stopPropagation()}>{i.supplier_name ?? t('Not identified yet')}</Link></Td>
                <Td className="font-mono text-xs">{i.invoice_number ?? '—'}</Td>
                <Td className="text-muted">{i.invoice_date ? formatDateUK(i.invoice_date) : formatDateUK(i.created_at)}</Td>
                <Td align="right"><Money pence={i.total_pence} /></Td>
                <Td><Badge tone={INVOICE_STATUS[i.status]?.tone}>{t(INVOICE_STATUS[i.status]?.label ?? '')}</Badge>
                  {i.ocr_error && <p className="mt-1 max-w-xs truncate text-xs text-danger">{t(i.ocr_error)}</p>}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
