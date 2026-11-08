'use client';
import { formatGBP } from '@retail/shared';
import { formatDateTimeUK } from '@/lib/format';
import { Wallet } from 'lucide-react';
import { useState } from 'react';
import { Badge, Card, CardHeader, EmptyState, LoadingRows, Modal, Money, PageHeader, Table, Td, Th } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';

const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', voucher: 'Voucher', loyalty_points: 'Loyalty points', account: 'Account', online_platform: 'Online', gift_card: 'Gift card' };
const CASH: Record<string, string> = { no_sale: 'No sales', paid_in: 'Paid in', paid_out: 'Paid out', cash_drop: 'Cash drops (to safe)', float_adjust: 'Float top-ups' };

export default function TillsPage() {
  const { branchId } = useMe();
  const sessions = useApi<any[]>(branchId ? `/v1/till-sessions?branch_id=${branchId}` : null, { refreshInterval: 15000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const z = useApi<any>(openId ? `/v1/till-sessions/${openId}/z-report` : null);
  const session = sessions.data?.find((s) => s.id === openId);
  const openNow = (sessions.data ?? []).filter((s) => s.status === 'open');

  return (
    <>
      <PageHeader title={t("Tills & cash-up")} description={t("Open tills, end-of-day Z reports and cash variances. Tills are opened and cashed up on the till itself.")} />
      {openNow.length > 0 && (
        <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {openNow.map((s) => (
            <Card key={s.id} className="p-5">
              <div className="flex items-center justify-between"><p className="font-semibold">{s.till_name}</p><Badge tone="success"><span className="size-1.5 rounded-full bg-success" aria-hidden />{t("Open")}</Badge></div>
              <p className="mt-1 text-sm text-muted">{t('Opened by {name} · {when}', { name: s.opened_by_name, when: formatDateTimeUK(s.opened_at) })}</p>
              <p className="mt-1 text-sm text-muted">{t("Float")}{" "}<Money pence={s.opening_float_pence} /></p>
              <button className="mt-3 text-sm font-medium text-brand hover:underline" onClick={() => setOpenId(s.id)}>{t("View X-read (so far)")}</button>
            </Card>
          ))}
        </div>
      )}
      <Card>
        <CardHeader title={t("Cash-ups")} />
        {sessions.isLoading ? <LoadingRows /> : !sessions.data?.length ? <EmptyState icon={<Wallet className="size-6" />} title={t("No till sessions yet")} /> : (
          <Table>
            <thead><tr><Th>{t("Till")}</Th><Th>{t("Opened")}</Th><Th>{t("Closed")}</Th><Th align="right">{t("Takings")}</Th><Th align="right">{t("Expected cash")}</Th><Th align="right">{t("Counted")}</Th><Th align="right">{t("Variance")}</Th></tr></thead>
            <tbody>{sessions.data.map((s) => (
              <tr key={s.id} className="cursor-pointer hover:bg-surface/70" onClick={() => setOpenId(s.id)}>
                <Td className="font-medium">{s.till_name}</Td>
                <Td className="text-muted">{formatDateTimeUK(s.opened_at)}<span className="block text-xs">{s.opened_by_name}</span></Td>
                <Td className="text-muted">{s.closed_at ? <>{formatDateTimeUK(s.closed_at)}<span className="block text-xs">{s.closed_by_name}</span></> : <Badge tone="success">{t("Open")}</Badge>}</Td>
                <Td align="right"><Money pence={s.net_sales_pence} /></Td>
                <Td align="right"><Money pence={s.expected_cash_pence} /></Td>
                <Td align="right"><Money pence={s.counted_cash_pence} /></Td>
                <Td align="right">{s.variance_pence === null ? '—' : (
                  <span className={s.variance_pence === 0 ? 'text-success font-medium' : Math.abs(s.variance_pence) > 500 ? 'text-danger font-semibold' : 'text-warning font-medium'}>
                    {s.variance_pence === 0 ? t('Balanced') : t(s.variance_pence > 0 ? 'Over {amount}' : 'Short {amount}', { amount: formatGBP(Math.abs(s.variance_pence)) })}</span>)}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Modal open={!!openId} onClose={() => setOpenId(null)} wide title={session?.status === 'closed' ? t('Z report · {name}', { name: session.till_name }) : t('X-read · {name}', { name: session?.till_name ?? '' })}
        description={session ? `${formatDateTimeUK(session.opened_at)}${session.closed_at ? ` – ${formatDateTimeUK(session.closed_at)}` : ` – ${t('now')}`}` : undefined}>
        {!z.data ? <LoadingRows rows={6} /> : <ZReport z={z.data} session={session} />}
      </Modal>
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return <div className={`flex justify-between py-1.5 text-sm ${strong ? 'font-semibold' : ''}`}><span className={strong ? '' : 'text-muted'}>{label}</span><span className="tabular">{value}</span></div>;
}

function ZReport({ z, session }: { z: any; session: any }) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">{t("Sales")}</h3>
        <Row label={t("Transactions")} value={z.sales.count} />
        <Row label={t("Gross sales")} value={formatGBP(z.sales.gross_pence)} />
        <Row label={t("Discounts")} value={`-${formatGBP(z.sales.discounts_pence)}`} />
        <Row label={t("Net takings (incl. VAT)")} value={formatGBP(z.sales.net_pence)} strong />
        <Row label={t("Refunds")} value={`-${formatGBP(z.refunds.total_pence)} (${z.refunds.count})`} />
        <Row label={t("Voided sales")} value={`${z.voided_sales.count} · ${formatGBP(z.voided_sales.value_pence)}`} />
        <Row label={t("Voided lines")} value={`${z.voided_lines.count} · ${formatGBP(z.voided_lines.value_pence)}`} />
        <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-subtle">{t("Payments")}</h3>
        {Object.entries(z.payments).map(([k, v]) => <Row key={k} label={t(METHOD[k] ?? k)} value={formatGBP(v as number)} />)}
      </section>
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">VAT</h3>
        {Object.entries(z.vat_by_code).map(([k, v]: [string, any]) => <Row key={k} label={`${k} · ${t('net')} ${formatGBP(v.net_pence)}`} value={formatGBP(v.vat_pence)} />)}
        <Row label={t("Total VAT")} value={formatGBP(z.sales.vat_pence)} strong />
        <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-subtle">{t("Cash drawer")}</h3>
        <Row label={t("Opening float")} value={formatGBP(z.opening_float_pence)} />
        <Row label={t("Cash sales")} value={formatGBP(z.payments.cash ?? 0)} />
        {Object.entries(z.cash_movements).map(([k, v]: [string, any]) => <Row key={k} label={`${t(CASH[k] ?? k)} (${v.count})`} value={k === 'no_sale' ? '—' : formatGBP(v.amount_pence)} />)}
        <Row label={t("Expected in drawer")} value={formatGBP(z.expected_cash_pence)} strong />
        {session?.counted_cash_pence !== null && session?.counted_cash_pence !== undefined && <>
          <Row label={t("Counted")} value={formatGBP(session.counted_cash_pence)} />
          <Row label={t("Variance")} value={session.variance_pence === 0 ? t('Balanced') : formatGBP(session.variance_pence)} strong />
        </>}
      </section>
    </div>
  );
}
