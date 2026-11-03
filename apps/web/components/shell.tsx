'use client';
import {
  BarChart3, Boxes, ChevronDown, ClipboardList, FileText, LayoutDashboard, LogOut, Menu, Package, Receipt, Settings,
  ShoppingCart, Users, Wallet, X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useMe } from '@/lib/me';
import { cx, Skeleton } from './ui';

const NAV = [
  { group: 'Shop', items: [
    { href: '/', label: 'Overview', icon: LayoutDashboard, perms: [] as string[] },
    { href: '/sales', label: 'Sales', icon: Receipt, perms: ['reports.sales', 'pos.sell'] },
    { href: '/tills', label: 'Tills & cash-up', icon: Wallet, perms: ['pos.z_report'] },
  ]},
  { group: 'Products', items: [
    { href: '/products', label: 'Products & prices', icon: Package, perms: ['products.view'] },
    { href: '/stock', label: 'Stock', icon: Boxes, perms: ['stock.view'] },
  ]},
  { group: 'Buying', items: [
    { href: '/purchasing', label: 'Ordering', icon: ShoppingCart, perms: ['purchasing.manage_list', 'purchasing.request'] },
    { href: '/invoices', label: 'Supplier invoices', icon: FileText, perms: ['invoices.upload', 'invoices.approve'] },
  ]},
  { group: 'Insights', items: [
    { href: '/reports', label: 'Reports', icon: BarChart3, perms: ['reports.sales'] },
    { href: '/vat', label: 'VAT return', icon: ClipboardList, perms: ['reports.financial', 'finance.vat'] },
  ]},
  { group: 'Business', items: [
    { href: '/staff', label: 'Staff & roles', icon: Users, perms: ['staff.view'] },
    { href: '/settings', label: 'Settings', icon: Settings, perms: ['branches.manage'] },
  ]},
];

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const { can, me } = useMe();
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
      {NAV.map((g) => {
        const items = g.items.filter((i) => i.perms.length === 0 || can(...i.perms));
        if (!me || items.length === 0) return null;
        return (
          <div key={g.group}>
            <p className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/50">{g.group}</p>
            <ul className="space-y-0.5">
              {items.map((i) => {
                const active = i.href === '/' ? path === '/' : path.startsWith(i.href);
                return (
                  <li key={i.href}>
                    <Link href={i.href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
                      className={cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        active ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white')}>
                      <i.icon className="size-[18px]" aria-hidden />{i.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-5 h-16">
      <div className="grid size-8 place-items-center rounded-lg bg-accent text-ink font-bold" aria-hidden>C</div>
      <span className="text-lg font-semibold tracking-tight text-white">Counter</span>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { me, branchId, setBranchId } = useMe();
  const [open, setOpen] = useState(false);
  const signOut = async () => { await fetch('/api/session', { method: 'DELETE' }); window.location.href = '/login'; };
  return (
    <div className="min-h-screen lg:pl-64">
      <a href="#main" className="skip-link">Skip to main content</a>
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-64 flex-col bg-brand-dark bg-[radial-gradient(120%_60%_at_0%_0%,#0E8079_0%,#095854_60%)]">
        <Brand />
        <Nav />
        <div className="border-t border-white/10 p-4 text-xs text-white/60">Data held in the UK · <a className="underline hover:text-white" href="https://ico.org.uk/for-organisations/" target="_blank" rel="noreferrer">UK GDPR</a></div>
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-brand-dark animate-rise">
            <div className="flex items-center justify-between pr-3"><Brand /><button className="p-2 text-white" aria-label="Close menu" onClick={() => setOpen(false)}><X /></button></div>
            <Nav onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-white/85 backdrop-blur px-4 sm:px-6">
        <button className="lg:hidden rounded-lg p-2 hover:bg-surface" aria-label="Open menu" onClick={() => setOpen(true)}><Menu className="size-5" /></button>
        <div className="flex min-w-0 items-center gap-2">
          {me ? (
            <>
              <span className="hidden truncate font-semibold sm:inline">{me.tenant.trading_name ?? me.tenant.legal_name}</span>
              {me.branches.length > 0 && (
                <div className="relative">
                  <label htmlFor="branch" className="sr-only">Branch</label>
                  <select id="branch" value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value)}
                    className="appearance-none rounded-full border border-line bg-surface py-1 pl-3 pr-8 text-sm font-medium text-muted hover:bg-white">
                    {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.code}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
                </div>
              )}
              {me.tenant.status === 'trial' && <span className="hidden sm:inline rounded-full bg-accent-tint px-2.5 py-0.5 text-xs font-semibold text-[#7A5500]">Free trial</span>}
            </>
          ) : <Skeleton className="h-6 w-48" />}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {me && (
            <div className="hidden sm:flex items-center gap-2.5">
              <div className="grid size-8 place-items-center rounded-full bg-brand-tint text-sm font-semibold text-brand" aria-hidden>
                {me.staff.first_name[0]}{me.staff.last_name?.[0] ?? ''}
              </div>
              <div className="leading-tight">
                <p className="text-sm font-medium">{me.staff.display_name}</p>
                <p className="text-xs text-subtle">{me.staff.role_name}</p>
              </div>
            </div>
          )}
          <button onClick={signOut} className="rounded-lg p-2 text-muted hover:bg-surface hover:text-ink" aria-label="Sign out" title="Sign out"><LogOut className="size-5" /></button>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
