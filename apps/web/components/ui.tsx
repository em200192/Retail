'use client';
import { formatGBP, parsePounds } from '@retail/shared';
import { Loader2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { t } from '@/lib/i18n';

export function cx(...c: (string | false | null | undefined)[]) { return c.filter(Boolean).join(' '); }

// ------------------------------------------------------------------ buttons
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
};
export function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  const styles = {
    primary: 'bg-brand text-white hover:bg-brand-dark shadow-sm',
    secondary: 'bg-white text-ink border border-line hover:bg-surface shadow-sm',
    ghost: 'text-muted hover:bg-surface hover:text-ink',
    danger: 'bg-danger text-white hover:brightness-95 shadow-sm',
    accent: 'bg-accent text-ink hover:brightness-95 shadow-sm',
  }[variant];
  const sizes = { sm: 'h-8 px-3 text-sm gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-5 text-base gap-2' }[size];
  return (
    <button {...rest} disabled={disabled || loading}
      className={cx('inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap', styles, sizes, className)}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ layout
export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('bg-white rounded-[var(--radius-card)] border border-line shadow-[var(--shadow-card)]', className)}>{children}</div>;
}

export function CardHeader({ title, description, action }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description && <p className="text-sm text-muted mt-0.5">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: string }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6 animate-rise">
      <div>
        {eyebrow && <p className="text-xs font-semibold uppercase tracking-wider text-brand mb-1">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="text-muted mt-1 max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ data display
type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'accent';
const toneCls: Record<Tone, string> = {
  neutral: 'bg-surface text-muted border-line',
  brand: 'bg-brand-tint text-brand-dark border-brand/20',
  success: 'bg-success-tint text-success border-success/20',
  warning: 'bg-warning-tint text-warning border-warning/20',
  danger: 'bg-danger-tint text-danger border-danger/20',
  accent: 'bg-accent-tint text-[#7A5500] border-accent/30',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', toneCls[tone], className)}>{children}</span>;
}

export function Money({ pence, className, signed }: { pence: number | null | undefined; className?: string; signed?: boolean }) {
  if (pence === null || pence === undefined) return <span className={cx('text-subtle', className)}>—</span>;
  const s = formatGBP(pence);
  return <span className={cx('tabular', className)}>{signed && pence > 0 ? `+${s}` : s}</span>;
}

export function Stat({ label, value, sub, trend, icon }: { label: string; value: React.ReactNode; sub?: React.ReactNode; trend?: number | null; icon?: React.ReactNode }) {
  return (
    <Card className="p-5 animate-rise">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted">{label}</p>
        {icon && <span className="text-brand bg-brand-tint rounded-lg p-1.5" aria-hidden>{icon}</span>}
      </div>
      <p className="mt-2 text-[28px] leading-tight font-semibold tracking-tight tabular">{value}</p>
      <div className="mt-1 flex items-center gap-2 text-sm">
        {trend !== undefined && trend !== null && Number.isFinite(trend) && (
          <span className={cx('font-medium tabular', trend >= 0 ? 'text-success' : 'text-danger')}>
            {trend >= 0 ? '▲' : '▼'} {Math.abs(trend).toFixed(1)}%<span className="sr-only">{trend >= 0 ? ' up' : ' down'}</span>
          </span>
        )}
        {sub && <span className="text-subtle">{sub}</span>}
      </div>
    </Card>
  );
}

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx('relative overflow-x-auto', className)}>
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  );
}
export function Th({ children, className, align }: { children?: React.ReactNode; className?: string; align?: 'right' | 'center' }) {
  return <th scope="col" className={cx('px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-subtle bg-surface/60 border-b border-line text-start',
    align === 'right' && 'text-end', align === 'center' && 'text-center', className)}>{children}</th>;
}
export function Td({ children, className, align }: { children?: React.ReactNode; className?: string; align?: 'right' | 'center' }) {
  return <td className={cx('px-4 py-3 border-b border-line/70', align === 'right' && 'text-end tabular', align === 'center' && 'text-center', className)}>{children}</td>;
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-6">
      {icon && <div className="mb-3 rounded-full bg-brand-tint p-3 text-brand" aria-hidden>{icon}</div>}
      <p className="font-semibold">{title}</p>
      {children && <p className="text-sm text-muted mt-1 max-w-sm">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />;
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return <div className="p-5 space-y-3" role="status" aria-label={t("Loading")}>{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div role="alert" className="m-5 rounded-lg border border-danger/30 bg-danger-tint px-4 py-3 text-sm text-danger">{(error as Error).message}</div>;
}

// ------------------------------------------------------------------ forms
export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string | null; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">{label}</label>
      {hint && <p className="text-xs text-subtle" id={htmlFor ? `${htmlFor}-hint` : undefined}>{hint}</p>}
      {children}
      {error && <p className="text-sm font-medium text-danger" role="alert">{error}</p>}
    </div>
  );
}

