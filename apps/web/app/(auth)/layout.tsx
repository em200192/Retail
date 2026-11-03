import { CheckCircle2 } from 'lucide-react';

const POINTS = [
  'Works offline at the till — sales sync the moment you are back online',
  'Challenge 25, price-marked packs and VAT handled for you',
  'Snap a supplier invoice and stock goes in automatically',
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-brand-dark p-12 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(80%_60%_at_10%_0%,#13948C_0%,transparent_60%),radial-gradient(60%_50%_at_100%_100%,#F2A90033_0%,transparent_60%)]" aria-hidden />
        <div className="relative flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-lg bg-accent text-ink font-bold" aria-hidden>C</div>
          <span className="text-xl font-semibold tracking-tight">Counter</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">The till and back office built for UK corner shops.</h1>
          <ul className="mt-8 space-y-4">
            {POINTS.map((p) => (
              <li key={p} className="flex gap-3 text-white/85"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />{p}</li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-white/60">Your data is stored in the UK and handled under UK GDPR.</p>
      </section>
      <main className="flex items-center justify-center p-6 sm:p-12 bg-surface">
        <div className="w-full max-w-md animate-rise">{children}</div>
      </main>
    </div>
  );
}
