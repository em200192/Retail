'use client';
import { formatDateUK, formatGBP, formatTimeUK } from '@retail/shared';
import { useMe } from '@/lib/me';

/** A UK-style till receipt: VAT number, VAT summary by rate, served by, dd/mm/yyyy 24h. */
export function Receipt({ sale, staffName }: { sale: any; staffName?: string }) {
  const { me, branch } = useMe();
  const live = (sale.lines ?? []).filter((l: any) => !l.is_voided);
  const vat = new Map<string, { gross: number; vat: number; rate: number }>();
  for (const l of live) {
    const v = vat.get(l.vat_code) ?? { gross: 0, vat: 0, rate: l.vat_rate_percent };
    v.gross += l.line_total_pence; v.vat += l.vat_pence; vat.set(l.vat_code, v);
  }
  return (
    <div className="mx-auto max-w-sm rounded-lg border border-dashed border-line bg-white px-6 py-5 font-mono text-[13px] leading-relaxed shadow-inner">
      <div className="text-center">
        <p className="font-sans text-base font-bold">{me?.tenant.trading_name ?? me?.tenant.legal_name}</p>
        <p>{branch?.name}</p>
        {me?.tenant.vat_number && <p>VAT No. {me.tenant.vat_number}</p>}
      </div>
      <div className="my-3 border-t border-dashed border-line" />
      {(sale.lines ?? []).map((l: any) => (
        <div key={l.id} className={l.is_voided ? 'text-subtle line-through' : ''}>
          <div className="flex justify-between gap-2"><span className="truncate">{l.quantity !== 1 ? `${l.quantity} × ` : ''}{l.description}</span><span>{formatGBP(l.line_total_pence)}</span></div>
          {l.is_pmp && <p className="text-xs">  PMP {formatGBP(l.pmp_price_pence)}</p>}
          {(l.line_discount_pence > 0 || l.promotion_discount_pence > 0) && <p className="text-xs">  Saving -{formatGBP(l.line_discount_pence + l.promotion_discount_pence)}</p>}
          {l.vat_code !== 'Z' && l.vat_code !== 'E' && !l.is_voided && <span className="sr-only">VAT {l.vat_code}</span>}
        </div>
      ))}
      <div className="my-3 border-t border-dashed border-line" />
      {sale.discount_pence > 0 && <div className="flex justify-between"><span>You saved</span><span>{formatGBP(sale.discount_pence)}</span></div>}
      <div className="flex justify-between text-base font-bold"><span>TOTAL</span><span>{formatGBP(sale.total_pence)}</span></div>
      {(sale.payments ?? []).map((p: any) => (
        <div key={p.id}>
          <div className="flex justify-between"><span className="capitalize">{p.method === 'card' ? `${p.card_brand ?? 'Card'} ****${p.card_last4 ?? ''}` : p.method}</span><span>{formatGBP(p.tendered_pence ?? p.amount_pence)}</span></div>
          {p.change_pence > 0 && <div className="flex justify-between"><span>Change</span><span>{formatGBP(p.change_pence)}</span></div>}
        </div>
      ))}
      <div className="my-3 border-t border-dashed border-line" />
      <table className="w-full text-xs"><thead><tr><th className="text-left font-normal">VAT rate</th><th className="text-right font-normal">Net</th><th className="text-right font-normal">VAT</th></tr></thead>
        <tbody>{[...vat.entries()].map(([code, v]) => (
          <tr key={code}><td>{code} {v.rate}%</td><td className="text-right">{formatGBP(v.gross - v.vat)}</td><td className="text-right">{formatGBP(v.vat)}</td></tr>
        ))}</tbody></table>
      <div className="my-3 border-t border-dashed border-line" />
      <p>{formatDateUK(sale.completed_at ?? sale.created_at, { day: '2-digit', month: '2-digit', year: 'numeric' })} {formatTimeUK(sale.completed_at ?? sale.created_at)}  {sale.receipt_number}</p>
      {staffName && <p>Served by {staffName}</p>}
      {sale.is_training && <p className="mt-2 text-center font-bold">*** TRAINING – NOT A SALE ***</p>}
      <p className="mt-2 text-center">Thank you for shopping with us</p>
    </div>
  );
}
