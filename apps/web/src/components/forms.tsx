'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toLocalInput } from '@/lib/format';
import { CustomField, Lead, TASK_TYPES, Task, emitChanged, useRefs } from '@/lib/refs';
import { Field, Modal, Spinner, cx, useUi } from './ui';

const fieldErrors = (e: unknown) => {
  const out: Record<string, string> = {};
  if (e instanceof ApiError) for (const x of e.data?.errors ?? []) out[x.path] ??= x.message;
  return out;
};

/** Renders the right control for one admin-defined lead field. */
export function CustomFieldInput({ field, value, onChange, error }: { field: CustomField; value: any; onChange: (v: any) => void; error?: string }) {
  const label = `${field.label}${field.required ? ' *' : ''}`;
  const cls = cx('input', error && 'input-error');
  if (field.type === 'CHECKBOX') {
    return (
      <label className="flex cursor-pointer items-center gap-2.5 self-end pb-2">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span className="font-medium text-ink-soft">{label}</span>
      </label>
    );
  }
  if (field.type === 'MULTI_SELECT') {
    const on: string[] = Array.isArray(value) ? value : [];
    return (
      <div className="sm:col-span-2">
        <span className="label">{label}</span>
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((o) => (
            <button type="button" key={o} aria-pressed={on.includes(o)} onClick={() => onChange(on.includes(o) ? on.filter((x) => x !== o) : [...on, o])} className={cx('pill border py-1', on.includes(o) ? 'border-ink bg-ink text-white' : 'border-ink/15 text-ink-soft hover:border-ink/40')}>
              {o}
            </button>
          ))}
        </div>
        {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
      </div>
    );
  }
  return (
    <Field label={label} error={error} className={field.type === 'LONG_TEXT' ? 'sm:col-span-2' : undefined}>
      {field.type === 'DROPDOWN' ? (
        <select className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not set</option>
          {field.options.map((o) => <option key={o}>{o}</option>)}
        </select>
      ) : field.type === 'LONG_TEXT' ? (
        <textarea className={cx(cls, 'min-h-[72px]')} value={value ?? ''} onChange={(e) => onChange(e.target.value)} maxLength={5000} />
      ) : (
        <input className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value)}
          type={{ NUMBER: 'number', DATE: 'date', URL: 'url', EMAIL: 'email', PHONE: 'tel' }[field.type as string] ?? 'text'} step={field.type === 'NUMBER' ? 'any' : undefined}
          placeholder={field.type === 'URL' ? 'https://' : undefined} />
      )}
    </Field>
  );
}