const inputCls = 'block w-full h-10 rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-subtle shadow-xs focus:border-brand disabled:bg-surface';
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputCls, 'pe-8', props.className)} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputCls, 'h-auto py-2 min-h-20', props.className)} />;
}

/** £ input that works in integer pence. */
export function MoneyInput({ value, onChange, id, ...rest }: { value: number | null; onChange: (pence: number | null) => void; id?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value !== null ? (value / 100).toFixed(2) : '');
  useEffect(() => { if (value === null) setText(''); }, [value]);
  return (
    <div className="relative" dir="ltr">
      <span className="absolute start-3 top-1/2 -translate-y-1/2 text-sm text-subtle" aria-hidden>£</span>
      <Input {...rest} id={id} inputMode="decimal" value={text} className="ps-7 tabular"
        onChange={(e) => { setText(e.target.value); onChange(parsePounds(e.target.value)); }}
        onBlur={() => { const p = parsePounds(text); if (p !== null) setText((p / 100).toFixed(2)); }} />
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40', checked ? 'bg-brand' : 'bg-slate-300')}>
      <span className={cx('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0.5 rtl:-translate-x-0.5')} />
    </button>
  );
}

// ------------------------------------------------------------------ tabs
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line mb-5 overflow-x-auto">
      {tabs.map((it) => (
        <button key={it.id} role="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)}
          className={cx('px-3.5 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors',
            value === it.id ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink')}>
          {t(it.label)}
          {it.count !== undefined && <span className={cx('ms-2 rounded-full px-1.5 py-0.5 text-xs tabular', value === it.id ? 'bg-brand-tint' : 'bg-surface')}>{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ dialog
export function Modal({ open, onClose, title, description, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={titleId}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-2xl p-0 shadow-[var(--shadow-pop)] backdrop:bg-ink/40', wide ? 'max-w-3xl' : 'max-w-lg')}>
      {open && (
        <div className="animate-rise">
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
              {description && <p className="text-sm text-muted mt-1">{description}</p>}
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-subtle hover:bg-surface" aria-label={t("Close")}><X className="size-5" /></button>
          </div>
          <div className="px-6 py-5 space-y-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-surface/60 px-6 py-4 rounded-b-2xl">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ------------------------------------------------------------------ toasts
type ToastMsg = { id: number; tone: 'success' | 'danger' | 'neutral'; text: string };
const ToastCtx = createContext<(text: string, tone?: ToastMsg['tone']) => void>(() => {});
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const push = useCallback((text: string, tone: ToastMsg['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((it) => it.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 end-4 z-50 flex flex-col gap-2">
        {items.map((it) => (
          <div key={it.id} className={cx('animate-rise rounded-xl px-4 py-3 text-sm font-medium shadow-[var(--shadow-pop)] text-white max-w-sm',
            it.tone === 'success' ? 'bg-ink' : it.tone === 'danger' ? 'bg-danger' : 'bg-muted')}>
            {it.tone === 'success' && <span className="text-accent me-1.5" aria-hidden>✓</span>}{it.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
