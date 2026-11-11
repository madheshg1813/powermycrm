'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthHeading, FormError, PasswordInput, SubmitButton, useSubmit } from '@/components/auth-form';
import { ErrorState, Field, Skeleton } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { signIn } = useAuth();
  const router = useRouter();
  const info = useApi<{ email: string; organisation: string; role: string; existingUser: boolean }>(`/auth/invitations/${token}`);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  const { busy, error, fields, submit } = useSubmit(async () => {
    const r = await api<{ accessToken: string }>(`/auth/invitations/${token}/accept`, { body: info.data?.existingUser ? { password } : { name, password } });
    await signIn(r.accessToken);
    router.replace('/dashboard');
  });

  if (info.loading) return <div className="card"><Skeleton rows={4} /></div>;
  if (info.error || !info.data) {
    return (
      <div className="card">
        <ErrorState message={info.error?.message ?? 'This invitation could not be loaded.'} />
        <p className="pb-6 text-center"><Link href="/login" className="font-semibold underline">Go to log in</Link></p>
      </div>
    );
  }
  const d = info.data;
  return (
    <>
      <AuthHeading lead="Join" accent={d.organisation} sub={`You have been invited as ${d.role}.`} />
      <form className="card mt-7 space-y-4 p-5 shadow-soft sm:p-7" onSubmit={submit}>
        <FormError message={error} />
        <Field label="Email"><input className="input" value={d.email} disabled /></Field>
        {!d.existingUser && (
          <Field label="Your name" error={fields.name}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus required />
          </Field>
        )}
        <Field label={d.existingUser ? 'Your existing password' : 'Choose a password'} error={fields.password} hint={d.existingUser ? 'You already have a Power My CRM account with this email.' : 'At least 10 characters, with a letter and a number.'}>
          <PasswordInput value={password} onChange={setPassword} autoComplete={d.existingUser ? 'current-password' : 'new-password'} error={!!fields.password} />
        </Field>
        <SubmitButton busy={busy}>Join workspace</SubmitButton>
      </form>
    </>
  );
}
