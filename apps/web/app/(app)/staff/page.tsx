'use client';
import { formatDateUK } from '@retail/shared';
import { KeyRound, Lock, Plus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, LoadingRows, Modal, PageHeader, Select, Table, Tabs, Td, Th, Toggle, useToast } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useMe } from '@/lib/me';

const MODULES: Record<string, string> = { pos: 'Till', catalog: 'Products & prices', stock: 'Stock', purchasing: 'Buying', customers: 'Customers', orders: 'Online orders',
  hr: 'People', tasks: 'Tasks', training: 'Training', reports: 'Reports', finance: 'Finance', ai: 'Insights', admin: 'Admin' };
const LIMIT_LABEL: Record<string, string> = {
  'pos.discount.max_percent': 'Biggest discount (%)', 'pos.discount.max_amount_pence': 'Biggest discount (£)', 'pos.price_override.max_percent': 'Biggest price cut (%)',
  'pos.refund.max_amount_pence': 'Biggest refund (£)', 'pos.paid_out.max_amount_pence': 'Biggest paid-out (£)', 'pos.void_line.max_per_shift': 'Line voids per shift',
  'pos.no_sale.max_per_shift': 'No-sales per shift', 'stock.adjust.max_qty': 'Biggest stock adjustment (units)',
};
const EMPLOYMENT: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', zero_hours: 'Zero hours', casual: 'Casual', contractor: 'Contractor' };

export default function StaffPage() {
  const { can } = useMe();
  const [tab, setTab] = useState<'people' | 'roles'>('people');
  return (
    <>
      <PageHeader title="Staff & roles" description="Who works in your shops, what they can do, and the limits that need a manager’s PIN." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'people', label: 'People' }, ...(can('roles.manage') ? [{ id: 'roles' as const, label: 'Roles & permissions' }] : [])]} />
      {tab === 'people' ? <People /> : <Roles />}
    </>
  );
}

function People() {
  const { can, me } = useMe();
  const toast = useToast();
  const staff = useApi<any[]>('/v1/staff');
  const roles = useApi<any[]>('/v1/roles');
  const [adding, setAdding] = useState(false);
  const [pinFor, setPinFor] = useState<any | null>(null);
  const branchName = new Map((me?.branches ?? []).map((b) => [b.id, b.name]));
  return (
    <Card>
      <CardHeader title={`${staff.data?.filter((s) => s.status === 'active').length ?? '…'} active staff`}
        action={can('staff.manage') && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add staff</Button>} />
      {staff.isLoading ? <LoadingRows /> : !staff.data?.length ? <EmptyState icon={<Users className="size-6" />} title="No staff yet" /> : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Role</Th><Th>Branches</Th><Th>Contract</Th><Th>Till PIN</Th><Th>Status</Th>{can('staff.manage') && <Th><span className="sr-only">Actions</span></Th>}</tr></thead>
          <tbody>{staff.data.map((s) => (
            <tr key={s.id}>
              <Td><div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-full bg-brand-tint text-xs font-semibold text-brand" aria-hidden>{s.first_name[0]}{s.last_name?.[0] ?? ''}</span>
                <div><p className="font-medium">{s.first_name} {s.last_name}</p>{s.email && <p className="text-xs text-subtle">{s.email}</p>}</div></div></Td>
              <Td>{s.role_name}</Td>
              <Td className="text-muted">{s.branch_ids.map((b: string) => branchName.get(b)).filter(Boolean).join(', ') || 'All (owner)'}</Td>
              <Td className="text-muted">{EMPLOYMENT[s.employment_type]}{s.start_date && <span className="block text-xs">since {formatDateUK(s.start_date, { month: 'short', year: 'numeric' })}</span>}</Td>
              <Td>{s.has_pin ? <Badge tone="success">Set</Badge> : <Badge tone="warning">Not set</Badge>}</Td>
              <Td><Badge tone={s.status === 'active' ? 'success' : 'neutral'}>{s.status === 'left' ? 'Left' : s.status[0].toUpperCase() + s.status.slice(1)}</Badge></Td>
              {can('staff.manage') && <Td align="right"><Button size="sm" variant="ghost" icon={<KeyRound className="size-4" />} onClick={() => setPinFor(s)}>{s.has_pin ? 'Reset PIN' : 'Set PIN'}</Button></Td>}
            </tr>
          ))}</tbody>
        </Table>
      )}
      {adding && <AddStaff roles={roles.data ?? []} onClose={() => setAdding(false)} onDone={(n) => { staff.mutate(); toast(`${n} added — they can sign in at the till with their PIN`); }} />}
      {pinFor && <PinModal person={pinFor} onClose={() => setPinFor(null)} onDone={() => { staff.mutate(); toast(`PIN updated for ${pinFor.first_name}`); }} />}
    </Card>
  );
}

