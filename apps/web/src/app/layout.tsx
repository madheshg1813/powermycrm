import type { Metadata, Viewport } from 'next';
import { Inter, Sora } from 'next/font/google';
import { PwaRegister } from '@/components/pwa';
import { UiProvider } from '@/components/ui';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const sora = Sora({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-sora', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Power My CRM', template: '%s · Power My CRM' },
  description: 'Sales CRM for lead management, follow-ups and pipelines.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Power My CRM',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'PowerMyCRM' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#F5F1EA' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable}`}>
      <body>
        <AuthProvider>
          <UiProvider>{children}</UiProvider>
          <PwaRegister />
        </AuthProvider>
      </body>
    </html>
  );
}
