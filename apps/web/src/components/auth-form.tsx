'use client';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { Spinner, cx } from './ui';

export function AuthHeading({ lead, accent, sub }: { lead: string; accent: string; sub: string }) {
  return (
    <div className="text-center">
      <h1 className="text-[1.9rem] font-extrabold leading-tight sm:text-[2.3rem]">{lead} <span className="text-green">{accent}</span></h1>
      <p className="mx-auto mt-2 max-w-md text-[15px] text-ink-muted">{sub}</p>
    </div>
  );
}

export function PasswordInput({ value, onChange, error, autoComplete }: { value: string; onChange: (v: string) => void; error?: boolean; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative block">
      <input className={cx('input pr-11', error && 'input-error')} type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} required />
      <button type="button" className="btn-icon absolute right-1.5 top-1/2 -translate-y-1/2" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </span>
  );
}

/** Wraps an auth form: handles submit state, a form-level error and per-field errors from the API. */
export function useSubmit(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFields({});
    try {
      await run();
    } catch (err) {
      const fe: Record<string, string> = {};
      if (err instanceof ApiError) for (const x of err.data?.errors ?? []) fe[x.path] ??= x.message;
      setFields(fe);
      if (!Object.keys(fe).length) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, fields, submit };
}

export function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return <button className="btn-primary w-full py-2.5" disabled={busy}>{busy && <Spinner />}{children}</button>;
}

export function FormError({ message }: { message: string }) {
  return message ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger" role="alert">{message}</p> : null;
}
