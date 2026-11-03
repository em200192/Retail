'use client';
import { formatDateTimeUK } from '@/lib/format';
import { Copy, MonitorSmartphone, Plus, Store } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, LoadingRows, Modal, PageHeader, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useMe } from '@/lib/me';
import { t } from '@/lib/i18n';

const KIND: Record<string, string> = { pos: 'Till', handheld: 'Handheld scanner', self_checkout: 'Self-checkout', label_printer: 'Label printer', scale: 'Scale',
  customer_display: 'Customer display', back_office: 'Back-office PC' };
const API_PUBLIC = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function SettingsPage() {
  const { me, reload } = useMe();
  const toast = useToast();
  const branches = useApi<any[]>('/v1/branches');
  const devices = useApi<any[]>('/v1/devices');
  const [addBranch, setAddBranch] = useState(false);
  const [addDevice, setAddDevice] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; name: string } | null>(null);
  const branchName = new Map((branches.data ?? []).map((b) => [b.id, b.name]));

  return (
    <>
      <PageHeader title={t("Settings")} description={t("Your business, shops and the devices that connect to them.")} />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="h-fit">
          <CardHeader title={t("Business")} />
          <dl className="space-y-3 px-5 pb-5 text-sm">
            {[[t('Registered name'), me?.tenant.legal_name], [t('Trading as'), me?.tenant.trading_name ?? '—'],
              [t('VAT'), me?.tenant.vat_registered ? me.tenant.vat_number ?? t('Registered (number not added)') : t('Not VAT registered')],
              [t('Plan'), me?.tenant.status === 'trial' ? t('Free trial') : me?.tenant.status]].map(([k, v]) => (
              <div key={k}><dt className="text-subtle">{k}</dt><dd className="font-medium">{v}</dd></div>
            ))}
          </dl>
          <p className="border-t border-line px-5 py-4 text-xs text-subtle">{t("Your data is stored in the UK (London) and processed under UK GDPR. You can export or delete your data at any time by contacting support.")}</p>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader title={t("Shops")} action={<Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAddBranch(true)}>{t("Add shop")}</Button>} />
          {branches.isLoading ? <LoadingRows rows={2} /> : (
            <Table>
              <thead><tr><Th>{t("Shop")}</Th><Th>{t("Code")}</Th><Th>{t("Address")}</Th><Th>{t("Status")}</Th></tr></thead>
              <tbody>{(branches.data ?? []).map((b) => (
                <tr key={b.id}><Td className="font-medium">{b.name}</Td><Td className="font-mono text-xs">{b.code}</Td>
                  <Td className="text-muted">{[b.address_line1, b.city, b.postcode].filter(Boolean).join(', ') || '—'}</Td>
                  <Td><Badge tone={b.is_active ? 'success' : 'neutral'}>{b.is_active ? t('Open') : t('Closed')}</Badge></Td></tr>
              ))}</tbody>
            </Table>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title={t("Tills & devices")} description={t("Each till gets a number that appears in its receipt numbers, e.g. MAN1-2-1043.")}
          action={<Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAddDevice(true)}>{t("Register a till")}</Button>} />
        {devices.isLoading ? <LoadingRows rows={2} /> : !devices.data?.length ? (
          <EmptyState icon={<MonitorSmartphone className="size-6" />} title={t("No tills yet")} action={<Button onClick={() => setAddDevice(true)}>{t("Register your first till")}</Button>}>
            {t("Install the Counter till app on an iPad or Android tablet, then pair it here.")}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>{t("Device")}</Th><Th>{t("Shop")}</Th><Th align="center">{t("Till no.")}</Th><Th>{t("Last synced")}</Th><Th>{t("Status")}</Th><Th><span className="sr-only">{t("Actions")}</span></Th></tr></thead>
            <tbody>{devices.data.map((d) => (
              <tr key={d.id}>
                <Td><p className="font-medium">{d.name}</p><p className="text-xs text-subtle">{t(KIND[d.kind] ?? d.kind)}{d.platform ? ` · ${d.platform}` : ''}</p></Td>
                <Td>{branchName.get(d.branch_id)}</Td><Td align="center">{d.device_no ?? '—'}</Td>
                <Td className="text-muted">{d.last_sync_at ? formatDateTimeUK(d.last_sync_at) : t('Never')}</Td>
                <Td><Badge tone={d.is_active ? 'success' : 'neutral'}>{d.is_active ? t('Active') : t('Deactivated')}</Badge></Td>
                <Td align="right"><Button size="sm" variant="ghost" onClick={async () => {
                  await api(`/v1/devices/${d.id}`, { method: 'PATCH', body: { is_active: !d.is_active } }); devices.mutate();
                  toast(d.is_active ? t('{name} deactivated — it can no longer sync', { name: d.name }) : t('{name} reactivated', { name: d.name }));
                }}>{d.is_active ? t('Deactivate') : t('Reactivate')}</Button></Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      {addBranch && <BranchModal onClose={() => setAddBranch(false)} onDone={() => { branches.mutate(); reload(); toast(t('Shop added')); }} />}
      {addDevice && <DeviceModal branches={branches.data ?? []} onClose={() => setAddDevice(false)} onDone={(code, name) => { devices.mutate(); setPairing({ code, name }); }} />}
      {pairing && <PairingModal {...pairing} onClose={() => setPairing(null)} />}
    </>
  );
}

function BranchModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', code: '', address_line1: '', city: '', postcode: '', phone: '' });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={t("Add a shop")} footer={<><Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button><Button onClick={async () => {
      try { await api('/v1/branches', { body: { ...f, code: f.code.toUpperCase(), postcode: f.postcode.toUpperCase() || null } }); onDone(); onClose(); } catch (e) { setErr((e as Error).message); }
    }}>{t("Add shop")}</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <div className="grid grid-cols-[1fr_8rem] gap-3">
        <Field label={t("Shop name")} htmlFor="bn"><Input id="bn" value={f.name} onChange={set('name')} /></Field>
        <Field label={t("Short code")} htmlFor="bc" hint={t("2–8 characters")}><Input id="bc" value={f.code} maxLength={8} onChange={set('code')} /></Field>
      </div>
      <Field label={t("Address line 1")} htmlFor="ba"><Input id="ba" value={f.address_line1} onChange={set('address_line1')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Town or city")} htmlFor="bt"><Input id="bt" value={f.city} onChange={set('city')} /></Field>
        <Field label={t("Postcode")} htmlFor="bp"><Input id="bp" value={f.postcode} onChange={set('postcode')} className="uppercase" /></Field>
      </div>
    </Modal>
  );
}

function DeviceModal({ branches, onClose, onDone }: { branches: any[]; onClose: () => void; onDone: (code: string, name: string) => void }) {
  const { branchId } = useMe();
  const [f, setF] = useState({ branch_id: branchId ?? '', name: 'Front till', kind: 'pos', platform: 'ipad' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={t("Register a till")} footer={<><Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button><Button loading={busy} onClick={async () => {
      setBusy(true);
      try {
        const r = await api('/v1/devices', { body: { ...f, create_till: f.kind === 'pos' || f.kind === 'self_checkout' } });
        const code = btoa(JSON.stringify({ api: API_PUBLIC, device_id: r.device_id, device_secret: r.device_secret })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        onDone(code, f.name); onClose();
      } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
    }}>{t("Register")}</Button></>}>
      {err && <p role="alert" className="text-sm font-medium text-danger">{err}</p>}
      <Field label={t("Name")} htmlFor="dn" hint={t("Something staff will recognise, e.g. Front till.")}><Input id="dn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("Shop")} htmlFor="db"><Select id="db" value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })}>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label={t("Type")} htmlFor="dk"><Select id="dk" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field>
      </div>
    </Modal>
  );
}

function PairingModal({ code, name, onClose }: { code: string; name: string; onClose: () => void }) {
  const toast = useToast();
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => { QRCode.toDataURL(code, { margin: 1, width: 240, color: { dark: '#0F172A', light: '#FFFFFF' } }).then(setQr); }, [code]);
  return (
    <Modal open onClose={onClose} title={t('Pair {name}', { name })} description={t("Open the Counter till app and scan this code, or paste the pairing code. It is shown only once.")}
      footer={<Button onClick={onClose}>{t("Done")}</Button>}>
      <div className="flex flex-col items-center gap-4">
        {qr ? <img src={qr} alt="Pairing QR code for the till app" className="size-60 rounded-lg border border-line" /> : <div className="skeleton size-60" />}
        <div className="w-full">
          <label htmlFor="pc" className="mb-1.5 block text-sm font-medium">{t("Pairing code")}</label>
          <div className="flex gap-2">
            <Input id="pc" readOnly value={code} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" icon={<Copy className="size-4" />} onClick={async () => { await navigator.clipboard.writeText(code); toast(t('Pairing code copied')); }}>{t("Copy")}</Button>
          </div>
          <p className="mt-2 text-xs text-subtle">{t("Treat this like a password: anyone with it can connect a till to your shop. You can deactivate the device at any time.")}</p>
        </div>
      </div>
    </Modal>
  );
}
