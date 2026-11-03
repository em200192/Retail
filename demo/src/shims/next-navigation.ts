'use client';
import { navigate, useRouterCtx } from './router';

export function useRouter() {
  return { push: (h: string) => navigate(h), replace: (h: string) => navigate(h, true), back: () => history.back(), refresh: () => {}, prefetch: () => {} };
}
export function usePathname() { return useRouterCtx().loc.pathname; }
export function useSearchParams() { return new URLSearchParams(useRouterCtx().loc.search); }
export function useParams<T extends Record<string, string>>() { return useRouterCtx().params as T; }
export function redirect(h: string): never { navigate(h, true); throw new Error('redirect'); }
