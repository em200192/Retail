'use client';
import { daysAgoUK, formatGBP, todayUK } from '@retail/shared';
import { formatDateUK, formatTimeUK } from '@/lib/format';
import { AlertTriangle, CalendarClock, FileText, Inbox, PackageX, PoundSterling, ReceiptText, ShoppingBasket, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { DailyColumns, RankBars } from '@/components/charts';
import { Badge, Card, CardHeader, EmptyState, Money, PageHeader, Skeleton, Stat } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';

const pct = (now: number, before: number) => (before > 0 ? ((now - before) / before) * 100 : null);

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/London' }).format(new Date()));
  return h < 12 ? t('Good morning') : h < 18 ? t('Good afternoon') : t('Good evening');
}

function Dashboard() {
  const { me, branchId, can } = useMe();
  const welcome = useSearchParams().get('welcome');
  const b = branchId;
  const daily = useApi<any[]>(b && can('reports.sales') ? `/v1/reports/daily?branch_id=${b}&from=${daysAgoUK(13)}&to=${todayUK()}` : null);
  const top = useApi<any[]>(b && can('reports.sales') ? `/v1/reports/top-products?branch_id=${b}&from=${daysAgoUK(6)}&to=${todayUK()}&limit=6` : null);
  const low = useApi<any[]>(b && can('stock.view') ? `/v1/stock/low?branch_id=${b}` : null);
  const expiring = useApi<any[]>(b && can('stock.view') ? `/v1/stock/expiring?branch_id=${b}` : null);
  const requests = useApi<any[]>(b && can('purchasing.manage_list') ? `/v1/purchase-requests?branch_id=${b}&status=pending` : null);
  const invoices = useApi<any[]>(b && can('invoices.approve') ? `/v1/invoices?branch_id=${b}&status=needs_review` : null);

  const rows = daily.data ?? [];
  const byDate = new Map(rows.map((r) => [r.business_date, r]));
  const today = byDate.get(todayUK());
  const lastWeek = byDate.get(daysAgoUK(7));
  const gross = (r: any) => (r ? r.net_sales_pence + r.vat_pence : 0);
  const series = Array.from({ length: 14 }, (_, i) => {
    const d = daysAgoUK(13 - i);
    const r = byDate.get(d);
    return { date: d, value: gross(r), sub: r ? t('{n} transactions', { n: r.transactions }) : t('No sales') };
  });
  const week = series.slice(7).reduce((a, d) => a + d.value, 0);
  const prevWeek = series.slice(0, 7).reduce((a, d) => a + d.value, 0);
  const marginPct = today && today.net_sales_pence > 0 && today.gross_margin_pence !== undefined ? (today.gross_margin_pence / today.net_sales_pence) * 100 : null;

  return (
    <>
      <PageHeader eyebrow={formatDateUK(new Date(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={t('{greeting}, {name}', { greeting: greeting(), name: me?.staff.first_name ?? '' })}
        description={today ? t('Figures updated at {time}.', { time: formatTimeUK(today.computed_at) }) : t('Here’s how your shop is doing.')} />

      {welcome && (
        <Card className="mb-6 border-brand/30 bg-brand-tint p-5">
          <p className="font-semibold text-brand-dark">{t("Your shop is ready.")}</p>
          <p className="text-sm text-muted mt-1">{t("Next:")}{" "}<Link className="font-medium text-brand underline" href="/products/new">{t("add your products")}</Link>{t(", then")}{" "}<Link className="font-medium text-brand underline" href="/settings">{t("register a till")}</Link>{" "}{t("and")}{" "}<Link className="font-medium text-brand underline" href="/staff">{t("add your staff")}</Link>.</p>
        </Card>
      )}

      {can('reports.sales') && (
        <section aria-label={t("Today at a glance")} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {daily.isLoading ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[126px]" />) : (
            <>
              <Stat label={t("Sales today")} icon={<PoundSterling className="size-4" />} value={formatGBP(gross(today))}
                trend={pct(gross(today), gross(lastWeek))} sub={t("vs same day last week")} />
              <Stat label={t("Transactions")} icon={<ReceiptText className="size-4" />} value={today?.transactions ?? 0}
                trend={pct(today?.transactions ?? 0, lastWeek?.transactions ?? 0)} sub={t("vs last week")} />
              <Stat label={t("Average basket")} icon={<ShoppingBasket className="size-4" />} value={formatGBP(today?.avg_basket_pence ?? 0)}
                trend={pct(today?.avg_basket_pence ?? 0, lastWeek?.avg_basket_pence ?? 0)} sub={t("vs last week")} />
              <Stat label={t("Gross margin")} icon={<TrendingUp className="size-4" />}
                value={marginPct === null ? '—' : `${marginPct.toFixed(1)}%`}
                sub={today?.gross_margin_pence !== undefined ? t('{amount} profit before costs', { amount: formatGBP(today.gross_margin_pence) }) : t('Needs finance access')} />
            </>
          )}
        </section>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        {can('reports.sales') && (
          <Card className="xl:col-span-2">
            <CardHeader title={t("Sales, last 14 days")} description={<>{t("This week")}{" "}<span className="font-medium text-ink tabular">{formatGBP(week)}</span>{prevWeek > 0 && <> · {t(pct(week, prevWeek)! >= 0 ? 'up {n}% on last week' : 'down {n}% on last week', { n: Math.abs(pct(week, prevWeek)!).toFixed(1) })}</>}</>}
              action={<Link href="/reports" className="text-sm font-medium text-brand hover:underline">{t("Reports")}</Link>} />
            <div className="px-5 pb-4">{daily.isLoading ? <Skeleton className="h-56" /> : <DailyColumns data={series} label={t("Daily sales including VAT, last 14 days")} />}</div>
          </Card>
        )}
        {can('reports.sales') && (
          <Card>
            <CardHeader title={t("Best sellers")} description={t("Last 7 days, by sales")} />
            <div className="px-5 pb-5">
              {top.isLoading ? <Skeleton className="h-56" /> : (top.data?.length ? (
                <RankBars rows={top.data.map((it) => ({ label: it.name, value: it.net_sales_pence, sub: `· ${t('{n} sold', { n: it.qty_sold })}` }))} />
              ) : <EmptyState title={t("No sales yet")} />)}
            </div>
          </Card>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-4">
        <ActionCard title={t("Running low")} icon={<PackageX className="size-4" />} href="/stock?view=low" count={low.data?.length}
          empty={t("Everything is above its reorder point.")} items={(low.data ?? []).slice(0, 4).map((l) => ({ key: l.product_id, text: l.name, meta: t('{n} left', { n: l.quantity }) }))} show={can('stock.view')} />
        <ActionCard title={t("Use by soon")} icon={<CalendarClock className="size-4" />} href="/stock?view=expiring" count={expiring.data?.length} tone="warning"
          empty={t("Nothing expires in the next 3 days.")} items={(expiring.data ?? []).slice(0, 4).map((e) => ({ key: e.batch_id, text: e.name,
            meta: e.days_left <= 0 ? t('Today') : e.days_left === 1 ? t('Tomorrow') : formatDateUK(e.expiry_date, { weekday: 'short', day: 'numeric', month: 'short' }) }))} show={can('stock.view')} />
        <ActionCard title={t("Staff requests")} icon={<Inbox className="size-4" />} href="/purchasing" count={requests.data?.length}
          empty={t("No one has asked for anything.")} items={(requests.data ?? []).slice(0, 4).map((r) => ({ key: r.id, text: r.product_name ?? r.free_text,
            meta: r.priority === 'urgent' ? t('Urgent') : r.requested_by_name, urgent: r.priority === 'urgent' }))} show={can('purchasing.manage_list')} />
        <ActionCard title={t("Invoices to check")} icon={<FileText className="size-4" />} href="/invoices" count={invoices.data?.length}
          empty={t("All supplier invoices are posted.")} items={(invoices.data ?? []).slice(0, 4).map((i) => ({ key: i.id, text: `${i.supplier_name ?? t('Unknown supplier')} · ${i.invoice_number ?? t('no number')}`,
            meta: <Money pence={i.total_pence} /> }))} show={can('invoices.approve')} />
      </div>
    </>
  );
}

function ActionCard({ title, icon, href, count, items, empty, show, tone = 'brand' }: {
  title: string; icon: React.ReactNode; href: string; count?: number; empty: string; show: boolean; tone?: 'brand' | 'warning';
  items: { key: string; text: string; meta: React.ReactNode; urgent?: boolean }[];
}) {
  if (!show) return null;
  return (
    <Card className="flex flex-col animate-rise">
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <span className={tone === 'warning' ? 'rounded-lg bg-warning-tint p-1.5 text-warning' : 'rounded-lg bg-brand-tint p-1.5 text-brand'} aria-hidden>{icon}</span>{title}
        </h2>
        {count !== undefined && <Badge tone={count > 0 ? (tone === 'warning' ? 'warning' : 'brand') : 'neutral'}>{count}</Badge>}
      </div>
      <ul className="flex-1 divide-y divide-line/70 px-5">
        {count === undefined ? <li className="py-3"><Skeleton className="h-16" /></li> : items.length === 0 ? (
          <li className="py-4 text-sm text-subtle">{empty}</li>
        ) : items.map((i) => (
          <li key={i.key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <span className="truncate">{i.text}</span>
            <span className={i.urgent ? 'shrink-0 inline-flex items-center gap-1 font-medium text-danger' : 'shrink-0 text-subtle tabular'}>
              {i.urgent && <AlertTriangle className="size-3.5" aria-hidden />}{i.meta}
            </span>
          </li>
        ))}
      </ul>
      <Link href={href} className="mx-5 mb-4 mt-2 text-sm font-medium text-brand hover:underline">{t("View all")}</Link>
    </Card>
  );
}

export default function Page() {
  return <Suspense><Dashboard /></Suspense>;
}
