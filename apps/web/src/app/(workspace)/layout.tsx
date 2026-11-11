'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Shell } from '@/components/shell';
import { Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { RefsProvider } from '@/lib/refs';

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !me) router.replace('/login');
  }, [me, loading, router]);

  if (loading || !me) return <div className="flex min-h-screen items-center justify-center"><Spinner className="h-6 w-6 text-ink-muted" /></div>;
  return (
    <RefsProvider key={me.organisation.id}>
      <Shell>{children}</Shell>
    </RefsProvider>
  );
}
