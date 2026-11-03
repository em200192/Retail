'use client';
import { daysAgoUK, todayUK } from '@retail/shared';
import { formatDateUK, formatTimeUK } from '@/lib/format';
import { Receipt as ReceiptIcon, Search } from 'lucide-react';
import { useState } from 'react';
import { Receipt } from '@/components/receipt';
import { Badge, Card, EmptyState, Input, LoadingRows, Modal, Money, PageHeader, Table, Td, Th } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';

const STATUS: Record<string, { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  completed: { label: 'Completed', tone: 'success' }, voided: { label: 'Voided', tone: 'danger' },
  partially_refunded: { label: 'Part refunded', tone: 'warning' }, refunded: { label: 'Refunded', tone: 'warning' }, parked: { label: 'Parked', tone: 'neutral' },
};

export default function SalesPage() {
  const { branchId } = useMe();
  const [from, setFrom] = useState(todayUK());
  const [to, setTo] = useState(todayUK());
  const [receiptNo, setReceiptNo] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const q = receiptNo.trim() ? `&receipt_number=${encodeURIComponent(receiptNo.trim().toUpperCase())}` : `&from=${from}&to=${to}`;
  const sales = useApi<any[]>(branchId ? `/v1/sales?branch_id=${branchId}${q}&limit=500` : null);
  const staff = useApi<any[]>(branchId ? `/v1/branches/${branchId}/staff-tiles` : null);
  const names = new Map((staff.data ?? []).map((s) => [s.id, s.display_name]));
  const detail = useApi<any>(openId ? `/v1/sales/${openId}` : null);
  const real = (sales.data ?? []).filter((s) => !s.is_training && s.status !== 'voided');
  const total = real.reduce((a, s) => a + s.total_pence, 0);

  return (
    <>
      <PageHeader title={t("Sales")} description={t("Every receipt from your tills. Training-mode sales are shown but never counted.")} />
      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-end">
          <div className="flex gap-3">
            <div><label htmlFor="f" className="mb-1 block text-xs font-medium text-muted">{t("From")}</label><Input id="f" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
            <div><label htmlFor="t" className="mb-1 block text-xs font-medium text-muted">{t("To")}</label><Input id="t" type="date" value={to} min={from} max={todayUK()} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
          <div className="flex gap-1.5">
            {[[t('Today'), 0, 0], [t('Yesterday'), 1, 1], [t('Last 7 days'), 6, 0]].map(([l, a, b]) => (
              <button key={l as string} onClick={() => { setFrom(daysAgoUK(a as number)); setTo(daysAgoUK(b as number)); setReceiptNo(''); }}
                className="h-10 rounded-lg border border-line px-3 text-sm font-medium hover:bg-surface">{l}</button>
            ))}
          </div>
          <div className="relative lg:ms-auto lg:w-72">
            <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
            <label htmlFor="rn" className="sr-only">{t("Find a receipt number")}</label>
            <Input id="rn" placeholder={t("Receipt no., e.g. MAN1-1-204")} value={receiptNo} onChange={(e) => setReceiptNo(e.target.value)} className="ps-9" />
          </div>
        </div>
        {sales.data && (
          <div className="flex flex-wrap gap-x-8 gap-y-1 border-b border-line px-5 py-3 text-sm">
            <span><span className="text-muted">{t("Receipts")}</span> <span className="font-semibold tabular">{real.length}</span></span>
            <span><span className="text-muted">{t("Takings")}</span> <Money pence={total} className="font-semibold" /></span>
            <span><span className="text-muted">{t("Average")}</span> <Money pence={real.length ? Math.round(total / real.length) : 0} className="font-semibold" /></span>
          </div>
        )}
        {sales.isLoading && !sales.data ? <LoadingRows /> : sales.data?.length === 0 ? (
          <EmptyState icon={<ReceiptIcon className="size-6" />} title={t("No sales in this period")} />
        ) : (
          <Table>
            <thead><tr><Th>{t("Time")}</Th><Th>{t("Receipt")}</Th><Th>{t("Served by")}</Th><Th align="right">{t("Items")}</Th><Th align="right">VAT</Th><Th align="right">{t("Total")}</Th><Th>{t("Status")}</Th></tr></thead>
            <tbody>{sales.data?.map((s) => (
              <tr key={s.id} className="cursor-pointer hover:bg-surface/70" onClick={() => setOpenId(s.id)}>
                <Td className="whitespace-nowrap">{from !== to || receiptNo ? `${formatDateUK(s.completed_at, { day: 'numeric', month: 'short' })} ` : ''}{formatTimeUK(s.completed_at)}</Td>
                <Td><button className="font-mono text-xs hover:text-brand" onClick={(e) => { e.stopPropagation(); setOpenId(s.id); }}>{s.receipt_number}</button></Td>
                <Td>{names.get(s.staff_id) ?? '—'}</Td>
                <Td align="right">{s.item_count}</Td>
                <Td align="right" className="text-muted"><Money pence={s.vat_pence} /></Td>
                <Td align="right" className="font-medium"><Money pence={s.total_pence} /></Td>
                <Td><Badge tone={STATUS[s.status]?.tone}>{t(STATUS[s.status]?.label ?? '')}</Badge>{s.is_training && <Badge tone="accent" className="ms-1">{t("Training")}</Badge>}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title={detail.data ? t('Receipt {number}', { number: detail.data.receipt_number }) : t('Receipt')}>
        {detail.data ? <Receipt sale={detail.data} staffName={names.get(detail.data.staff_id)} /> : <LoadingRows rows={6} />}
        {detail.data?.refunds?.length > 0 && (
          <div className="rounded-lg bg-warning-tint p-3 text-sm text-warning">
            {detail.data.refunds.map((r: any) => <p key={r.id}>{t("Refunded")}{" "}<Money pence={r.total_pence} /> on {formatDateUK(r.occurred_at)} · {r.reason_code.replace(/_/g, ' ')}</p>)}
          </div>
        )}
      </Modal>
    </>
  );
}