export function LeadForm({ open, onClose, lead, onSaved }: { open: boolean; onClose: () => void; lead?: Lead | null; onSaved?: (l: Lead) => void }) {
  const { me, can } = useAuth();
  const { pipelines, sources, labels, members, fields } = useRefs();
  const [cf, setCf] = useState<Record<string, any>>({});
  const { toast } = useUi();
  const blank = { name: '', phone: '', email: '', company: '', city: '', sourceId: '', ownerId: me?.user.id ?? '', stageId: '', dealValue: '', expectedCloseAt: '', score: '0', labelIds: [] as string[] };
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [duplicates, setDuplicates] = useState<any[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setDuplicates(null);
    setCf(lead ? { ...lead.customFields } : {});
    setF(
      lead
        ? {
            name: lead.name, phone: lead.phone ?? '', email: lead.email ?? '', company: lead.company ?? '', city: lead.city ?? '',
            sourceId: lead.sourceId ?? '', ownerId: lead.ownerId ?? '', stageId: lead.stageId,
            dealValue: lead.dealValue === null ? '' : String(lead.dealValue), expectedCloseAt: lead.expectedCloseAt?.slice(0, 10) ?? '',
            score: String(lead.score), labelIds: lead.labels.map((l) => l.id),
          }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lead]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const canAssign = can('leads.assign');

  async function save(allowDuplicate = false) {
    setSaving(true);
    setErrors({});
    const body: Record<string, unknown> = {
      name: f.name, phone: f.phone, email: f.email, company: f.company, city: f.city,
      sourceId: f.sourceId || null,
      dealValue: f.dealValue === '' ? null : Number(f.dealValue),
      expectedCloseAt: f.expectedCloseAt || null,
      score: Number(f.score || 0),
      labelIds: f.labelIds,
    };
    if (f.stageId) body.stageId = f.stageId;
    if (fields.length) body.customFields = Object.fromEntries(fields.map((x) => [x.key, cf[x.key] ?? null]));
    if (canAssign) body.ownerId = f.ownerId || null;
    if (allowDuplicate) body.allowDuplicate = true;
    try {
      const saved = lead ? await api<Lead>(`/leads/${lead.id}`, { method: 'PATCH', body }) : await api<Lead>('/leads', { body });
      toast(lead ? 'Lead updated' : 'Lead created');
      onSaved?.(saved);
      emitChanged();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.code === 'DUPLICATE') setDuplicates(e.data.duplicates);
      else {
        const fe = fieldErrors(e);
        setErrors(Object.keys(fe).length ? fe : { _: (e as Error).message });
      }
    } finally {
      setSaving(false);
    }
  }

  const toggleLabel = (id: string) => setF((s) => ({ ...s, labelIds: s.labelIds.includes(id) ? s.labelIds.filter((x) => x !== id) : [...s.labelIds, id] }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={lead ? 'Edit lead' : 'New lead'}
      wide
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          {duplicates ? (
            <button className="btn-ink" disabled={saving} onClick={() => save(true)}>{saving && <Spinner />}Create anyway</button>
          ) : (
            <button className="btn-primary" disabled={saving} onClick={() => save()}>{saving && <Spinner />}{lead ? 'Save changes' : 'Create lead'}</button>
          )}
        </>
      }
    >
      <form className="grid gap-3.5 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save(!!duplicates); }}>
        {errors._ && <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger sm:col-span-2" role="alert">{errors._}</p>}
        {duplicates && (
          <div className="rounded-xl bg-amber-soft px-3 py-2.5 text-amber sm:col-span-2" role="alert">
            <p className="font-semibold">A lead with this phone or email already exists.</p>
            <ul className="mt-1 space-y-0.5">
              {duplicates.map((d) => (
                <li key={d.id}>
                  <Link className="underline" href={`/leads/${d.id}`} onClick={onClose}>{d.name}</Link>
                  {d.phone ? ` · ${d.phone}` : ''}{d.owner ? ` · owned by ${d.owner.name}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label="Name" error={errors.name} className="sm:col-span-2">
          <input className={cx('input', errors.name && 'input-error')} value={f.name} onChange={set('name')} autoFocus required maxLength={160} />
        </Field>
        <Field label="Phone" error={errors.phone}>
          <input className="input" value={f.phone} onChange={set('phone')} inputMode="tel" placeholder="98765 43210" />
        </Field>
        <Field label="Email" error={errors.email}>
          <input className={cx('input', errors.email && 'input-error')} value={f.email} onChange={set('email')} type="email" />
        </Field>
        <Field label="Company"><input className="input" value={f.company} onChange={set('company')} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={set('city')} /></Field>
        <Field label="Source">
          <select className="input" value={f.sourceId} onChange={set('sourceId')}>
            <option value="">No source</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Stage">
          <select className="input" value={f.stageId} onChange={set('stageId')}>
            {!lead && <option value="">First stage</option>}
            {pipelines.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Owner" hint={canAssign ? undefined : 'Your role cannot reassign leads'}>
          <select className="input" value={f.ownerId} onChange={set('ownerId')} disabled={!canAssign}>
            <option value="">Unassigned</option>
            {!lead && <option value="auto">Auto-assign by rule</option>}
            {members.filter((m) => m.status === 'ACTIVE' || m.id === f.ownerId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label={`Deal value (${me?.organisation.currency ?? 'INR'})`} error={errors.dealValue}>
          <input className="input" value={f.dealValue} onChange={set('dealValue')} type="number" min="0" step="1" />
        </Field>
        <Field label="Expected close"><input className="input" value={f.expectedCloseAt} onChange={set('expectedCloseAt')} type="date" /></Field>
        <Field label="Score (0–100)" error={errors.score}>
          <input className="input" value={f.score} onChange={set('score')} type="number" min="0" max="100" />
        </Field>
        {fields.length > 0 && <p className="overline mt-1 border-t border-ink/10 pt-3 sm:col-span-2">Custom fields</p>}
        {fields.map((x) => (
          <CustomFieldInput key={x.id} field={x} value={cf[x.key]} error={errors[`customFields.${x.key}`]} onChange={(v) => setCf((s) => ({ ...s, [x.key]: v }))} />
        ))}
        {labels.length > 0 && (
          <div className="sm:col-span-2">
            <span className="label">Labels</span>
            <div className="flex flex-wrap gap-1.5">
              {labels.map((l) => {
                const on = f.labelIds.includes(l.id);
                return (
                  <button type="button" key={l.id} onClick={() => toggleLabel(l.id)} aria-pressed={on} className="pill border" style={on ? { background: l.color, color: '#fff', borderColor: l.color } : { borderColor: `${l.color}55`, color: l.color }}>
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function TaskForm({ open, onClose, task, leadId, onSaved }: { open: boolean; onClose: () => void; task?: Task | null; leadId?: string | null; onSaved?: () => void }) {
  const { me, can } = useAuth();
  const { members } = useRefs();
  const { toast } = useUi();
  const [f, setF] = useState({ title: '', type: 'FOLLOW_UP', dueAt: '', priority: 'MEDIUM', notes: '', assigneeId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    const tomorrow = new Date(Date.now() + 864e5);
    tomorrow.setHours(10, 0, 0, 0);
    setF(
      task
        ? { title: task.title, type: task.type, dueAt: toLocalInput(task.dueAt), priority: task.priority, notes: task.notes ?? '', assigneeId: task.assigneeId }
        : { title: '', type: 'FOLLOW_UP', dueAt: toLocalInput(tomorrow), priority: 'MEDIUM', notes: '', assigneeId: me?.user.id ?? '' },
    );
  }, [open, task, me]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function save() {
    setSaving(true);
    setErrors({});
    const body: Record<string, unknown> = { title: f.title, type: f.type, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : '', priority: f.priority, notes: f.notes || null, assigneeId: f.assigneeId || undefined };
    if (!task && leadId) body.leadId = leadId;
    try {
      await api(task ? `/tasks/${task.id}` : '/tasks', { method: task ? 'PATCH' : 'POST', body });
      toast(task ? 'Task updated' : 'Follow-up scheduled');
      onSaved?.();
      emitChanged();
      onClose();
    } catch (e) {
      const fe = fieldErrors(e);
      setErrors(Object.keys(fe).length ? fe : { _: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={task ? 'Edit task' : 'Schedule follow-up'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving} onClick={save}>{saving && <Spinner />}{task ? 'Save changes' : 'Schedule'}</button>
        </>
      }
    >
      <form className="grid gap-3.5 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {errors._ && <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger sm:col-span-2" role="alert">{errors._}</p>}
        <Field label="What needs doing?" error={errors.title} className="sm:col-span-2">
          <input className={cx('input', errors.title && 'input-error')} value={f.title} onChange={set('title')} autoFocus placeholder="Call back about pricing" maxLength={200} />
        </Field>
        <Field label="Type">
          <select className="input" value={f.type} onChange={set('type')}>
            {Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className="input" value={f.priority} onChange={set('priority')}>
            <option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option>
          </select>
        </Field>
        <Field label="Due" error={errors.dueAt}>
          <input className={cx('input', errors.dueAt && 'input-error')} type="datetime-local" value={f.dueAt} onChange={set('dueAt')} />
        </Field>
        <Field label="Assigned to">
          <select className="input" value={f.assigneeId} onChange={set('assigneeId')} disabled={!can('tasks.manage')}>
            {members.filter((m) => m.status === 'ACTIVE' || m.id === f.assigneeId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <textarea className="input min-h-[72px]" value={f.notes} onChange={set('notes')} maxLength={2000} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
