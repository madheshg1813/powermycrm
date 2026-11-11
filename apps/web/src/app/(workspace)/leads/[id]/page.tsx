'use client';
import {
  Archive, ArchiveRestore, ArrowLeft, ArrowRightLeft, CalendarCheck, CalendarPlus, Check, GitMerge, Mail, MessageSquareText, Pencil, Phone, Plus, Trash2, UserRound, Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { LeadForm, TaskForm } from '@/components/forms';
import { Avatar, ColorDot, EmptyState, ErrorState, LabelChip, Skeleton, Spinner, Tabs, cx, useUi } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, money, relTime } from '@/lib/format';
import { Lead, TASK_TYPES, Task, useChanged, useRefs } from '@/lib/refs';

type Detail = Lead & { duplicates: { id: string; name: string; phone: string | null; email: string | null; createdAt: string; owner: { name: string } | null }[]; tasks: Task[] };
type Activity = { id: string; type: string; data: any; createdAt: string; actor: { id: string; name: string } | null };

const FIELD_LABELS: Record<string, string> = { name: 'Name', phone: 'Phone', email: 'Email', company: 'Company', city: 'City', score: 'Score', dealValue: 'Deal value', expectedCloseAt: 'Expected close', source: 'Source', lostReason: 'Lost reason' };

