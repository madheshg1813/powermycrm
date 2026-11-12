'use client';
import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toLocalInput } from '@/lib/format';
import { Opportunity, PAYMENT_METHODS, Payment, emitChanged, useRefs } from '@/lib/refs';
import { Field, Modal, Spinner, cx } from './ui';

const fieldErrors = (e: unknown) => {
  const out: Record<string, string> = {};
  if (e instanceof ApiError) for (const x of e.data?.errors ?? []) out[x.path] ??= x.message;
  return out;
};
const dateOnly = (d?: string | null) => (d ? toLocalInput(d).slice(0, 10) : '');

/** Create or edit a deal on a lead. */
export function OpportunityForm({ open, onClose, leadId, deal, onSaved }: { open: boolean; onClose: () => void; leadId: string; deal?: Opportunity | null; onSaved?: (o: Opportunity) => void }) {
  const { me } = useAuth();
  const { members } = useRefs();
  const blank = { name: '', value: '', probability: '50', expectedCloseAt: '', ownerId: '', notes: '' };
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setF(deal ? { name: deal.name, value: String(deal.value), probability: String(deal.probability), expectedCloseAt: dateOnly(deal.expectedCloseAt), ownerId: deal.ownerId ?? '', notes: deal.notes ?? '' } : { ...blank, ownerId: me?.user.id ?? '' });
  }, [open, deal]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const body = { leadId, name: f.name, value: f.value === '' ? 0 : Number(f.value), probability: Number(f.probability), expectedCloseAt: f.expectedCloseAt ? new Date(`${f.expectedCloseAt}T12:00:00`).toISOString() : null, ownerId: f.ownerId || null, notes: f.notes || null };
      const saved = await api<Opportunity>(deal ? `/opportunities/${deal.id}` : '/opportunities', { method: deal ? 'PATCH' : 'POST', body });
      emitChanged();
      onSaved?.(saved);
      onClose();
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(Object.keys(fe).length ? fe : { _: (err as Error).message });
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={deal ? 'Edit deal' : 'New deal'}
      footer={<><button className="btn-ghost" onClick={onClose} type="button">Cancel</button><button className="btn-primary" form="deal-form" disabled={busy || !f.name.trim()}>{busy && <Spinner />}{deal ? 'Save deal' : 'Create deal'}</button></>}>
      <form id="deal-form" className="grid gap-3.5 sm:grid-cols-2" onSubmit={save}>
        {errors._ && <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger sm:col-span-2" role="alert">{errors._}</p>}
        <Field label="Deal name" error={errors.name} className="sm:col-span-2"><input className={cx('input', errors.name && 'input-error')} value={f.name} onChange={set('name')} autoFocus maxLength={160} placeholder="Annual subscription" /></Field>
        <Field label={`Value (${me?.organisation.currency ?? 'INR'})`} error={errors.value}><input className="input" type="number" min={0} step="any" value={f.value} onChange={set('value')} /></Field>
        <Field label="Probability" hint="Weights the value in the forecast" error={errors.probability}>
          <select className="input" value={f.probability} onChange={set('probability')}>{[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((p) => <option key={p} value={p}>{p}%</option>)}</select>
        </Field>
        <Field label="Expected close" error={errors.expectedCloseAt}><input className="input" type="date" value={f.expectedCloseAt} onChange={set('expectedCloseAt')} /></Field>
        <Field label="Owner"><select className="input" value={f.ownerId} onChange={set('ownerId')}><option value="">Unassigned</option>{members.filter((m) => m.status === 'ACTIVE' || m.id === f.ownerId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        <Field label="Notes" className="sm:col-span-2"><textarea className="input min-h-[64px]" value={f.notes} onChange={set('notes')} maxLength={2000} /></Field>
      </form>
    </Modal>
  );
}

/** Record a payment against a lead, optionally against one of its deals. */
export function PaymentForm({ open, onClose, leadId, deals, payment, onSaved }: { open: boolean; onClose: () => void; leadId: string; deals: { id: string; name: string }[]; payment?: Payment | null; onSaved?: (p: Payment) => void }) {
  const { me } = useAuth();
  const blank = { amount: '', method: 'UPI', status: 'PAID', reference: '', dueAt: '', paidAt: '', opportunityId: '', notes: '' };
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setF(payment
      ? { amount: String(payment.amount), method: payment.method, status: payment.status === 'PAID' ? 'PAID' : 'PENDING', reference: payment.reference ?? '', dueAt: dateOnly(payment.dueAt), paidAt: dateOnly(payment.paidAt), opportunityId: payment.opportunityId ?? '', notes: payment.notes ?? '' }
      : { ...blank, opportunityId: deals.length === 1 ? deals[0].id : '' });
  }, [open, payment]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const toIso = (d: string) => (d ? new Date(`${d}T12:00:00`).toISOString() : null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const body: Record<string, unknown> = { leadId, amount: Number(f.amount), method: f.method, reference: f.reference || null, notes: f.notes || null, opportunityId: f.opportunityId || null, dueAt: toIso(f.dueAt), paidAt: f.status === 'PAID' ? toIso(f.paidAt) : null };
      // Editing an already-paid or refunded payment keeps its status; the list offers refund separately.
      if (!payment || payment.status === 'PENDING' || payment.status === 'FAILED') body.status = f.status;
      const saved = await api<Payment>(payment ? `/payments/${payment.id}` : '/payments', { method: payment ? 'PATCH' : 'POST', body });
      emitChanged();
      onSaved?.(saved);
      onClose();
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(Object.keys(fe).length ? fe : { _: (err as Error).message });
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={payment ? 'Edit payment' : 'Record payment'}
      footer={<><button className="btn-ghost" onClick={onClose} type="button">Cancel</button><button className="btn-primary" form="payment-form" disabled={busy || !(Number(f.amount) > 0)}>{busy && <Spinner />}{payment ? 'Save payment' : 'Record payment'}</button></>}>
      <form id="payment-form" className="grid gap-3.5 sm:grid-cols-2" onSubmit={save}>
        {errors._ && <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger sm:col-span-2" role="alert">{errors._}</p>}
        <Field label={`Amount (${me?.organisation.currency ?? 'INR'})`} error={errors.amount}><input className={cx('input', errors.amount && 'input-error')} type="number" min={0} step="any" value={f.amount} onChange={set('amount')} autoFocus /></Field>
        <Field label="Method"><select className="input" value={f.method} onChange={set('method')}>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {(!payment || payment.status === 'PENDING' || payment.status === 'FAILED') && (
          <Field label="Status"><select className="input" value={f.status} onChange={set('status')}><option value="PAID">Received</option><option value="PENDING">Expected (not yet received)</option></select></Field>
        )}
        {f.status === 'PAID' ? <Field label="Received on" hint="Leave empty for today"><input className="input" type="date" value={f.paidAt} onChange={set('paidAt')} /></Field>
          : <Field label="Due on"><input className="input" type="date" value={f.dueAt} onChange={set('dueAt')} /></Field>}
        <Field label="Reference" hint="UTR, receipt or cheque number"><input className="input" value={f.reference} onChange={set('reference')} maxLength={120} /></Field>
        {deals.length > 0 && <Field label="Deal"><select className="input" value={f.opportunityId} onChange={set('opportunityId')}><option value="">No specific deal</option>{deals.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
        <Field label="Notes" className="sm:col-span-2"><textarea className="input min-h-[64px]" value={f.notes} onChange={set('notes')} maxLength={2000} /></Field>
      </form>
    </Modal>
  );
}
