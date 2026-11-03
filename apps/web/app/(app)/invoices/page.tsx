'use client';
import { formatDateUK } from '@retail/shared';
import { FileText, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, LoadingRows, Money, PageHeader, Table, Tabs, Td, Th, useToast } from '@/components/ui';
import { api, fileToBase64, useApi } from '@/lib/api';
import { INVOICE_STATUS } from '@/lib/labels';
import { useMe } from '@/lib/me';


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
    if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return toast('Upload a PDF or a photo (JPG or PNG)', 'danger');
    if (file.size > 20 * 1024 * 1024) return toast('The file must be smaller than 20 MB', 'danger');
    setUploading(true);
    try {
      const created = await api('/v1/invoices', { body: { branch_id: branchId, file_name: file.name, mime_type: file.type, content_base64: await fileToBase64(file) } });
      toast('Invoice uploaded — we’re reading it now');
      router.push(`/invoices/${created.id}`);
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setUploading(false); }
  };

  return (
    <>
      <PageHeader title="Supplier invoices" description="Snap or upload an invoice. We read every line, match it to your products and book the stock in once you’ve checked it." />
      {can('invoices.upload') && (
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) upload(f); }}
          className={`mb-6 flex flex-col items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed px-6 py-10 text-center transition-colors ${drag ? 'border-brand bg-brand-tint' : 'border-line bg-white'}`}>
          <div className="rounded-full bg-brand-tint p-3 text-brand" aria-hidden><Upload className="size-6" /></div>
          <p className="mt-3 font-semibold">Drop an invoice here</p>
          <p className="text-sm text-muted">PDF, JPG or PNG up to 20 MB · Booker, Bestway, Costco and others</p>
          <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" capture="environment" className="sr-only" id="file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          <Button className="mt-4" loading={uploading} onClick={() => input.current?.click()}>Choose a file</Button>
        </div>
      )}
      <Tabs value={filter} onChange={setFilter} tabs={[{ id: 'todo', label: 'To do', count: rows.length && filter === 'todo' ? rows.length : undefined }, { id: 'all', label: 'All invoices' }]} />
      <Card>
        {inv.isLoading && !inv.data ? <LoadingRows /> : rows.length === 0 ? (
          <EmptyState icon={<FileText className="size-6" />} title={filter === 'todo' ? 'All caught up' : 'No invoices yet'}>Every invoice has been checked and booked in.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Supplier</Th><Th>Invoice no.</Th><Th>Date</Th><Th align="right">Total</Th><Th>Status</Th></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id} className="cursor-pointer hover:bg-surface/70" onClick={() => router.push(`/invoices/${i.id}`)}>
                <Td><Link href={`/invoices/${i.id}`} className="font-medium hover:text-brand" onClick={(e) => e.stopPropagation()}>{i.supplier_name ?? 'Not identified yet'}</Link></Td>
                <Td className="font-mono text-xs">{i.invoice_number ?? '—'}</Td>
                <Td className="text-muted">{i.invoice_date ? formatDateUK(i.invoice_date) : formatDateUK(i.created_at)}</Td>
                <Td align="right"><Money pence={i.total_pence} /></Td>
                <Td><Badge tone={INVOICE_STATUS[i.status]?.tone}>{INVOICE_STATUS[i.status]?.label}</Badge>
                  {i.ocr_error && <p className="mt-1 max-w-xs truncate text-xs text-danger">{i.ocr_error}</p>}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
