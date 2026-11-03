'use client';
/**
 * Back-office translations. English text is the key; Arabic lives in
 * lib/i18n/ar.ts. Missing keys show in English. The chosen language is kept
 * on this device and switches the whole page to right-to-left.
 */
import { createContext, Fragment, useContext, useEffect, useState } from 'react';
import { AR } from './i18n/ar';

export type Lang = 'en' | 'ar';
export const LANGS: { id: Lang; label: string; short: string }[] = [{ id: 'en', label: 'English', short: 'EN' }, { id: 'ar', label: 'العربية', short: 'عربي' }];

let current: Lang = 'en';
export const currentLang = () => current;

/** Translate a fixed string. `{name}` placeholders are filled from `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  let s = text;
  if (current === 'ar') {
    if (text in AR) s = AR[text]!;
    else if (typeof window !== 'undefined' && text && /[A-Za-z]/.test(text)) {
      // Collected so missing translations can be found (window.__i18nMissing in the console).
      ((window as unknown as { __i18nMissing?: Set<string> }).__i18nMissing ??= new Set()).add(text);
    }
  }
  if (!vars) return s;
  // In Arabic, keep values like "£1.29" or "MAN1-01-0042" left-to-right inside the sentence (Unicode isolate).
  const iso = (v: string) => (current === 'ar' && /[A-Za-z0-9£]/.test(v) ? `\u2066${v}\u2069` : v);
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? iso(String(vars[k])) : m));
}

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('counter.lang');
    if (saved === 'ar' || saved === 'en') return saved;
  } catch { /* storage blocked */ }
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('ar') ? 'ar' : 'en';
}

function apply(lang: Lang) {
  current = lang;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang === 'ar' ? 'ar' : 'en-GB';
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }
}

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => {} });

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');
  const [ready, setReady] = useState(false);
  useEffect(() => { const l = initialLang(); apply(l); setLangState(l); setReady(true); }, []);
  const setLang = (l: Lang) => {
    apply(l);
    try { localStorage.setItem('counter.lang', l); } catch { /* ignore */ }
    setLangState(l);
  };
  // Re-mount on change so every t() call renders in the new language.
  return <Ctx.Provider value={{ lang, setLang }}><Fragment key={ready ? lang : 'boot'}>{children}</Fragment></Ctx.Provider>;
}

export const useLang = () => useContext(Ctx);

/** "English | العربية" switch. */
export function LanguageSwitch({ className = '', dark = false }: { className?: string; dark?: boolean }) {
  const { lang, setLang } = useLang();
  return (
    <div role="group" aria-label="Language / اللغة" className={`inline-flex shrink-0 rounded-full p-0.5 text-xs font-semibold ${dark ? 'bg-white/10' : 'bg-surface border border-line'} ${className}`}>
      {LANGS.map((l) => (
        <button key={l.id} type="button" onClick={() => setLang(l.id)} aria-pressed={lang === l.id} lang={l.id} aria-label={l.label}
          className={`rounded-full px-2.5 py-1 transition-colors ${lang === l.id ? (dark ? 'bg-white text-ink' : 'bg-white text-ink shadow-sm') : dark ? 'text-white/75 hover:text-white' : 'text-muted hover:text-ink'}`}>
          <span className="sm:hidden" aria-hidden>{l.short}</span><span className="hidden sm:inline">{l.label}</span>
        </button>
      ))}
    </div>
  );
}