function describe(a: Activity): { icon: React.ComponentType<{ className?: string }>; text: React.ReactNode; body?: string } {
  const d = a.data ?? {};
  switch (a.type) {
    case 'created': return { icon: Plus, text: d.via === 'import' ? 'Lead imported' : 'Lead created' };
    case 'note': return { icon: MessageSquareText, text: 'Added a note', body: d.body };
    case 'stage_changed': return { icon: ArrowRightLeft, text: <>Moved {d.from ? <>from <strong>{d.from}</strong> </> : ''}to <strong>{d.to}</strong></> };
    case 'assigned': return { icon: UserRound, text: d.to ? <>Assigned to <strong>{d.to}</strong></> : 'Unassigned' };
    case 'updated': {
      const keys = Object.keys(d.changes ?? {});
      return { icon: Pencil, text: d.via === 'import' ? 'Updated by import' : `Updated ${keys.map((k) => FIELD_LABELS[k] ?? k).join(', ').toLowerCase() || 'details'}` };
    }
    case 'task_created': return { icon: CalendarPlus, text: <>Scheduled {TASK_TYPES[d.type]?.toLowerCase() ?? 'task'} <strong>{d.title}</strong>{d.dueAt ? ` for ${fmtDateTime(d.dueAt)}` : ''}</> };
    case 'task_completed': return { icon: Check, text: <>Completed <strong>{d.title}</strong></> };
    case 'task_cancelled': return { icon: CalendarCheck, text: <>Cancelled <strong>{d.title}</strong></> };
    case 'task_reopened': return { icon: CalendarCheck, text: <>Reopened <strong>{d.title}</strong></> };
    case 'merged': return { icon: GitMerge, text: <>Merged duplicate <strong>{d.name}</strong></> };
    case 'archived': return { icon: Archive, text: 'Archived' };
    case 'restored': return { icon: ArchiveRestore, text: 'Restored' };
    default: return { icon: Sparkles, text: a.type.replace(/_/g, ' ') };
  }
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, can } = useAuth();
  const { pipelines, members, fields, reload: reloadRefs } = useRefs();
  const { toast, confirm } = useUi();
  const lead = useApi<Detail>(`/leads/${id}`);
  const acts = useApi<Activity[]>(`/leads/${id}/activities`);
  const [tab, setTab] = useState<'timeline' | 'tasks'>('timeline');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const reload = () => { lead.reload(); acts.reload(); };
  useChanged(reload);

  if (lead.error) {
    return (
      <div className="card mx-auto max-w-xl">
        <ErrorState message={lead.error.status === 404 ? 'This lead does not exist or you do not have access to it.' : lead.error.message} onRetry={lead.error.status === 404 ? undefined : lead.reload} />
        <p className="pb-6 text-center"><Link href="/leads" className="font-semibold underline">Back to leads</Link></p>
      </div>
    );
  }
  if (!lead.data) return <div className="card"><Skeleton rows={8} /></div>;
  const l = lead.data;
  const canEdit = can('leads.edit') && !l.archivedAt;
  const stages = pipelines.find((p) => p.id === l.pipelineId)?.stages ?? [];
  const openTasks = l.tasks.filter((t) => t.status === 'OPEN');

  async function patch(body: Record<string, unknown>, message: string) {
    try {
      await api(`/leads/${id}`, { method: 'PATCH', body });
      toast(message);
      reload();
      reloadRefs();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    try {
      await api(`/leads/${id}/notes`, { body: { body: note } });
      setNote('');
      acts.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function archive(restore: boolean) {
    if (!restore && !(await confirm({ title: 'Archive this lead?', text: 'It will be hidden from lists and reports. You can restore it from the Archived tab.', confirmLabel: 'Archive' }))) return;
    try {
      await api('/leads/bulk', { body: { ids: [id], action: restore ? 'restore' : 'archive' } });
      toast(restore ? 'Lead restored' : 'Lead archived');
      reload();
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  async function remove() {
    if (!(await confirm({ title: 'Delete this lead permanently?', text: `${l.name} and its notes, history and follow-ups will be deleted. This cannot be undone.`, confirmLabel: 'Delete permanently', danger: true }))) return;
    try {
      await api(`/leads/${id}`, { method: 'DELETE' });
      toast('Lead deleted');
      router.replace('/leads');
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  async function merge(dup: Detail['duplicates'][number]) {
    if (!(await confirm({ title: `Merge ${dup.name} into this lead?`, text: 'Its notes, history, follow-ups and labels move here, empty fields are filled in, and the duplicate is removed. This cannot be undone.', confirmLabel: 'Merge', danger: true }))) return;
    try {
      await api(`/leads/${id}/merge`, { body: { duplicateId: dup.id } });
      toast('Leads merged');
      reload();
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  async function setTaskStatus(t: Task, status: string) {
    try {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status } });
      reload();
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  const info: [string, React.ReactNode][] = [
    ['Phone', l.phone ? <a className="font-medium hover:underline" href={`tel:${l.phone.replace(/[^\d+]/g, '')}`}>{l.phone}</a> : null],
    ['Email', l.email ? <a className="font-medium hover:underline" href={`mailto:${l.email}`}>{l.email}</a> : null],
    ['Company', l.company], ['City', l.city], ['Source', l.source?.name],
    ['Deal value', l.dealValue === null ? null : money(l.dealValue, me?.organisation.currency)],
    ['Expected close', l.expectedCloseAt ? fmtDate(l.expectedCloseAt) : null],
    ['Score', `${l.score} / 100`],
    ['In this stage', relTime(l.stageEnteredAt).replace(' ago', '')],
    ['Created', fmtDate(l.createdAt)],
    ...fields.map((f): [string, React.ReactNode] => {
      const v = l.customFields?.[f.key];
      if (v === undefined || v === null) return [f.label, null];
      if (f.type === 'CHECKBOX') return [f.label, v ? 'Yes' : 'No'];
      if (f.type === 'DATE') return [f.label, fmtDate(v)];
      if (f.type === 'URL') return [f.label, <a key={f.key} className="font-medium underline" href={v} target="_blank" rel="noopener noreferrer">{String(v).replace(/^https?:\/\//, '')}</a>];
      return [f.label, Array.isArray(v) ? v.join(', ') : String(v)];
    }),
  ];

  return (
    <div className="mx-auto max-w-[1240px]">
      <Link href="/leads" className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-muted hover:text-ink"><ArrowLeft className="h-4 w-4" />Leads</Link>

      <div className="card card-pad mb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <Avatar name={l.name} size={48} />
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-extrabold">{l.name}</h1>
              <p className="truncate text-ink-muted">{[l.company, l.city].filter(Boolean).join(' · ') || 'No company details'}</p>
            </div>
            {l.archivedAt && <span className="pill-amber">Archived</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {l.phone && <a className="btn-ghost" href={`tel:${l.phone.replace(/[^\d+]/g, '')}`} title="Opens your device's phone app"><Phone className="h-4 w-4" />Call</a>}
            {l.email && <a className="btn-ghost" href={`mailto:${l.email}`} title="Opens your email app"><Mail className="h-4 w-4" />Email</a>}
            {canEdit && <button className="btn-ghost" onClick={() => setEditOpen(true)}><Pencil className="h-4 w-4" />Edit</button>}
            {!l.archivedAt && <button className="btn-primary" onClick={() => { setEditTask(null); setTaskOpen(true); }}><CalendarPlus className="h-4 w-4" />Follow-up</button>}
          </div>
        </div>

        <div className="mt-5 grid gap-3 border-t border-ink/10 pt-4 sm:grid-cols-[1fr_260px]">
          <div>
            <span className="label">Stage</span>
            <div className="flex flex-wrap gap-1.5">
              {stages.map((s) => {
                const on = s.id === l.stageId;
                return (
                  <button key={s.id} disabled={!canEdit || on} onClick={() => patch({ stageId: s.id }, `Moved to ${s.name}`)} aria-pressed={on}
                    className={cx('pill border py-1 transition', on ? 'text-white' : 'border-ink/15 text-ink-soft hover:border-ink/40', !canEdit && !on && 'opacity-60')}
                    style={on ? { background: s.color, borderColor: s.color } : undefined}>
                    {!on && <ColorDot color={s.color} />}{s.name}
                  </button>
                );
              })}
            </div>
          </div>
          <label>
            <span className="label">Owner</span>
            <select className="input" value={l.ownerId ?? ''} disabled={!can('leads.assign') || !!l.archivedAt} onChange={(e) => patch({ ownerId: e.target.value || null }, 'Owner updated')}>
              <option value="">Unassigned</option>
              {members.filter((m) => m.status === 'ACTIVE' || m.id === l.ownerId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        </div>
      </div>

      {l.duplicates.length > 0 && (
        <div className="mb-5 rounded-2xl bg-amber-soft px-5 py-4 text-amber">
          <p className="font-semibold">Possible duplicate{l.duplicates.length > 1 ? 's' : ''} with the same phone or email</p>
          <ul className="mt-2 space-y-1.5">
            {l.duplicates.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link href={`/leads/${d.id}`} className="font-medium underline">{d.name}</Link>
                <span>{[d.phone, d.email, d.owner?.name && `owned by ${d.owner.name}`, `added ${fmtDate(d.createdAt)}`].filter(Boolean).join(' · ')}</span>
                {can('leads.edit') && can('leads.delete') && <button className="btn-ghost btn-sm text-ink" onClick={() => merge(d)}><GitMerge className="h-3.5 w-3.5" />Merge into this lead</button>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <aside className="space-y-5">
          <section className="card card-pad">
            <h2 className="card-title mb-3">Details</h2>
            <dl className="space-y-2.5">
              {info.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="shrink-0 text-ink-muted">{k}</dt>
                  <dd className="min-w-0 truncate text-right">{v || <span className="text-ink-faint">&mdash;</span>}</dd>
                </div>
              ))}
            </dl>
            {l.labels.length > 0 && <div className="mt-4 flex flex-wrap gap-1.5 border-t border-ink/10 pt-4">{l.labels.map((x) => <LabelChip key={x.id} {...x} />)}</div>}
          </section>
          {can('leads.delete') && (
            <section className="card card-pad">
              <h2 className="card-title mb-1">Archive</h2>
              <p className="mb-3 text-ink-muted">{l.archivedAt ? 'This lead is archived and hidden from lists and reports.' : 'Hide this lead from lists and reports without deleting its history.'}</p>
              <div className="flex flex-wrap gap-2">
                <button className="btn-ghost btn-sm" onClick={() => archive(!!l.archivedAt)}>{l.archivedAt ? <><ArchiveRestore className="h-3.5 w-3.5" />Restore</> : <><Archive className="h-3.5 w-3.5" />Archive</>}</button>
                {l.archivedAt && <button className="btn-danger btn-sm" onClick={remove}><Trash2 className="h-3.5 w-3.5" />Delete permanently</button>}
              </div>
            </section>
          )}
        </aside>

        <section className="card min-w-0">
          <div className="px-5 pt-4">
            <Tabs value={tab} onChange={setTab} tabs={[{ value: 'timeline', label: 'Timeline' }, { value: 'tasks', label: 'Follow-ups', count: openTasks.length }]} />
          </div>

          {tab === 'timeline' ? (
            <div className="card-pad">
              {canEdit && (
                <form onSubmit={addNote} className="mb-5">
                  <textarea className="input min-h-[76px]" placeholder="Write a note about this lead…" value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} aria-label="New note"
                    onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') addNote(e); }} />
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-ink-faint">Ctrl + Enter to save</span>
                    <button className="btn-ink btn-sm" disabled={saving || !note.trim()}>{saving && <Spinner />}Add note</button>
                  </div>
                </form>
              )}
              {acts.error ? <ErrorState message={acts.error.message} onRetry={acts.reload} />
                : !acts.data ? <Skeleton rows={4} />
                : (
                  <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-ink/10">
                    {acts.data.map((a) => {
                      const d = describe(a);
                      return (
                        <li key={a.id} className="relative flex gap-3">
                          <span className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink/10 bg-white text-ink-muted"><d.icon className="h-3.5 w-3.5" /></span>
                          <div className="min-w-0 flex-1 pt-1">
                            <p className="text-ink-soft">{d.text}</p>
                            {d.body && <p className="mt-1.5 whitespace-pre-wrap break-words rounded-xl bg-cream px-3 py-2">{d.body}</p>}
                            <p className="mt-0.5 text-xs text-ink-faint">{a.actor?.name ?? 'System'} · <time title={new Date(a.createdAt).toLocaleString('en-IN')}>{relTime(a.createdAt)}</time></p>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
            </div>
          ) : !l.tasks.length ? (
            <EmptyState icon={CalendarCheck} title="No follow-ups yet" text="Schedule a callback, meeting or demo so this lead is not forgotten."
              action={!l.archivedAt ? <button className="btn-ghost btn-sm" onClick={() => { setEditTask(null); setTaskOpen(true); }}>Schedule follow-up</button> : undefined} />
          ) : (
            <ul className="divide-y divide-ink/5">
              {l.tasks.map((t) => {
                const late = t.status === 'OPEN' && new Date(t.dueAt) < new Date();
                return (
                  <li key={t.id} className="flex items-start gap-3 px-5 py-3.5">
                    <input type="checkbox" className="mt-1" checked={t.status === 'DONE'} disabled={t.status === 'CANCELLED'} onChange={() => setTaskStatus(t, t.status === 'DONE' ? 'OPEN' : 'DONE')} aria-label={`Mark ${t.title} as done`} />
                    <div className="min-w-0 flex-1">
                      <p className={cx('font-medium', t.status !== 'OPEN' && 'text-ink-muted line-through')}>{t.title}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-ink-muted">
                        <span>{TASK_TYPES[t.type]}</span><span className={late ? 'font-semibold text-danger' : undefined}>{late ? 'Overdue · ' : ''}{fmtDateTime(t.dueAt)}</span><span>{t.assignee?.name}</span>
                      </p>
                      {t.notes && <p className="mt-1 text-[13px] text-ink-soft">{t.notes}</p>}
                    </div>
                    {t.status === 'OPEN' && <button className="btn-ghost btn-sm" onClick={() => { setEditTask(t); setTaskOpen(true); }}>Reschedule</button>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <LeadForm open={editOpen} onClose={() => setEditOpen(false)} lead={l} onSaved={reload} />
      <TaskForm open={taskOpen} onClose={() => setTaskOpen(false)} leadId={l.id} task={editTask} onSaved={reload} />
    </div>
  );
}
