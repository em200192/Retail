'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useApi } from './api';

export interface Me {
  staff: { id: string; first_name: string; last_name: string | null; display_name: string; email: string | null; role_name: string; role_key: string | null };
  tenant: { id: string; legal_name: string; trading_name: string | null; vat_number: string | null; vat_registered: boolean; status: string };
  branches: { id: string; code: string; name: string }[];
  permissions: string[];
  limits: Record<string, number>;
}

interface Ctx {
  me: Me | undefined;
  branchId: string | null;
  branch: Me['branches'][number] | undefined;
  setBranchId: (id: string) => void;
  can: (...perms: string[]) => boolean;
  reload: () => void;
}

const MeCtx = createContext<Ctx>({ me: undefined, branchId: null, branch: undefined, setBranchId: () => {}, can: () => false, reload: () => {} });

export function MeProvider({ children }: { children: React.ReactNode }) {
  const { data, mutate } = useApi<Me>('/v1/me');
  const [branchId, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    let saved: string | null = null;
    try { saved = localStorage.getItem('counter.branch'); } catch { /* private mode */ }
    const valid = data.branches.find((b) => b.id === saved) ?? data.branches[0];
    setBranch(valid?.id ?? null);
  }, [data]);
  const value = useMemo<Ctx>(() => ({
    me: data,
    branchId,
    branch: data?.branches.find((b) => b.id === branchId),
    setBranchId: (id) => { setBranch(id); try { localStorage.setItem('counter.branch', id); } catch { /* ignore */ } },
    can: (...perms) => !!data && perms.some((p) => data.permissions.includes(p)),
    reload: () => void mutate(),
  }), [data, branchId, mutate]);
  return <MeCtx.Provider value={value}>{children}</MeCtx.Provider>;
}

export const useMe = () => useContext(MeCtx);
