/**
 * Pure i18n core (no React, no storage): dictionaries, lookup with English
 * fallback, {placeholder} interpolation and plural selection. Unit tested.
 *
 * Adding a language: write `xx.ts` (a Dictionary), add it to LANGUAGES with its
 * direction, date locale and plural rule. Nothing else changes.
 */
import { ARABIC_UK_LOCALE, UK_LOCALE } from '@retail/shared';
import { ar } from './ar';
import { en, type MessageKey } from './en';

export type { MessageKey } from './en';
/** Keys that have plural forms: `base.one` / `base.other` in English. */
export type PluralBase = { [K in MessageKey]: K extends `${infer B}.other` ? B : never }[MessageKey];
/** A translation: any English key, plus the extra plural forms some languages need. */
export type Dictionary = Partial<Record<MessageKey | `${PluralBase}.${'zero' | 'two' | 'few' | 'many'}`, string>>;
export type Vars = Record<string, string | number>;
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export interface LanguageInfo {
  /** The language's own name, shown in the switch whatever the current language is. */
  nativeName: string;
  dir: 'ltr' | 'rtl';
  /** BCP 47 tag for <html lang> / screen readers. */
  htmlLang: string;
  /** Locale for dates (digits are always 0-9, see @retail/shared formatDateUK). */
  dateLocale: string;
  dict: Dictionary;
  plural: (n: number) => PluralCategory;
}

const englishPlural = (n: number): PluralCategory => (n === 1 ? 'one' : 'other');

/** CLDR plural rules for Arabic (integers; fractions are "other"). */
export function arabicPlural(n: number): PluralCategory {
  if (!Number.isInteger(n)) return 'other';
  const a = Math.abs(n);
  if (a === 0) return 'zero';
  if (a === 1) return 'one';
  if (a === 2) return 'two';
  const m = a % 100;
  if (m >= 3 && m <= 10) return 'few';
  if (m >= 11 && m <= 99) return 'many';
  return 'other';
}

export const LANGUAGES = {
  en: { nativeName: 'English', dir: 'ltr', htmlLang: 'en-GB', dateLocale: UK_LOCALE, dict: en, plural: englishPlural },
  ar: { nativeName: 'العربية', dir: 'rtl', htmlLang: 'ar', dateLocale: ARABIC_UK_LOCALE, dict: ar, plural: arabicPlural },
} satisfies Record<string, LanguageInfo>;

export type Lang = keyof typeof LANGUAGES;
export const LANGS = Object.keys(LANGUAGES) as Lang[];
export const DEFAULT_LANG: Lang = 'en';

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, v);
}

// Unicode bidi isolates: keep an inserted value (an amount, a receipt number,
// an English product name) in its own direction inside right-to-left text.
const FSI = '⁨';
const LRI = '⁦';
const PDI = '⁩';

/** Forces left-to-right for a value shown in RTL text (money, receipt numbers, barcodes). */
export function isolateLtr(s: string, lang: Lang): string {
  return LANGUAGES[lang].dir === 'rtl' ? `${LRI}${s}${PDI}` : s;
}

export function interpolate(template: string, vars: Vars | undefined, lang: Lang): string {
  if (!vars) return template;
  const rtl = LANGUAGES[lang].dir === 'rtl';
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
    const v = String(vars[name]);
    return rtl ? `${FSI}${v}${PDI}` : v;
  });
}

/** Looks a key up in `lang`, falling back to English, then to the key itself. */
export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  const own = LANGUAGES[lang].dict[key];
  if (own !== undefined) return interpolate(own, vars, lang);
  // English fallback: interpolate as English text would be (no isolates needed for LTR).
  const fallback = (en as Record<string, string>)[key];
  return interpolate(fallback ?? key, vars, fallback !== undefined ? 'en' : lang);
}

/**
 * Plural lookup: `{base}.{category}` in `lang`, then `{base}.other` in `lang`,
 * then English. `{count}` is filled in automatically.
 */
export function translatePlural(lang: Lang, base: PluralBase, count: number, vars?: Vars): string {
  const info = LANGUAGES[lang];
  const all: Vars = { count, ...vars };
  const own = info.dict as Record<string, string | undefined>;
  const hit = own[`${base}.${info.plural(count)}`] ?? own[`${base}.other`];
  if (hit !== undefined) return interpolate(hit, all, lang);
  const e = en as Record<string, string>;
  return interpolate(e[`${base}.${englishPlural(count)}`] ?? e[`${base}.other`] ?? base, all, 'en');
}

/** Placeholder names used in a template, e.g. "Pay {amount}" -> ["amount"]. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}
