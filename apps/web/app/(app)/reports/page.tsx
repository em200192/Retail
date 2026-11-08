'use client';
import { daysAgoUK, formatGBP, todayUK } from '@retail/shared';
import { formatDateUK } from '@/lib/format';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { DailyColumns, RankBars } from '@/components/charts';
import { Badge, Card, CardHeader, Input, LoadingRows, Money, PageHeader, Select, Table, Tabs, Td, Th } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';

export default function ReportsPage() {
  const { branchId, can } = useMe();
  const [tab, setTab] = useState<'takings' | 'products' | 'staff'>('takings');
  const [from, setFrom] = useState(daysAgoUK(13));
  const [to, setTo] = useState(todayUK());
  const [order, setOrder] = useState<'revenue' | 'quantity' | 'margin'>('revenue');
  const range = `branch_id=${branchId}&from=${from}&to=${to}`;
  const daily = useApi<any[]>(branchId ? `/v1/reports/daily?${range}` : null);
  const top = useApi<any[]>(branchId && tab === 'products' ? `/v1/reports/top-products?${range}&limit=50&order=${order}` : null);
  const staff = useApi<any[]>(branchId && tab === 'staff' && can('reports.staff') ? `/v1/reports/staff-activity?${range}` : null);
  const rows = daily.data ?? [];
  const sum = (k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const fin = can('reports.financial');
  const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const series = Array.from({ length: Math.max(0, Math.min(days, 92)) }, (_, i) => {
    const d = new Date(new Date(from).getTime() + i * 86400000).toISOString().slice(0, 10);
    const r = rows.find((x) => x.business_date === d);
    return { date: d, value: r ? r.net_sales_pence + r.vat_pence : 0, sub: r ? t('{n} transactions', { n: r.transactions }) : t('No sales') };
  });

  return (
    <>
      <PageHeader title={t("Reports")} description={t("Figures exclude training-mode sales. Takings include VAT; margins are on sales excluding VAT.")}
        actions={<div className="flex items-end gap-2">
          <div><label htmlFor="rf" className="mb-1 block text-xs font-medium text-muted">{t("From")}</label><Input id="rf" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></div>
          <div><label htmlFor="rt" className="mb-1 block text-xs font-medium text-muted">{t("To")}</label><Input id="rt" type="date" value={to} min={from} max={todayUK()} onChange={(e) => e.target.value && setTo(e.target.value)} /></div>
        </div>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'takings', label: t('Takings') }, { id: 'products', label: t('Products') }, ...(can('reports.staff') ? [{ id: 'staff' as const, label: t('Staff activity') }] : [])]} />

      {tab === 'takings' && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[[t('Takings'), formatGBP(sum('net_sales_pence') + sum('vat_pence'))], [t('Transactions'), sum('transactions').toLocaleString('en-GB')],
              [t('Cash / card'), `${formatGBP(sum('cash_pence'))} / ${formatGBP(sum('card_pence'))}`],
              [fin ? t('Gross profit') : t('Refunds'), fin ? formatGBP(sum('net_sales_pence') - sum('cost_of_goods_pence')) : formatGBP(sum('refunds_pence'))]].map(([l, v]) => (
              <Card key={l} className="p-5"><p className="text-sm text-muted">{l}</p><p className="mt-1 text-2xl font-semibold tabular">{v}</p></Card>
            ))}
          </div>
          <Card><CardHeader title={t("Daily takings")} /><div className="px-5 pb-4">{/* Wait for data: the page is prerendered at build time, so date labels must not render before then. */}{daily.isLoading || !daily.data ? <LoadingRows /> : <DailyColumns data={series} label={t("Daily takings including VAT")} />}</div></Card>
          <Card>
            <Table>
              <thead><tr><Th>{t("Date")}</Th><Th align="right">{t("Transactions")}</Th><Th align="right">{t("Avg basket")}</Th><Th align="right">{t("Takings")}</Th><Th align="right">VAT</Th>
                <Th align="right">{t("Discounts")}</Th><Th align="right">{t("Refunds")}</Th>{fin && <><Th align="right">{t("Cost of sales")}</Th><Th align="right">{t("Waste")}</Th><Th align="right">{t("Margin")}</Th></>}</tr></thead>
              <tbody>{[...rows].reverse().map((r) => (
                <tr key={r.business_date}>
                  <Td className="whitespace-nowrap">{formatDateUK(r.business_date, { weekday: 'short', day: 'numeric', month: 'short' })}</Td>
                  <Td align="right">{r.transactions}</Td><Td align="right"><Money pence={r.avg_basket_pence} /></Td>
                  <Td align="right" className="font-medium"><Money pence={r.net_sales_pence + r.vat_pence} /></Td><Td align="right"><Money pence={r.vat_pence} /></Td>
                  <Td align="right"><Money pence={r.discounts_pence} /></Td><Td align="right"><Money pence={r.refunds_pence} /></Td>
                  {fin && <><Td align="right"><Money pence={r.cost_of_goods_pence} /></Td><Td align="right" className={r.waste_cost_pence ? 'text-danger' : ''}><Money pence={r.waste_cost_pence} /></Td>
                    <Td align="right">{r.net_sales_pence ? `${(((r.net_sales_pence - r.cost_of_goods_pence) / r.net_sales_pence) * 100).toFixed(1)}%` : '—'}</Td></>}
                </tr>
              ))}</tbody>
            </Table>
          </Card>
        </div>
      )}

      {tab === 'products' && (
        <Card>
          <CardHeader title={t("Product performance")} action={<div className="w-44"><label htmlFor="ord" className="sr-only">{t("Sort by")}</label>
            <Select id="ord" value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
              <option value="revenue">{t("By sales")}</option><option value="quantity">{t("By units")}</option>{fin && <option value="margin">{t("By profit")}</option>}</Select></div>} />
          {top.isLoading ? <LoadingRows /> : (
            <div className="grid grid-cols-1 gap-6 px-5 pb-5 lg:grid-cols-2">
              <RankBars rows={(top.data ?? []).slice(0, 10).map((it) => ({ label: it.name,
                value: order === 'quantity' ? it.qty_sold : order === 'margin' ? it.margin_pence : it.net_sales_pence }))}
                format={order === 'quantity' ? (v) => t('{n} sold', { n: v.toLocaleString('en-GB') }) : formatGBP} />
              <Table>
                <thead><tr><Th>{t("Product")}</Th><Th align="right">{t("Sold")}</Th><Th align="right">{t("Sales ex VAT")}</Th>{fin && <Th align="right">{t("Profit")}</Th>}<Th align="right">{t("Wasted")}</Th></tr></thead>
                <tbody>{(top.data ?? []).map((it) => (
                  <tr key={it.product_id}><Td>{it.name}{it.had_stockout && <Badge tone="warning" className="ms-2">{t("Ran out")}</Badge>}</Td><Td align="right">{it.qty_sold}</Td>
                    <Td align="right"><Money pence={it.net_sales_pence} /></Td>{fin && <Td align="right"><Money pence={it.margin_pence} /></Td>}
                    <Td align="right" className={it.qty_wasted ? 'text-danger' : 'text-subtle'}>{it.qty_wasted || '—'}</Td></tr>
                ))}</tbody>
              </Table>
            </div>
          )}
        </Card>
      )}

      {tab === 'staff' && (
        <Card>
          <div className="m-5 flex gap-3 rounded-lg bg-brand-tint p-4 text-sm text-brand-dark">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{t("These figures help you spot training needs and unusual patterns. They are not a judgement on their own — always talk to the person first. Staff are told what is measured (UK GDPR).")}</p>
          </div>
          {staff.isLoading ? <LoadingRows /> : (
            <Table>
              <thead><tr><Th>{t("Staff")}</Th><Th align="right">{t("Sales")}</Th><Th align="right">{t("Takings")}</Th><Th align="right">{t("Voided lines")}</Th><Th align="right">{t("No sales")}</Th><Th align="right">{t("Refunds")}</Th><Th align="right">{t("Discounts given")}</Th></tr></thead>
              <tbody>{(staff.data ?? []).filter((s) => s.sales || s.refunds_pence || s.no_sales || s.voided_lines).map((s) => (
                <tr key={s.staff_id}><Td className="font-medium">{s.display_name}</Td><Td align="right">{s.sales}</Td><Td align="right"><Money pence={s.sales_pence} /></Td>
                  <Td align="right">{s.voided_lines}</Td><Td align="right">{s.no_sales}</Td><Td align="right"><Money pence={s.refunds_pence} /></Td><Td align="right"><Money pence={s.discounts_pence} /></Td></tr>
              ))}</tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
