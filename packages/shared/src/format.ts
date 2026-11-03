/** UK display formatting (en-GB, Europe/London). */
export const UK_LOCALE = 'en-GB';
export const UK_TIMEZONE = 'Europe/London';

export function formatDateUK(d: Date | string, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }): string {
  const date = typeof d === 'string' ? new Date(d.length === 10 ? `${d}T12:00:00Z` : d) : d;
  return new Intl.DateTimeFormat(UK_LOCALE, { timeZone: UK_TIMEZONE, ...opts }).format(date);
}

export function formatDateTimeUK(d: Date | string): string {
  return formatDateUK(d, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatTimeUK(d: Date | string): string {
  return formatDateUK(d, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatQuantity(q: number, unit: string = 'each'): string {
  if (unit === 'kg' || !Number.isInteger(q)) return `${q.toLocaleString(UK_LOCALE, { maximumFractionDigits: 3 })}${unit === 'each' ? '' : ` ${unit}`}`;
  return q.toLocaleString(UK_LOCALE);
}

export const VAT_LABELS: Record<string, string> = {
  S: 'Standard 20%', R: 'Reduced 5%', Z: 'Zero 0%', E: 'Exempt',
};

/** Today's date in the UK as YYYY-MM-DD. */
export function todayUK(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: UK_TIMEZONE }).format(now);
}

export function daysAgoUK(days: number, now: Date = new Date()): string {
  return todayUK(new Date(now.getTime() - days * 86400000));
}

export function parsePounds(input: string): number | null {
  const cleaned = input.replace(/[£,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [p, d = ''] = cleaned.split('.');
  return Number(p) * 100 + Number(d.padEnd(2, '0'));
}
