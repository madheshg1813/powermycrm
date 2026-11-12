'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthHeading } from '@/components/auth-form';
import { Spinner } from '@/components/ui';
import { api } from '@/lib/api';

export default function VerifyEmailPage() {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    api('/auth/verify-email', { body: { token } })
      .then(() => setState('done'))
      .catch((e) => { setMessage((e as Error).message); setState('failed'); });
  }, []);
  return (
    <>
      <AuthHeading lead="Verifying your" accent="email" sub="One moment." />
      <div className="card mt-7 p-5 shadow-soft sm:p-7">
        {state === 'working' && <p className="flex items-center gap-2 text-ink-soft"><Spinner />Checking the link…</p>}
        {state === 'done' && <p className="text-ink-soft">Your email address is verified. <Link href="/dashboard" className="font-semibold text-ink underline">Go to your dashboard</Link></p>}
        {state === 'failed' && <p className="text-ink-soft">{message || 'This link is invalid or has expired.'} Sign in and use &ldquo;Resend verification email&rdquo; from the banner to get a new one. <Link href="/login" className="font-semibold text-ink underline">Log in</Link></p>}
      </div>
    </>
  );
}
