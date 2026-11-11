'use client';
import Link from 'next/link';
import { useState } from 'react';
import { AuthHeading, FormError, SubmitButton, useSubmit } from '@/components/auth-form';
import { Field } from '@/components/ui';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, fields, submit } = useSubmit(async () => {
    await api('/auth/forgot-password', { body: { email } });
    setSent(true);
  });

  return (
    <>
      <AuthHeading lead="Reset your" accent="password" sub="Enter the email you use to log in." />
      <div className="card mt-7 p-5 shadow-soft sm:p-7">
        {sent ? (
          <p className="text-ink-soft">If an account exists for <strong>{email}</strong>, a reset link has been created. It expires in one hour. Email delivery is not connected on this server yet, so ask your administrator to send you the link.</p>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <FormError message={error} />
            <Field label="Email" error={fields.email}>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
            </Field>
            <SubmitButton busy={busy}>Send reset link</SubmitButton>
          </form>
        )}
      </div>
      <p className="mt-5 text-center"><Link href="/login" className="font-semibold underline">Back to log in</Link></p>
    </>
  );
}
