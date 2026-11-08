'use client';
import { formatGBP } from '@retail/shared';
import { formatDateUK } from '@/lib/format';
import { Info, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, CardHeader, Input, LoadingRows, PageHeader, Select, useToast, ErrorNote } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useMe } from '@/lib/me';
import { currentLang, t } from '@/lib/i18n';

// HMRC Making Tax Digital box descriptions (VAT100).
const BOXES: { key: string; n: number; label: string; whole?: boolean }[] = [
  { key: 'box1_vat_due_sales_pence', n: 1, label: 'VAT due in the period on sales and other outputs' },
  { key: 'box2_vat_due_acquisitions_pence', n: 2, label: 'VAT due in the period on acquisitions of goods made in Northern Ireland from EU Member States' },
  { key: 'box3_total_vat_due_pence', n: 3, label: 'Total VAT due (the sum of boxes 1 and 2)' },
  { key: 'box4_vat_reclaimed_pence', n: 4, label: 'VAT reclaimed in the period on purchases and other inputs (including acquisitions in Northern Ireland from EU Member States)' },
  { key: 'box5_net_vat_pence', n: 5, label: 'Net VAT to pay to HMRC or reclaim (the difference between boxes 3 and 4)' },
  { key: 'box6_total_sales_ex_vat_pence', n: 6, label: 'Total value of sales and all other outputs excluding any VAT', whole: true },
  { key: 'box7_total_purchases_ex_vat_pence', n: 7, label: 'Total value of purchases and all other inputs excluding any VAT', whole: true },
  { key: 'box8_supplies_ex_vat_pence', n: 8, label: 'Total value of dispatches of goods and related costs (excluding VAT) from Northern Ireland to EU Member States', whole: true },
  { key: 'box9_acquisitions_ex_vat_pence', n: 9, label: 'Total value of acquisitions of goods and related costs (excluding VAT) made in Northern Ireland from EU Member States', whole: true },
];

/** Calendar VAT quarters (the most common stagger), most recent first. */
function quarters(): { start: string; end: string; label: string }[] {
  const out = [];
  const now = new Date();
  let y = now.getFullYear(), q = Math.floor(now.getMonth() / 3);
  for (let i = 0; i < 6; i++) {
    const start = new Date(Date.UTC(y, q * 3, 1)), end = new Date(Date.UTC(y, q * 3 + 3, 0));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    out.push({ start: iso(start), end: iso(end), label: `${formatDateUK(iso(start), { month: 'short' })} – ${formatDateUK(iso(end), { month: 'short', year: 'numeric' })}` });
    q--; if (q < 0) { q = 3; y--; }
  }
  return out;
}

