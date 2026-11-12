import { Logo } from '@/components/ui';

export const metadata = { title: 'Offline' };

/** Shown by the service worker when a page cannot be fetched. The CRM needs a connection to read or change data. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <Logo />
      <h1 className="text-2xl font-extrabold">You are offline</h1>
      <p className="max-w-sm text-ink-muted">PowerMyCRM needs a connection to show your leads and follow-ups. Your work is saved on the server, so nothing is lost. Reconnect and try again.</p>
      <a href="/dashboard" className="btn-ink">Try again</a>
    </main>
  );
}
