/**
 * Till language at runtime: persisted on the device (kv store), a React hook
 * that re-renders on change, the web <html dir/lang>, and direction helpers.
 *
 * RTL: we do NOT use I18nManager.forceRTL (it only takes effect after an app
 * restart on iOS/Android). Instead the root view, every Sheet (a native Modal is
 * its own root) and the web <html dir> get the direction, so switching is
 * instant. Flexbox rows, marginStart/End and text alignment follow it; keypads,
 * money and receipt numbers opt out with `direction: 'ltr'` / ltr().
 */
import { formatDateTimeUK, formatDateUK, formatTimeUK } from '@retail/shared';
import { useSyncExternalStore } from 'react';
import { Platform, type TextStyle, type ViewStyle } from 'react-native';
import { kv } from '../storage/kv';
import { isLang, type Lang, LANGUAGES, translate } from './core';
import { getLang, isRTL, langVersion, notifyLang, setCurrentLang, subscribeLang, t } from './current';

export { LANGS, LANGUAGES, type Lang, type MessageKey } from './core';
export { getLang, isRTL, ltr, t, tIn, tn } from './current';

/** Customer receipt: English (default — UK customers) or the till's language. */
export type ReceiptLanguageMode = 'en' | 'till';
let receiptMode: ReceiptLanguageMode = 'en';

export function setLanguage(lang: Lang) {
  if (!setCurrentLang(lang)) return;
  applyDocument();
  void kv.set('lang', lang).catch(() => {});
}

export function getReceiptMode(): ReceiptLanguageMode { return receiptMode; }
export function setReceiptMode(mode: ReceiptLanguageMode) {
  if (mode === receiptMode) return;
  receiptMode = mode;
  notifyLang();
  void kv.set('receipt_lang', mode).catch(() => {});
}
/** The language the customer receipt is printed in. */
export function receiptLang(): Lang { return receiptMode === 'till' ? getLang() : 'en'; }

/** Restores the saved choice (called once from boot(), before the first screen). */
export async function loadLanguage() {
  try {
    const saved = await kv.get<string>('lang');
    if (isLang(saved)) setCurrentLang(saved);
    const mode = await kv.get<string>('receipt_lang');
    if (mode === 'en' || mode === 'till') receiptMode = mode;
  } catch { /* first run: English */ }
  applyDocument();
  notifyLang();
}

/** Subscribes a component to language changes; returns the current language. */
export function useLang(): Lang {
  useSyncExternalStore(subscribeLang, langVersion, langVersion);
  return getLang();
}
export function useReceiptLang(): Lang {
  useSyncExternalStore(subscribeLang, langVersion, langVersion);
  return receiptLang();
}

// ------------------------------------------------------------------ direction helpers
/** For the root view and Sheets. */
export function dirStyle(lang: Lang = getLang()): ViewStyle {
  return { direction: LANGUAGES[lang].dir };
}
/** Something that must stay left-to-right in every language (keypads, PIN dots, card graphic). */
export const LTR: ViewStyle = { direction: 'ltr' };
export const LTR_TEXT: TextStyle = { writingDirection: 'ltr' };
/**
 * Text style per language. Arabic is cursive: letter-spacing breaks the joins,
 * so it is reset. On native, the base writing direction is set explicitly too.
 */
export function textDir(lang: Lang = getLang()): TextStyle | null {
  if (!isRTL(lang)) return null;
  // textAlign: react-native-web gives every Text dir="auto" + text-align:start, so an English product
  // name or an LTR-isolated amount would otherwise sit on the left of an Arabic screen.
  // Put textDir() BEFORE any textAlign: 'center' in a style array.
  return Platform.OS === 'web' ? { letterSpacing: 0, textAlign: 'right' } : { letterSpacing: 0, writingDirection: 'rtl', textAlign: 'right' };
}

// ------------------------------------------------------------------ dates (Latin digits in every language)
export function fmtDateTime(d: Date | string, lang: Lang = getLang()): string { return formatDateTimeUK(d, LANGUAGES[lang].dateLocale); }
export function fmtTime(d: Date | string, lang: Lang = getLang()): string { return formatTimeUK(d, LANGUAGES[lang].dateLocale); }
export function fmtDate(d: Date | string, opts?: Intl.DateTimeFormatOptions, lang: Lang = getLang()): string {
  return formatDateUK(d, opts, LANGUAGES[lang].dateLocale);
}

// ------------------------------------------------------------------ labels for codes
const VAT_CODES = ['S', 'R', 'Z', 'E'] as const;
type VatCode = (typeof VAT_CODES)[number];
const isVat = (c: string): c is VatCode => (VAT_CODES as readonly string[]).includes(c);
export function vatLabel(code: string, lang: Lang = getLang()): string {
  return isVat(code) ? translate(lang, `vat.${code}`) : code;
}
export function vatShort(code: string, ratePercent: number | string, lang: Lang = getLang()): string {
  return isVat(code) ? translate(lang, `vat.short.${code}`) : `${ratePercent}%`;
}
const ROLES = ['owner', 'manager', 'supervisor', 'cashier', 'stock'] as const;
type RoleKey = (typeof ROLES)[number];
export function roleLabel(roleKey: string | null | undefined): string {
  return roleKey && (ROLES as readonly string[]).includes(roleKey) ? t(`role.${roleKey as RoleKey}`) : t('role.staff');
}

// ------------------------------------------------------------------ web document
const ARABIC_FONT_CSS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap';

function applyDocument() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const info = LANGUAGES[getLang()];
  document.documentElement.dir = info.dir;
  document.documentElement.lang = info.htmlLang;
  document.title = t('app.title');
  // Arabic web font (pairs with Inter). Offline / blocked, the system Arabic font is used instead.
  if (getLang() === 'ar' && !document.getElementById('counter-font-ar')) {
    const link = document.createElement('link');
    link.id = 'counter-font-ar';
    link.rel = 'stylesheet';
    link.href = ARABIC_FONT_CSS;
    document.head.appendChild(link);
  }
}