export default function VatPage() {
  const { can, me } = useMe();
  const toast = useToast();
  const qs = useMemo(quarters, []);
  const [period, setPeriod] = useState(0);
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);
  const p = custom ?? qs[period]!;
  const badRange = !p.start || !p.end || p.start > p.end;
  const vat = useApi<any>(badRange ? null : `/v1/reports/vat?from=${p.start}&to=${p.end}`);
  const [saving, setSaving] = useState(false);
  const fmt = (b: (typeof BOXES)[number], v: number) => (b.whole ? `£${Math.floor(v / 100).toLocaleString('en-GB')}` : formatGBP(v));

  return (
    <>
      <PageHeader title={t("VAT return")} description={t("Your nine-box figures, worked out from every sale, refund, supplier invoice and expense. Ready for Making Tax Digital.")}
        actions={can('finance.vat') && <Button icon={<Save className="size-4" />} loading={saving} disabled={badRange} onClick={async () => {
          setSaving(true);
          try { await api('/v1/vat-returns', { body: { period_start: p.start, period_end: p.end } }); toast(t('Draft VAT return saved')); }
          catch (e) { toast((e as Error).message, 'danger'); } finally { setSaving(false); }
        }}>{t("Save as draft")}</Button>} />
      {me && !me.tenant.vat_registered && <div className="mb-6 rounded-xl bg-accent-tint p-4 text-sm">{t("Your business is set up as not VAT registered, so you don’t need to file VAT returns.")}</div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={t("Return figures")} description={badRange ? undefined : t('Period {from} to {to}', { from: formatDateUK(p.start), to: formatDateUK(p.end) })}
            action={vat.data && !badRange && <Badge tone={vat.data.direction === 'payable' ? 'warning' : 'success'}>{vat.data.direction === 'payable' ? t('To pay') : t('To reclaim')}</Badge>} />
          {vat.error && !vat.data && <ErrorNote error={vat.error} />}
          {badRange ? <p role="alert" className="mx-5 mb-5 rounded-lg bg-danger-tint px-3 py-2.5 text-sm font-medium text-danger">{t('The end date must be the same as or after the start date')}</p>
            : vat.error && !vat.data ? null : vat.isLoading || !vat.data ? <LoadingRows rows={9} /> : (
            <ol className="divide-y divide-line/70 px-5 pb-2">
              {BOXES.map((b) => (
                <li key={b.key} className={`flex items-start gap-4 py-3.5 ${b.n === 5 ? 'rounded-lg bg-brand-tint/60 -mx-2 px-2' : ''}`}>
                  <span className={`grid size-8 shrink-0 place-items-center rounded-lg text-sm font-semibold ${b.n === 5 ? 'bg-brand text-white' : 'bg-surface text-muted'}`} aria-label={`Box ${b.n}`}>{b.n}</span>
                  <span className="flex-1 text-sm text-muted">{t(b.label)}{currentLang() === 'ar' && <span className="mt-0.5 block text-xs text-subtle" dir="ltr" lang="en-GB">HMRC: {b.label}</span>}</span>
                  <span className={`shrink-0 text-right tabular ${b.n === 5 ? 'text-lg font-semibold text-ink' : 'font-medium'}`}>{fmt(b, vat.data[b.key])}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="space-y-6">
          <Card className="p-5 space-y-4">
            <div>
              <label htmlFor="q" className="mb-1.5 block text-sm font-medium">{t("VAT period")}</label>
              <Select id="q" value={custom ? 'custom' : String(period)} onChange={(e) => {
                if (e.target.value === 'custom') setCustom({ start: p.start, end: p.end }); else { setCustom(null); setPeriod(Number(e.target.value)); } }}>
                {qs.map((q, i) => <option key={q.start} value={i}>{q.label}{i === 0 ? ` (${t('current')})` : ''}</option>)}
                <option value="custom">{t("Custom dates…")}</option>
              </Select>
            </div>
            {custom && (
              <div className="grid grid-cols-2 gap-3">
                <div><label htmlFor="cs" className="mb-1 block text-xs font-medium text-muted">{t("From")}</label><Input id="cs" type="date" value={custom.start} onChange={(e) => e.target.value && setCustom({ ...custom, start: e.target.value })} /></div>
                <div><label htmlFor="ce" className="mb-1 block text-xs font-medium text-muted">{t("To")}</label><Input id="ce" type="date" value={custom.end} onChange={(e) => e.target.value && setCustom({ ...custom, end: e.target.value })} /></div>
              </div>
            )}
          </Card>
          <Card className="p-5 text-sm text-muted space-y-3">
            <p className="flex items-center gap-2 font-semibold text-ink"><Info className="size-4 text-brand" aria-hidden />{t("About these figures")}</p>
            <p>{t("Sales VAT comes from the VAT recorded on each till receipt at the time of sale, less refunds. Purchase VAT comes from posted supplier invoices and reclaimable expenses.")}</p>
            <p>{t("Boxes 6 to 9 are shown in whole pounds, as HMRC requires. Boxes 2, 8 and 9 only apply to goods moving between Northern Ireland and the EU.")}</p>
            <p>{t("Check the figures with your accountant before you submit. Submitting to HMRC directly is coming soon.")}</p>
          </Card>
        </div>
      </div>
    </>
  );
}
