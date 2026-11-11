'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthHeading, FormError, PasswordInput, SubmitButton, useSubmit } from '@/components/auth-form';
import { Field } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function RegisterPage() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [f, setF] = useState({ name: '', organisationName: '', email: '', password: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const { busy, error, fields, submit } = useSubmit(async () => {
    const r = await api<{ accessToken: string }>('/auth/register', { body: f });
    await signIn(r.accessToken);
    router.replace('/dashboard');
  });

  return (
    <>
      <AuthHeading lead="Create your" accent="workspace" sub="Set up your sales team in a couple of minutes." />
      <form className="card mt-7 space-y-4 p-5 shadow-soft sm:p-7" onSubmit={submit}>
        <FormError message={error} />
        <Field label="Your name" error={fields.name}>
          <input className="input" value={f.name} onChange={set('name')} autoComplete="name" autoFocus required />
        </Field>
        <Field label="Organisation name" error={fields.organisationName}>
          <input className="input" value={f.organisationName} onChange={set('organisationName')} autoComplete="organization" required />
        </Field>
        <Field label="Work email" error={fields.email}>
          <input className="input" type="email" value={f.email} onChange={set('email')} autoComplete="email" required />
        </Field>
        <Field label="Password" error={fields.password} hint="At least 10 characters, with a letter and a number.">
          <PasswordInput value={f.password} onChange={(v) => setF((s) => ({ ...s, password: v }))} autoComplete="new-password" error={!!fields.password} />
        </Field>
        <SubmitButton busy={busy}>Create workspace</SubmitButton>
      </form>
      <p className="mt-5 text-center text-ink-muted">Already have an account? <Link href="/login" className="font-semibold text-ink underline">Log in</Link></p>
    </>
  );
}
