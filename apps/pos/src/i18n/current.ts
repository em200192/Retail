/**
 * The current till language and `t()` / `tn()` — plain TypeScript (no React
 * Native), so pure logic such as the pairing-code parser can translate its
 * errors and still run in unit tests. Persistence, the React hook and the web
 * <html dir> live in ./index.ts.
 */
import { DEFAULT_LANG, isolateLtr, type Lang, LANGUAGES, type MessageKey, type PluralBase, translate, translatePlural, type Vars } from './core';

let current: Lang = DEFAULT_LANG;
let version = 0;
const listeners = new Set<() => void>();

export function getLang(): Lang { return current; }
export function isRTL(lang: Lang = current): boolean { return LANGUAGES[lang].dir === 'rtl'; }

/** Changes the language in memory and notifies subscribers. Returns false if unchanged. */
export function setCurrentLang(lang: Lang): boolean {
  if (lang === current) return false;
  current = lang;
  notifyLang();
  return true;
}

export function notifyLang() {
  version++;
  for (const l of listeners) l();
}
export function langVersion(): number { return version; }
export function subscribeLang(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function t(key: MessageKey, vars?: Vars): string { return translate(current, key, vars); }
export function tn(base: PluralBase, count: number, vars?: Vars): string { return translatePlural(current, base, count, vars); }
/** Translate into a specific language (the customer receipt). */
export function tIn(lang: Lang, key: MessageKey, vars?: Vars): string { return translate(lang, key, vars); }
/** Keeps a money figure / receipt number / barcode left-to-right inside Arabic text. */
export function ltr(s: string, lang: Lang = current): string { return isolateLtr(s, lang); }
