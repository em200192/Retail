/** UK display formatting (en-GB, Europe/London). */
export const UK_LOCALE = 'en-GB';
export const UK_TIMEZONE = 'Europe/London';
/**
 * Arabic for UK shops: Arabic month/day names, but Western (Latin) digits —
 * the same digits as prices, receipts and the card terminal.
 */
export const ARABIC_UK_LOCALE = 'ar-GB-u-nu-latn';

const EASTERN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/** Turns Arabic-Indic / Persian digits into 0-9 (some runtimes ignore `-u-nu-latn`). */
export function latinDigits(s: string): string {
  return s.replace(EASTERN_DIGITS, (c) => String((c.charCodeAt(0) - (c.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660))));
}

/**
 * Formats a date in Europe/London. `locale` defaults to en-GB; pass
 * ARABIC_UK_LOCALE for Arabic names. Digits are always 0-9.
 */
export function formatDateUK(
  d: Date | string,
  opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' },
  locale: string = UK_LOCALE,
): string {
  const date = typeof d === 'string' ? new Date(d.length === 10 ? `${d}T12:00:00Z` : d) : d;
  return latinDigits(new Intl.DateTimeFormat(locale, { timeZone: UK_TIMEZONE, ...opts }).format(date));
}

export function formatDateTimeUK(d: Date | string, locale: string = UK_LOCALE): string {
  return formatDateUK(d, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }, locale);
}

export function formatTimeUK(d: Date | string, locale: string = UK_LOCALE): string {
  return formatDateUK(d, { hour: '2-digit', minute: '2-digit', hour12: false }, locale);
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
