'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthHeading, FormError, PasswordInput, SubmitButton, useSubmit } from '@/components/auth-form';
import { Field } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  const { me, loading, signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (!loading && me) router.replace('/dashboard');
  }, [me, loading, router]);

  const { busy, error, fields, submit } = useSubmit(async () => {
    const r = await api<{ accessToken: string }>('/auth/login', { body: { email, password } });
    await signIn(r.accessToken);
    router.replace('/dashboard');
  });

  return (
    <>
      <AuthHeading lead="Welcome" accent="back" sub="Log in to your workspace." />
      <form className="card mt-7 space-y-4 p-5 shadow-soft sm:p-7" onSubmit={submit}>
        <FormError message={error} />
        <Field label="Email" error={fields.email}>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
        </Field>
        <Field label="Password" error={fields.password}>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        <Link href="/forgot-password" className="-mt-2 inline-block text-xs font-medium text-ink-muted underline hover:text-ink">Forgot password?</Link>
        <SubmitButton busy={busy}>Log in</SubmitButton>
      </form>
      <p className="mt-5 text-center text-ink-muted">New to Power My CRM? <Link href="/register" className="font-semibold text-ink underline">Create an account</Link></p>
    </>
  );
}
