'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { toLocalInput } from '@/lib/format';
import { Call, emitChanged, useRefs } from '@/lib/refs';
import { Field, Modal, Spinner } from './ui';

export const CALL_STATUS: Record<Call['status'], string> = { COMPLETED: 'Spoke to them', NO_ANSWER: 'No answer', BUSY: 'Busy', FAILED: 'Could not connect', CANCELLED: 'Cancelled', MISSED: 'Missed (inbound)' };

/** Log a call on a lead, with outcome, duration, notes and an optional follow-up in one go. */
export function LogCallForm({ open, onClose, leadId, phone, call, onSaved }: { open: boolean; onClose: () => void; leadId: string; phone: string | null; call?: Call | null; onSaved?: () => void }) {
  const { dispositions } = useRefs();
  const blank = { direction: 'OUTBOUND', status: 'COMPLETED', minutes: '', seconds: '', dispositionId: '', notes: '', followUp: false, followUpTitle: 'Call back', followUpAt: '' };
  const [f, setF] = useState(blank);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError('');
    const tomorrow = new Date(Date.now() + 864e5); tomorrow.setHours(10, 0, 0, 0);
    setF(call
      ? { ...blank, direction: call.direction, status: call.status, minutes: String(Math.floor((call.durationSec ?? 0) / 60)), seconds: String((call.durationSec ?? 0) % 60), dispositionId: call.dispositionId ?? '', notes: call.notes ?? '' }
      : { ...blank, followUpAt: toLocalInput(tomorrow) });
  }, [open, call]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const durationSec = f.status === 'COMPLETED' ? Number(f.minutes || 0) * 60 + Number(f.seconds || 0) : null;
      const body: Record<string, unknown> = { direction: f.direction, status: f.status, durationSec, dispositionId: f.dispositionId || null, notes: f.notes || null };
      if (call) await api(`/calls/${call.id}`, { method: 'PATCH', body });
      else await api('/calls', { body: { ...body, leadId, phone, followUp: f.followUp && f.followUpAt ? { title: f.followUpTitle || 'Call back', dueAt: new Date(f.followUpAt).toISOString(), type: 'CALLBACK' } : undefined } });
      emitChanged();
      onSaved?.();
      onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={call ? 'Edit call' : 'Log a call'}
      footer={<><button className="btn-ghost" onClick={onClose} type="button">Cancel</button><button className="btn-primary" form="call-form" disabled={busy}>{busy && <Spinner />}{call ? 'Save' : 'Log call'}</button></>}>
      <form id="call-form" className="grid gap-3.5 sm:grid-cols-2" onSubmit={save}>
        {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger sm:col-span-2" role="alert">{error}</p>}
        <Field label="Direction"><select className="input" value={f.direction} onChange={set('direction')}><option value="OUTBOUND">I called them</option><option value="INBOUND">They called me</option></select></Field>
        <Field label="What happened"><select className="input" value={f.status} onChange={set('status')}>{Object.entries(CALL_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {f.status === 'COMPLETED' && (
          <Field label="Duration"><div className="flex items-center gap-2"><input className="input" type="number" min={0} value={f.minutes} onChange={set('minutes')} placeholder="min" aria-label="Minutes" /><span className="text-ink-muted">:</span><input className="input" type="number" min={0} max={59} value={f.seconds} onChange={set('seconds')} placeholder="sec" aria-label="Seconds" /></div></Field>
        )}
        <Field label="Outcome"><select className="input" value={f.dispositionId} onChange={set('dispositionId')}><option value="">Not set</option>{dispositions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="Notes" className="sm:col-span-2"><textarea className="input min-h-[72px]" value={f.notes} onChange={set('notes')} maxLength={2000} placeholder="What was discussed, next step…" /></Field>
        {!call && (
          <>
            <label className="flex cursor-pointer items-center gap-2.5 sm:col-span-2"><input type="checkbox" checked={f.followUp} onChange={(e) => setF({ ...f, followUp: e.target.checked })} /><span>Schedule a callback</span></label>
            {f.followUp && <><Field label="Callback title"><input className="input" value={f.followUpTitle} onChange={set('followUpTitle')} maxLength={200} /></Field><Field label="When"><input className="input" type="datetime-local" value={f.followUpAt} onChange={set('followUpAt')} required /></Field></>}
          </>
        )}
      </form>
    </Modal>
  );
}
