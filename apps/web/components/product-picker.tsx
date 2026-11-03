'use client';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { cx, Input } from './ui';
import { t } from '@/lib/i18n';

/** Type-ahead product search (name, SKU or barcode). */
export function ProductPicker({ value, onChange, id, placeholder }: {
  value: { id: string; name: string } | null; onChange: (p: { id: string; name: string } | null) => void; id?: string; placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q, 200);
  const res = useApi<any[]>(open && dq.length >= 2 ? `/v1/products?q=${encodeURIComponent(dq)}&limit=8` : null);
  if (value) {
    return (
      <div className="flex h-10 items-center justify-between rounded-lg border border-brand/40 bg-brand-tint px-3 text-sm">
        <span className="font-medium truncate">{value.name}</span>
        <button type="button" className="text-brand font-medium hover:underline" onClick={() => onChange(null)}>{t("Change")}</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input id={id} role="combobox" aria-expanded={open && !!res.data?.length} aria-autocomplete="list" placeholder={placeholder ?? t('Search or scan a product')}
        value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => { if (e.key === 'Enter' && res.data?.length) { e.preventDefault(); onChange({ id: res.data[0].id, name: res.data[0].name }); } }} />
      {open && res.data && res.data.length > 0 && (
        <ul role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-white py-1 shadow-[var(--shadow-pop)]">
          {res.data.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === 0}>
              <button type="button" onMouseDown={() => onChange({ id: p.id, name: p.name })}
                className={cx('flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-surface', i === 0 && 'bg-surface/60')}>
                <span className="truncate">{p.name}</span><span className="ms-2 font-mono text-xs text-subtle">{p.barcode ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
