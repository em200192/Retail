'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { t } from '@/lib/i18n';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next') ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenants, setTenants] = useState<{ tenant_id: string; name: string }[] | null>(null);
  const [tenantId, setTenantId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'login', email, password, tenant_id: tenantId || undefined }) });
    const data = await res.json().catch(() => ({ message: t('Counter cannot reach the server right now. Try again in a minute.') }));
    setBusy(false);
    if (!res.ok) return setError(data.message ?? t('Could not sign you in'));
    if (data.requires_tenant_selection) { setTenants(data.tenants); setTenantId(data.tenants[0].tenant_id); return; }
    router.replace(next.startsWith('/') ? next : '/');
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{t("Sign in")}</h1>
      <p className="text-muted mt-1">{t("Welcome back. Staff on the till sign in with their PIN instead.")}</p>
      <Card className="mt-6 p-6">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error && <div role="alert" className="rounded-lg border border-danger/30 bg-danger-tint px-3 py-2.5 text-sm text-danger">{error}</div>}
          <Field label={t("Email address")} htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t("Password")} htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {tenants && (
            <Field label={t("Which business?")} htmlFor="tenant" hint={t("You work for more than one shop.")}>
              <Select id="tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                {tenants.map((it) => <option key={it.tenant_id} value={it.tenant_id}>{it.name}</option>)}
              </Select>
            </Field>
          )}
          <Button type="submit" size="lg" className="w-full" loading={busy}>{tenants ? t('Continue') : t('Sign in')}</Button>
        </form>
      </Card>
      <p className="mt-6 text-center text-sm text-muted">{t("New to Counter?")}{" "}<Link href="/signup" className="font-semibold text-brand underline-offset-4 hover:underline">{t("Set up your shop")}</Link></p>
    </>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
