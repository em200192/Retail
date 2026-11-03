'use client';
import Link from 'next/link';
import { t } from '@/lib/i18n';

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center p-6 text-center">
      <div>
        <p className="text-sm font-semibold text-brand">404</p>
        <h1 className="mt-1 text-2xl font-semibold">{t("Page not found")}</h1>
        <p className="mt-2 text-muted">{t("If you typed the web address, check it is correct.")}</p>
        <Link href="/" className="mt-6 inline-block rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white">{t("Go to the overview")}</Link>
      </div>
    </main>
  );
}
