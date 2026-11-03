/**
 * Date formatting that follows the chosen language (UK time zone, Western
 * digits in both languages). Money always uses formatGBP from @retail/shared.
 */
import { currentLang } from './i18n';

const TZ = 'Europe/London';
const locale = () => (currentLang() === 'ar' ? 'ar-GB-u-nu-latn' : 'en-GB');
const toDate = (d: Date | string) => (typeof d === 'string' ? new Date(d.length === 10 ? `${d}T12:00:00Z` : d) : d);

export function formatDateUK(d: Date | string, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }): string {
  return new Intl.DateTimeFormat(locale(), { timeZone: TZ, ...opts }).format(toDate(d));
}
export function formatDateTimeUK(d: Date | string): string {
  return formatDateUK(d, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
export function formatTimeUK(d: Date | string): string {
  return formatDateUK(d, { hour: '2-digit', minute: '2-digit', hour12: false });
}
