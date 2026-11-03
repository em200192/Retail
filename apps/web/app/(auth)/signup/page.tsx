'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Field, Input, Toggle } from '@/components/ui';

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i;
const UK_VAT = /^(GB)?\s?\d{3}\s?\d{4}\s?\d{2}(\s?\d{3})?$/i;

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [f, setF] = useState({ full_name: '', email: '', password: '', legal_name: '', trading_name: '', vat_registered: true,
    vat_number: '', branch_name: '', branch_code: '', address_line1: '', city: '', postcode: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const validate1 = () => {
    const e: Record<string, string> = {};
    if (!f.full_name.trim()) e.full_name = 'Enter your full name';
    if (!/^\S+@\S+\.\S+$/.test(f.email)) e.email = 'Enter an email address in the correct format, like name@example.com';
    if (f.password.length < 10) e.password = 'Password must be 10 characters or more';
    setErrors(e); return Object.keys(e).length === 0;
  };
  const validate2 = () => {
    const e: Record<string, string> = {};
    if (!f.legal_name.trim()) e.legal_name = 'Enter your business name as registered';
    if (f.vat_registered && f.vat_number && !UK_VAT.test(f.vat_number)) e.vat_number = 'Enter a UK VAT number in the correct format, like GB123456789';
    if (!f.branch_name.trim()) e.branch_name = 'Enter a name for your shop';
    if (!/^[A-Za-z0-9]{2,8}$/.test(f.branch_code)) e.branch_code = 'Use 2 to 8 letters or numbers, like MAN1';
    if (f.postcode && !UK_POSTCODE.test(f.postcode.trim())) e.postcode = 'Enter a real UK postcode, like M14 6LE';
    setErrors(e); return Object.keys(e).length === 0;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 1) { if (validate1()) setStep(2); return; }
    if (!validate2()) return;
    setBusy(true); setError(null);
    const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      action: 'signup', email: f.email, password: f.password, full_name: f.full_name,
      business: { legal_name: f.legal_name, trading_name: f.trading_name || undefined, vat_registered: f.vat_registered,
        vat_number: f.vat_registered && f.vat_number ? f.vat_number.replace(/\s/g, '').toUpperCase() : undefined },
      branch: { name: f.branch_name, code: f.branch_code.toUpperCase(), address_line1: f.address_line1 || undefined, city: f.city || undefined,
        postcode: f.postcode ? f.postcode.toUpperCase() : undefined },
    }) });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(data.message ?? 'Could not create your account');
    router.replace('/?welcome=1');
  };

  return (
    <>
      <p className="text-sm font-semibold text-brand">Step {step} of 2</p>
      <h1 className="text-2xl font-semibold tracking-tight mt-1">{step === 1 ? 'Create your account' : 'About your business'}</h1>
      <p className="text-muted mt-1">{step === 1 ? 'Free for 30 days. No card needed.' : 'You can add more shops later.'}</p>
      <Card className="mt-6 p-6">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error && <div role="alert" className="rounded-lg border border-danger/30 bg-danger-tint px-3 py-2.5 text-sm text-danger">{error}</div>}
          {step === 1 ? (
            <>
              <Field label="Full name" htmlFor="full_name" error={errors.full_name}><Input id="full_name" autoComplete="name" value={f.full_name} onChange={set('full_name')} /></Field>
              <Field label="Email address" htmlFor="email" error={errors.email}><Input id="email" type="email" autoComplete="email" value={f.email} onChange={set('email')} /></Field>
              <Field label="Create a password" htmlFor="password" hint="At least 10 characters." error={errors.password}>
                <Input id="password" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Registered business name" htmlFor="legal_name" hint="As shown on Companies House or your sole-trader records." error={errors.legal_name}>
                <Input id="legal_name" value={f.legal_name} onChange={set('legal_name')} />
              </Field>
              <Field label="Trading name (optional)" htmlFor="trading_name"><Input id="trading_name" value={f.trading_name} onChange={set('trading_name')} /></Field>
              <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5">
                <span className="text-sm font-medium">VAT registered</span>
                <Toggle label="VAT registered" checked={f.vat_registered} onChange={(v) => setF({ ...f, vat_registered: v })} />
              </div>
              {f.vat_registered && (
                <Field label="VAT registration number (optional)" htmlFor="vat_number" hint="Printed on your receipts." error={errors.vat_number}>
                  <Input id="vat_number" value={f.vat_number} onChange={set('vat_number')} placeholder="GB123456789" />
                </Field>
              )}
              <div className="grid grid-cols-[1fr_8rem] gap-3">
                <Field label="Shop name" htmlFor="branch_name" error={errors.branch_name}><Input id="branch_name" value={f.branch_name} onChange={set('branch_name')} placeholder="High Street" /></Field>
                <Field label="Short code" htmlFor="branch_code" error={errors.branch_code}><Input id="branch_code" value={f.branch_code} onChange={set('branch_code')} placeholder="MAN1" maxLength={8} /></Field>
              </div>
              <Field label="Address line 1" htmlFor="address_line1"><Input id="address_line1" autoComplete="address-line1" value={f.address_line1} onChange={set('address_line1')} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Town or city" htmlFor="city"><Input id="city" autoComplete="address-level2" value={f.city} onChange={set('city')} /></Field>
                <Field label="Postcode" htmlFor="postcode" error={errors.postcode}><Input id="postcode" autoComplete="postal-code" value={f.postcode} onChange={set('postcode')} className="uppercase" /></Field>
              </div>
            </>
          )}
          <div className="flex gap-2 pt-1">
            {step === 2 && <Button type="button" variant="secondary" size="lg" onClick={() => setStep(1)}>Back</Button>}
            <Button type="submit" size="lg" className="flex-1" loading={busy}>{step === 1 ? 'Continue' : 'Create my shop'}</Button>
          </div>
        </form>
      </Card>
      <p className="mt-6 text-center text-sm text-muted">Already using Counter? <Link href="/login" className="font-semibold text-brand underline-offset-4 hover:underline">Sign in</Link></p>
    </>
  );
}
