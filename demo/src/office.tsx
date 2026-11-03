'use client';
/**
 * The real back-office pages (apps/web), mounted as a single-page app with an
 * in-memory router for the offline demo.
 */
import { createRoot } from 'react-dom/client';
import AuthLayout from '@/app/(auth)/layout';
import Login from '@/app/(auth)/login/page';
import Signup from '@/app/(auth)/signup/page';
import AppLayout from '@/app/(app)/layout';
import Overview from '@/app/(app)/page';
import Products from '@/app/(app)/products/page';
import Product from '@/app/(app)/products/[id]/page';
import Stock from '@/app/(app)/stock/page';
import Purchasing from '@/app/(app)/purchasing/page';
import Invoices from '@/app/(app)/invoices/page';
import Invoice from '@/app/(app)/invoices/[id]/page';
import Sales from '@/app/(app)/sales/page';
import Tills from '@/app/(app)/tills/page';
import Reports from '@/app/(app)/reports/page';
import Vat from '@/app/(app)/vat/page';
import Staff from '@/app/(app)/staff/page';
import Settings from '@/app/(app)/settings/page';
import NotFound from '@/app/not-found';
import { MemoryRouter } from './shims/router';
import { I18nProvider, useLang, type Lang } from '@/lib/i18n';
import { useEffect } from 'react';

declare global { interface Window { __officeLang?: { lang: Lang; setLang: (l: Lang) => void }; __onOfficeLang?: (l: Lang) => void } }

/** Lets the demo bar switch the back-office language, and keeps the pane's direction in step. */
function LangBridge() {
  const { lang, setLang } = useLang();
  useEffect(() => {
    window.__officeLang = { lang, setLang };
    const pane = document.getElementById('office-pane');
    if (pane) { pane.dir = lang === 'ar' ? 'rtl' : 'ltr'; pane.lang = lang === 'ar' ? 'ar' : 'en-GB'; }
    window.__onOfficeLang?.(lang);
  }, [lang, setLang]);
  return null;
}

const APP: [RegExp, React.ComponentType, string[]][] = [
  [/^\/$/, Overview, []], [/^\/products$/, Products, []], [/^\/products\/([^/]+)$/, Product, ['id']], [/^\/stock$/, Stock, []],
  [/^\/purchasing$/, Purchasing, []], [/^\/invoices$/, Invoices, []], [/^\/invoices\/([^/]+)$/, Invoice, ['id']], [/^\/sales$/, Sales, []],
  [/^\/tills$/, Tills, []], [/^\/reports$/, Reports, []], [/^\/vat$/, Vat, []], [/^\/staff$/, Staff, []], [/^\/settings$/, Settings, []],
];

function render(loc: { pathname: string }) {
  const signedIn = window.__demo?.signedIn;
  if (!signedIn || loc.pathname === '/login' || loc.pathname === '/signup') {
    const Page = loc.pathname === '/signup' ? Signup : Login;
    if (signedIn && loc.pathname !== '/signup') return render({ pathname: '/' });
    return { node: <AuthLayout><Page /></AuthLayout>, params: {} };
  }
  for (const [re, Page, keys] of APP) {
    const m = re.exec(loc.pathname);
    if (m) return { node: <AppLayout key="app"><Page key={loc.pathname} /></AppLayout>, params: Object.fromEntries(keys.map((k, i) => [k, m[i + 1]!])) };
  }
  return { node: <NotFound />, params: {} };
}

export function mountOffice(el: HTMLElement) {
  createRoot(el).render(<I18nProvider><LangBridge /><MemoryRouter initial="/login" render={render} /></I18nProvider>);
}
(window as unknown as { mountOffice: typeof mountOffice }).mountOffice = mountOffice;