function AddStaff({ roles, onClose, onDone }: { roles: any[]; onClose: () => void; onDone: (name: string) => void }) {
  const { me, branchId } = useMe();
  const [f, setF] = useState({ first_name: '', last_name: '', email: '', role_id: '', employment_type: 'part_time', date_of_birth: '', start_date: '', pin: '' });
  const [branches, setBranches] = useState<string[]>(branchId ? [branchId] : []);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!f.role_id && roles.length) setF((x) => ({ ...x, role_id: roles.find((r) => r.system_key === 'cashier')?.id ?? roles[0].id })); }, [roles, f.role_id]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    if (!f.first_name.trim()) return setErr('Enter their first name');
    if (f.pin && !/^\d{4,8}$/.test(f.pin)) return setErr('The PIN must be 4 to 8 digits');
    if (!branches.length) return setErr('Choose at least one branch');
    try {
      await api('/v1/staff', { body: { first_name: f.first_name.trim(), last_name: f.last_name || null, email: f.email || null, role_id: f.role_id,
        employment_type: f.employment_type, date_of_birth: f.date_of_birth || null, start_date: f.start_date || null, branch_ids: branches, pin: f.pin || undefined } });
      onDone(f.first_name); onClose();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal open onClose={onClose} title="Add a member of staff" wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit}>Add staff</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="fn"><Input id="fn" value={f.first_name} onChange={set('first_name')} autoComplete="off" /></Field>
        <Field label="Last name" htmlFor="ln"><Input id="ln" value={f.last_name} onChange={set('last_name')} autoComplete="off" /></Field>
        <Field label="Email (optional)" htmlFor="em" hint="Needed to use the back office."><Input id="em" type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Role" htmlFor="ro"><Select id="ro" value={f.role_id} onChange={set('role_id')}>
          {roles.filter((r) => r.system_key !== 'owner' || me?.staff.role_key === 'owner').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
        <Field label="Contract" htmlFor="ct"><Select id="ct" value={f.employment_type} onChange={set('employment_type')}>
          {Object.entries(EMPLOYMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Date of birth" htmlFor="dob" hint="Used to check National Minimum Wage age bands."><Input id="dob" type="date" value={f.date_of_birth} onChange={set('date_of_birth')} /></Field>
        <Field label="Start date" htmlFor="sd"><Input id="sd" type="date" value={f.start_date} onChange={set('start_date')} /></Field>
        <Field label="Till PIN" htmlFor="pin" hint="4–8 digits. They can change it later."><Input id="pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={f.pin}
          onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} /></Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Works at</legend>
        <div className="flex flex-wrap gap-2">{(me?.branches ?? []).map((b) => (
          <label key={b.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${branches.includes(b.id) ? 'border-brand bg-brand-tint' : 'border-line'}`}>
            <input type="checkbox" className="accent-[var(--color-brand)]" checked={branches.includes(b.id)}
              onChange={(e) => setBranches(e.target.checked ? [...branches, b.id] : branches.filter((x) => x !== b.id))} />{b.name}</label>
        ))}</div>
      </fieldset>
    </Modal>
  );
}

function PinModal({ person, onClose, onDone }: { person: any; onClose: () => void; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={`New PIN for ${person.first_name}`} description="Tell them their new PIN in person. Never write it down at the till."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={async () => {
        if (!/^\d{4,8}$/.test(pin)) return setErr('The PIN must be 4 to 8 digits');
        try { await api(`/v1/staff/${person.id}/pin`, { method: 'PUT', body: { pin } }); onDone(); onClose(); } catch (e) { setErr((e as Error).message); }
      }}>Save PIN</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <Field label="PIN" htmlFor="np"><Input id="np" type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} className="text-center text-2xl tracking-[0.5em]" autoFocus /></Field>
    </Modal>
  );
}

function Roles() {
  const toast = useToast();
  const roles = useApi<any[]>('/v1/roles');
  const catalog = useApi<{ permissions: any[]; limits: any[] }>('/v1/permissions');
  const [sel, setSel] = useState<string | null>(null);
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const role = roles.data?.find((r) => r.id === sel) ?? roles.data?.[0];
  useEffect(() => {
    if (!role) return;
    setSel(role.id); setPerms(new Set(role.permissions));
    setLimits(Object.fromEntries(Object.entries(role.limits as Record<string, number>).map(([k, v]) => [k, k.endsWith('_pence') ? (v / 100).toString() : String(v)])));
  }, [role?.id, roles.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (roles.isLoading || catalog.isLoading || !role) return <Card><LoadingRows rows={8} /></Card>;
  const locked = role.system_key === 'owner';
  const byModule = new Map<string, any[]>();
  for (const p of catalog.data?.permissions ?? []) byModule.set(p.module, [...(byModule.get(p.module) ?? []), p]);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/v1/roles/${role.id}/permissions`, { method: 'PUT', body: { permissions: [...perms] } });
      await api(`/v1/roles/${role.id}/limits`, { method: 'PUT', body: { limits: Object.fromEntries((catalog.data?.limits ?? []).map((l) => {
        const raw = limits[l.code]; if (raw === undefined || raw === '') return [l.code, null];
        return [l.code, l.unit === 'pence' ? Math.round(Number(raw) * 100) : Number(raw)];
      })) } });
      await roles.mutate(); toast(`${role.name} updated. Tills pick this up on their next sync.`);
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <Card className="h-fit p-2">
        <ul>{roles.data?.map((r) => (
          <li key={r.id}><button onClick={() => setSel(r.id)} aria-current={r.id === role.id}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm font-medium ${r.id === role.id ? 'bg-brand-tint text-brand-dark' : 'hover:bg-surface'}`}>
            {r.name}<span className="text-xs font-normal text-subtle">{r.permissions.length}</span></button></li>
        ))}</ul>
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader title={role.name} description={locked ? 'The owner always has every permission and no limits.' : role.description}
            action={!locked && <Button onClick={save} loading={busy}>Save changes</Button>} />
          {locked && <p className="mx-5 mb-5 flex items-center gap-2 rounded-lg bg-surface p-3 text-sm text-muted"><Lock className="size-4" aria-hidden />Locked</p>}
          {!locked && (
            <div className="grid gap-x-8 gap-y-6 px-5 pb-5 md:grid-cols-2">
              {[...byModule.entries()].map(([mod, list]) => (
                <fieldset key={mod}>
                  <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">{MODULES[mod] ?? mod}</legend>
                  <ul className="space-y-1">{list.map((p) => (
                    <li key={p.code} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-surface">
                      <span className="text-sm">{p.description}</span>
                      <Toggle label={p.description} checked={perms.has(p.code)} onChange={(v) => { const n = new Set(perms); v ? n.add(p.code) : n.delete(p.code); setPerms(n); }} />
                    </li>
                  ))}</ul>
                </fieldset>
              ))}
            </div>
          )}
        </Card>
        {!locked && (
          <Card>
            <CardHeader title="Limits" description="Above a limit, a manager approves with their PIN. Leave blank to always ask a manager." />
            <div className="grid gap-4 px-5 pb-5 sm:grid-cols-2">
              {(catalog.data?.limits ?? []).map((l) => (
                <Field key={l.code} label={LIMIT_LABEL[l.code] ?? l.description} htmlFor={l.code}>
                  <div className="relative">
                    {l.unit === 'pence' && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-subtle" aria-hidden>£</span>}
                    <Input id={l.code} inputMode="decimal" value={limits[l.code] ?? ''} placeholder="Manager approval" className={l.unit === 'pence' ? 'pl-7' : ''}
                      onChange={(e) => setLimits({ ...limits, [l.code]: e.target.value.replace(/[^\d.]/g, '') })} />
                    {l.unit === 'percent' && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-subtle" aria-hidden>%</span>}
                  </div>
                </Field>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
