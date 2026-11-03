'use client';
/* In-memory router used by the offline demo build of the back office. */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

interface Loc { pathname: string; search: string }
interface RouterCtx { loc: Loc; params: Record<string, string>; go: (href: string, replace?: boolean) => void }
const Ctx = createContext<RouterCtx>({ loc: { pathname: '/', search: '' }, params: {}, go: () => {} });

let goGlobal: (href: string, replace?: boolean) => void = () => {};
export const navigate = (href: string, replace = false) => goGlobal(href, replace);

export function MemoryRouter({ initial, render }: { initial: string; render: (loc: Loc) => { node: React.ReactNode; params: Record<string, string> } }) {
  const parse = (href: string): Loc => { const u = new URL(href, 'https://x'); return { pathname: u.pathname, search: u.search }; };
  const [stack, setStack] = useState<Loc[]>([parse(initial)]);
  const loc = stack[stack.length - 1]!;
  const go = (href: string, replace = false) => {
    setStack((s) => (replace ? [...s.slice(0, -1), parse(href)] : [...s, parse(href)]));
    document.getElementById('office-scroll')?.scrollTo?.(0, 0);
    window.scrollTo?.(0, 0);
  };
  goGlobal = go;
  useEffect(() => { (globalThis as { __counterNavigate?: (u: string) => void }).__counterNavigate = (u) => go(u, true); });
  const { node, params } = render(loc);
  const value = useMemo(() => ({ loc, params, go }), [loc, params]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={value}>{node}</Ctx.Provider>;
}

export const useRouterCtx = () => useContext(Ctx);
