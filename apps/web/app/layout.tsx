import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
import { I18nProvider } from '@/lib/i18n';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const arabic = IBM_Plex_Sans_Arabic({ subsets: ['arabic'], weight: ['400', '500', '600', '700'], variable: '--font-arabic', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Counter', template: '%s · Counter' },
  description: 'Back office for independent UK convenience stores',
};
export const viewport: Viewport = { themeColor: '#0B6E69', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${inter.variable} ${arabic.variable}`} suppressHydrationWarning>
      <body><I18nProvider>{children}</I18nProvider></body>
    </html>
  );
}
