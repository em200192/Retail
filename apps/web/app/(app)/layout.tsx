'use client';
import { Shell } from '@/components/shell';
import { ToastProvider } from '@/components/ui';
import { MeProvider } from '@/lib/me';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <MeProvider>
      <ToastProvider>
        <Shell>{children}</Shell>
      </ToastProvider>
    </MeProvider>
  );
}
