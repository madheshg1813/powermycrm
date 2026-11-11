'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function Home() {
  const { me, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading) router.replace(me ? '/dashboard' : '/login');
  }, [me, loading, router]);
  return <div className="flex min-h-screen items-center justify-center"><Spinner className="h-6 w-6 text-ink-muted" /></div>;
}
