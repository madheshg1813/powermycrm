'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthHeading, FormError, PasswordInput, SubmitButton, useSubmit } from '@/components/auth-form';
import { Field } from '@/components/ui';
import { api } from '@/lib/api';

export default function ResetPasswordPage() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('token') ?? '');
  }, []);
  const { busy, error, fields, submit } = useSubmit(async () => {
    await api('/auth/reset-password', { body: { token, password } });
    setDone(true);
  });

  return (
    <>
      <AuthHeading lead="Choose a new" accent="password" sub="You will be signed out everywhere else." />
      <div className="card mt-7 p-5 shadow-soft sm:p-7">
        {done ? (
          <p className="text-ink-soft">Your password has been changed. <Link href="/login" className="font-semibold text-ink underline">Log in</Link></p>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <FormError message={error || fields.token} />
            <Field label="New password" error={fields.password} hint="At least 10 characters, with a letter and a number.">
              <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" error={!!fields.password} />
            </Field>
            <SubmitButton busy={busy}>Change password</SubmitButton>
          </form>
        )}
      </div>
    </>
  );
}
