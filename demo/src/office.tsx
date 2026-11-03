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
  createRoot(el).render(<MemoryRouter initial="/login" render={render} />);
}
(window as unknown as { mountOffice: typeof mountOffice }).mountOffice = mountOffice;
