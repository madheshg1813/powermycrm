'use client';
import {
  Archive, ArchiveRestore, ArrowLeft, ArrowRightLeft, Banknote, CalendarCheck, CalendarPlus, Check, Download, FileText, GitMerge, Handshake, ListPlus, Mail, MessageSquareText, Paperclip, Pencil, Phone, PhoneCall, Plus, Trash2, UserRound, Sparkles, Upload, X, Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CALL_STATUS, LogCallForm } from '@/components/call-form';
import { OpportunityForm, PaymentForm } from '@/components/deal-forms';
import { LeadForm, TaskForm } from '@/components/forms';
import { Avatar, ColorDot, Dropdown, EmptyState, ErrorState, Field, LabelChip, Modal, Skeleton, Spinner, Tabs, cx, useUi } from '@/components/ui';
import { api, downloadFile, uploadFile, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fileSize, fmtDate, fmtDateTime, money, relTime } from '@/lib/format';
import { Attachment, Call, Lead, OPP_STATUS, Opportunity, PAYMENT_METHODS, PAYMENT_STATUS, Payment, TASK_TYPES, Task, useChanged, useRefs } from '@/lib/refs';

type Detail = Lead & { duplicates: { id: string; name: string; phone: string | null; email: string | null; createdAt: string; owner: { name: string } | null }[]; tasks: Task[]; opportunities: Opportunity[]; payments: Payment[]; attachments: Attachment[] };
type Tab = 'timeline' | 'tasks' | 'calls' | 'deals' | 'payments' | 'files';
type Activity = { id: string; type: string; data: any; createdAt: string; actor: { id: string; name: string } | null };

const FIELD_LABELS: Record<string, string> = { name: 'Name', phone: 'Phone', email: 'Email', company: 'Company', city: 'City', score: 'Score', dealValue: 'Deal value', expectedCloseAt: 'Expected close', source: 'Source', lostReason: 'Lost reason' };

function describe(a: Activity): { icon: React.ComponentType<{ className?: string }>; text: React.ReactNode; body?: string } {
  const d = a.data ?? {};
  switch (a.type) {
    case 'created': return { icon: Plus, text: d.via === 'import' ? 'Lead imported' : d.via === 'website_form' ? 'Lead received from the website form' : d.via === 'api' ? 'Lead received through the API' : 'Lead created' };
    case 'enquiry': return { icon: Sparkles, text: <>Enquired again{d.via === 'website_form' ? ' via the website form' : d.via === 'api' ? ' through the API' : ''}{d.name ? <> as <strong>{d.name}</strong></> : ''}</> };
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
    case 'opportunity_created': return { icon: Handshake, text: <>Added deal <strong>{d.name}</strong>{d.value ? ` worth ${money(d.value)}` : ''}</> };
    case 'opportunity_won': return { icon: Handshake, text: <>Won deal <strong>{d.name}</strong>{d.value ? ` worth ${money(d.value)}` : ''}</> };
    case 'opportunity_lost': return { icon: Handshake, text: <>Lost deal <strong>{d.name}</strong>{d.lostReason ? ` (${d.lostReason})` : ''}</> };
    case 'opportunity_reopened': return { icon: Handshake, text: <>Reopened deal <strong>{d.name}</strong></> };
    case 'opportunity_updated': return { icon: Handshake, text: <>Updated deal <strong>{d.name}</strong></> };
    case 'opportunity_deleted': return { icon: Handshake, text: <>Deleted deal <strong>{d.name}</strong></> };
    case 'payment_recorded': return { icon: Banknote, text: <>Expecting payment of <strong>{money(d.amount, d.currency)}</strong></> };
    case 'payment_received': return { icon: Banknote, text: <>Received <strong>{money(d.amount, d.currency)}</strong>{d.method ? ` by ${PAYMENT_METHODS[d.method as Payment['method']] ?? d.method}` : ''}{d.reference ? ` (${d.reference})` : ''}</> };
    case 'payment_refunded': return { icon: Banknote, text: <>Refunded <strong>{money(d.amount, d.currency)}</strong></> };
    case 'payment_failed': return { icon: Banknote, text: <>Payment of <strong>{money(d.amount, d.currency)}</strong> failed</> };
    case 'payment_updated': return { icon: Banknote, text: 'Updated a payment' };
    case 'call_logged': return { icon: PhoneCall, text: <>{d.direction === 'INBOUND' ? 'Inbound call' : 'Called'}{d.status === 'COMPLETED' ? d.durationSec ? ` · ${Math.floor(d.durationSec / 60)}m ${d.durationSec % 60}s` : '' : ` · ${CALL_STATUS[d.status as Call['status']] ?? d.status}`}{d.disposition ? <> · <strong>{d.disposition}</strong></> : ''}</>, body: d.notes ?? undefined };
    case 'enquiry_repeat': return { icon: Sparkles, text: 'Enquired again' };
    case 'automation_ran': return { icon: Zap, text: <>Automation <strong>{d.name}</strong> ran {d.steps} step{d.steps === 1 ? '' : 's'}</> };
    case 'attachment_added': return { icon: Paperclip, text: <>Added file <strong>{d.name}</strong></> };
    case 'attachment_removed': return { icon: Paperclip, text: <>Removed file <strong>{d.name}</strong></> };
    case 'archived': return { icon: Archive, text: 'Archived' };
    case 'restored': return { icon: ArchiveRestore, text: 'Restored' };
    default: return { icon: Sparkles, text: a.type.replace(/_/g, ' ') };
  }
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, can } = useAuth();
  const { pipelines, members, fields, lists, connected, reload: reloadRefs } = useRefs();
  const { toast, confirm } = useUi();
  const lead = useApi<Detail>(`/leads/${id}`);
  const acts = useApi<Activity[]>(`/leads/${id}/activities`);
  const [tab, setTab] = useState<Tab>('timeline');
  const [dealOpen, setDealOpen] = useState(false);
  const [editDeal, setEditDeal] = useState<Opportunity | null>(null);
  const [losing, setLosing] = useState<Opportunity | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const calls = useApi<{ items: Call[]; total: number; totals: { calls: number; talkTimeSec: number } }>(`/calls?leadId=${id}&pageSize=50`);
  const [callOpen, setCallOpen] = useState(false);
  const [editCall, setEditCall] = useState<Call | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editPay, setEditPay] = useState<Payment | null>(null);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'deals' || t === 'payments' || t === 'tasks' || t === 'files' || t === 'calls') setTab(t);
  }, []);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const reload = () => { lead.reload(); acts.reload(); calls.reload(); };
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

  async function listMembership(listId: string, add: boolean, name: string) {
    try {
      await api('/leads/bulk', { body: { ids: [id], action: add ? 'addToList' : 'removeFromList', value: listId } });
      toast(add ? `Added to ${name}` : `Removed from ${name}`);
      lead.reload();
      reloadRefs();
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  async function patchDeal(d: Opportunity, body: Record<string, unknown>, message: string) {
    try { await api(`/opportunities/${d.id}`, { method: 'PATCH', body }); toast(message); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }
  async function deleteDeal(d: Opportunity) {
    if (!(await confirm({ title: `Delete the deal ${d.name}?`, text: 'Payments recorded against it stay on the lead. This cannot be undone.', confirmLabel: 'Delete deal', danger: true }))) return;
    try { await api(`/opportunities/${d.id}`, { method: 'DELETE' }); toast('Deal deleted'); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }
  async function patchPayment(p: Payment, body: Record<string, unknown>, message: string) {
    try { await api(`/payments/${p.id}`, { method: 'PATCH', body }); toast(message); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }
  async function deletePayment(p: Payment) {
    if (!(await confirm({ title: `Delete this ${money(p.amount, p.currency)} payment?`, text: 'Only expected or failed payments can be deleted. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api(`/payments/${p.id}`, { method: 'DELETE' }); toast('Payment deleted'); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    try { await uploadFile(`/leads/${id}/attachments`, file); toast(`${file.name} uploaded`); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function removeFile(a: Attachment) {
    if (!(await confirm({ title: `Delete ${a.name}?`, text: 'The file is removed from storage. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api(`/attachments/${a.id}`, { method: 'DELETE' }); toast('File deleted'); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  async function paymentLink(p: Payment) {
    try { const r = await api<Payment>(`/payments/${p.id}/link`, { body: {} }); toast('Payment link created'); if (r.linkUrl) { try { await navigator.clipboard.writeText(r.linkUrl); toast('Link copied to clipboard'); } catch { /* clipboard unavailable */ } } reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }
  async function callViaProvider() {
    try { await api('/calls/click-to-call', { body: { leadId: id } }); toast('Calling: your phone rings first, then the lead'); setTimeout(() => calls.reload(), 3000); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  async function deleteCall(c: Call) {
    if (!(await confirm({ title: 'Delete this call record?', text: 'The timeline entry stays; the call itself is removed from reports.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api(`/calls/${c.id}`, { method: 'DELETE' }); toast('Call deleted'); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
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
            {l.phone && connected.exotel && !l.archivedAt && <button className="btn-ghost" onClick={callViaProvider} title="Rings your phone first, then the lead; logged automatically"><PhoneCall className="h-4 w-4" />Call via Exotel</button>}
            {l.phone && <a className="btn-ghost" href={`tel:${l.phone.replace(/[^\d+]/g, '')}`} title="Opens your device's phone app and logs the call" onClick={() => { if (!l.archivedAt) { setEditCall(null); setTimeout(() => setCallOpen(true), 400); } }}><Phone className="h-4 w-4" />Call</a>}
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
            {(l.lists.length > 0 || (canEdit && lists.length > 0)) && (
              <div className="mt-4 border-t border-ink/10 pt-4">
                <span className="label">Lists</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {l.lists.map((x) => (
                    <span key={x.id} className="pill-muted gap-1 pr-1">
                      <Link href={`/leads?listId=${x.id}`} className="hover:underline">{x.name}</Link>
                      {canEdit && <button className="rounded-full p-0.5 hover:bg-ink/10" onClick={() => listMembership(x.id, false, x.name)} aria-label={`Remove from ${x.name}`}><X className="h-3 w-3" /></button>}
                    </span>
                  ))}
                  {canEdit && lists.some((x) => !l.lists.some((y) => y.id === x.id)) && (
                    <Dropdown align="left" trigger={() => <button className="btn-ghost btn-sm"><ListPlus className="h-3.5 w-3.5" />Add to list</button>}>
                      {(close) => <div className="max-h-64 overflow-y-auto">{lists.filter((x) => !l.lists.some((y) => y.id === x.id)).map((x) => <button key={x.id} className="menu-item" onClick={() => { close(); listMembership(x.id, true, x.name); }}>{x.name}</button>)}</div>}
                    </Dropdown>
                  )}
                </div>
              </div>
            )}
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
            <Tabs value={tab} onChange={setTab} tabs={[
              { value: 'timeline' as Tab, label: 'Timeline' },
              { value: 'tasks' as Tab, label: 'Follow-ups', count: openTasks.length },
              { value: 'calls' as Tab, label: 'Calls', count: calls.data?.total || undefined },
              { value: 'deals' as Tab, label: 'Deals', count: l.opportunities.filter((d) => d.status === 'OPEN').length },
              ...(can('payments.view') ? [{ value: 'payments' as Tab, label: 'Payments', count: l.payments.filter((p) => p.status === 'PENDING').length }] : []),
              { value: 'files' as Tab, label: 'Files', count: l.attachments.length || undefined },
            ]} />
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
          ) : tab === 'tasks' ? (!l.tasks.length ? (
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
          )) : tab === 'calls' ? (
            <div>
              {!l.archivedAt && <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4"><p className="text-ink-muted">{calls.data?.total ? `${calls.data.totals.calls} call${calls.data.totals.calls === 1 ? '' : 's'} · ${Math.round(calls.data.totals.talkTimeSec / 60)} min on the phone` : 'Log each call so the outcome and next step are on record.'}</p><button className="btn-ghost btn-sm" onClick={() => { setEditCall(null); setCallOpen(true); }}><PhoneCall className="h-3.5 w-3.5" />Log call</button></div>}
              {calls.error ? <ErrorState message={calls.error.message} onRetry={calls.reload} /> : !calls.data ? <Skeleton rows={3} /> : !calls.data.items.length ? <EmptyState icon={PhoneCall} title="No calls logged" text="Use the Call button above; the log dialog opens after your phone app." /> : (
                <ul className="divide-y divide-ink/5">
                  {calls.data.items.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{c.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} · {CALL_STATUS[c.status]}{c.disposition && <span className="pill-muted ml-2">{c.disposition.name}</span>}</p>
                        <p className="mt-0.5 flex flex-wrap gap-x-2 text-[13px] text-ink-muted"><span>{fmtDateTime(c.startedAt)}</span>{c.durationSec !== null && c.status === 'COMPLETED' && <span>{Math.floor(c.durationSec / 60)}m {c.durationSec % 60}s</span>}<span>{c.user?.name}</span>{c.phone && <span>{c.phone}</span>}</p>
                        {c.notes && <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-soft">{c.notes}</p>}
                        {c.recordingUrl && <a className="mt-1 inline-block text-[13px] font-medium underline" href={c.recordingUrl} target="_blank" rel="noopener noreferrer">Recording</a>}
                      </div>
                      {(c.userId === me?.user.id || can('tasks.manage')) && <span className="flex gap-1"><button className="btn-icon" onClick={() => { setEditCall(c); setCallOpen(true); }} aria-label="Edit call"><Pencil className="h-4 w-4" /></button><button className="btn-icon" onClick={() => deleteCall(c)} aria-label="Delete call"><Trash2 className="h-4 w-4" /></button></span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : tab === 'files' ? (
            <div>
              {canEdit && (
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
                  <p className="text-ink-muted">Quotes, ID proofs, recordings. PDF, images, Office files, CSV, text and audio up to 10 MB.</p>
                  <input ref={fileInput} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.mp3,.m4a,.wav,.mp4" onChange={(e) => upload(e.target.files)} aria-label="Choose a file" />
                  <button className="btn-ghost btn-sm" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? <Spinner /> : <Upload className="h-3.5 w-3.5" />}Upload file</button>
                </div>
              )}
              {!l.attachments.length ? <EmptyState icon={FileText} title="No files yet" text="Files you add here stay with the lead and are logged on its timeline." /> : (
                <ul className="divide-y divide-ink/5">
                  {l.attachments.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                      <FileText className="h-4 w-4 shrink-0 text-ink-muted" />
                      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{a.name}</span><span className="text-[13px] text-ink-muted">{fileSize(a.size)} · {a.uploadedBy?.name ?? 'Unknown'} · {fmtDateTime(a.createdAt)}</span></span>
                      <button className="btn-ghost btn-sm" onClick={() => downloadFile(`/attachments/${a.id}/download`, a.name).catch((e) => toast((e as Error).message, 'error'))}><Download className="h-3.5 w-3.5" />Download</button>
                      {canEdit && <button className="btn-icon" onClick={() => removeFile(a)} aria-label={`Delete ${a.name}`}><Trash2 className="h-4 w-4" /></button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : tab === 'deals' ? (
            <div>
              {canEdit && <div className="flex items-center justify-between gap-3 px-5 pt-4"><p className="text-ink-muted">{l.opportunities.length ? `${money(l.opportunities.filter((d) => d.status === 'WON').reduce((a, d) => a + d.value, 0), me?.organisation.currency)} won · ${money(l.opportunities.filter((d) => d.status === 'OPEN').reduce((a, d) => a + d.value, 0), me?.organisation.currency)} open` : 'Track each sale, upsell or renewal as its own deal.'}</p><button className="btn-ghost btn-sm" onClick={() => { setEditDeal(null); setDealOpen(true); }}><Plus className="h-3.5 w-3.5" />New deal</button></div>}
              {!l.opportunities.length ? <EmptyState icon={Handshake} title="No deals yet" text="A deal records the value you expect to close and feeds the forecast." /> : (
                <ul className="divide-y divide-ink/5">
                  {l.opportunities.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{d.name}<span className={cx('ml-2', d.status === 'WON' ? 'pill-green' : d.status === 'LOST' ? 'pill-danger' : 'pill-muted')}>{OPP_STATUS[d.status]}</span></p>
                        <p className="mt-0.5 flex flex-wrap gap-x-2 text-[13px] text-ink-muted">
                          <span className="font-semibold text-ink">{money(d.value, me?.organisation.currency)}</span>
                          {d.status === 'OPEN' && <span>{d.probability}% likely</span>}
                          {d.expectedCloseAt && d.status === 'OPEN' && <span>expected {fmtDate(d.expectedCloseAt)}</span>}
                          {d.closedAt && <span>closed {fmtDate(d.closedAt)}</span>}
                          {d.owner && <span>{d.owner.name}</span>}
                          {d.lostReason && <span>· {d.lostReason}</span>}
                        </p>
                        {d.notes && <p className="mt-1 text-[13px] text-ink-soft">{d.notes}</p>}
                      </div>
                      {canEdit && (
                        <span className="flex flex-wrap gap-1.5">
                          {d.status === 'OPEN' && <button className="btn-ghost btn-sm" onClick={() => patchDeal(d, { status: 'WON' }, 'Deal marked as won')}>Won</button>}
                          {d.status === 'OPEN' && <button className="btn-ghost btn-sm" onClick={() => { setLostReason(''); setLosing(d); }}>Lost</button>}
                          {d.status !== 'OPEN' && <button className="btn-ghost btn-sm" onClick={() => patchDeal(d, { status: 'OPEN' }, 'Deal reopened')}>Reopen</button>}
                          <button className="btn-icon" onClick={() => { setEditDeal(d); setDealOpen(true); }} aria-label={`Edit ${d.name}`}><Pencil className="h-4 w-4" /></button>
                          {can('leads.delete') && <button className="btn-icon" onClick={() => deleteDeal(d)} aria-label={`Delete ${d.name}`}><Trash2 className="h-4 w-4" /></button>}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div>
              {can('payments.manage') && !l.archivedAt && <div className="flex items-center justify-between gap-3 px-5 pt-4"><p className="text-ink-muted">{l.payments.length ? `${money(l.payments.filter((p) => p.status === 'PAID').reduce((a, p) => a + p.amount, 0), me?.organisation.currency)} received · ${money(l.payments.filter((p) => p.status === 'PENDING').reduce((a, p) => a + p.amount, 0), me?.organisation.currency)} expected` : 'Record money received or expected from this lead.'}</p><button className="btn-ghost btn-sm" onClick={() => { setEditPay(null); setPayOpen(true); }}><Plus className="h-3.5 w-3.5" />Record payment</button></div>}
              {!l.payments.length ? <EmptyState icon={Banknote} title="No payments yet" text="Payments you record here also appear on the Payments page." /> : (
                <ul className="divide-y divide-ink/5">
                  {l.payments.map((p) => {
                    const overdue = p.status === 'PENDING' && p.dueAt && new Date(p.dueAt) < new Date();
                    return (
                      <li key={p.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{money(p.amount, p.currency)}<span className={cx('ml-2', p.status === 'PAID' ? 'pill-green' : p.status === 'FAILED' ? 'pill-danger' : overdue ? 'pill-amber' : 'pill-muted')}>{overdue ? 'Overdue' : PAYMENT_STATUS[p.status]}</span></p>
                          <p className="mt-0.5 flex flex-wrap gap-x-2 text-[13px] text-ink-muted">
                            <span>{PAYMENT_METHODS[p.method]}</span>
                            {p.reference && <span>{p.reference}</span>}
                            {(p.status === 'PAID' || p.status === 'REFUNDED') && p.paidAt && <span>received {fmtDate(p.paidAt)}</span>}
                            {p.status === 'PENDING' && p.dueAt && <span>due {fmtDate(p.dueAt)}</span>}
                            {p.opportunity && <span>for {p.opportunity.name}</span>}
                            {p.createdBy && <span>by {p.createdBy.name}</span>}
                          </p>
                          {p.notes && <p className="mt-1 text-[13px] text-ink-soft">{p.notes}</p>}
                        </div>
                        {can('payments.manage') && (
                          <span className="flex flex-wrap gap-1.5">
                            {p.status === 'PENDING' && connected.razorpay && !p.linkUrl && <button className="btn-ghost btn-sm" onClick={() => paymentLink(p)}>Create payment link</button>}
                            {p.linkUrl && <a className="btn-ghost btn-sm" href={p.linkUrl} target="_blank" rel="noopener noreferrer">Open link</a>}
                            {p.status === 'PENDING' && <button className="btn-ghost btn-sm" onClick={() => patchPayment(p, { status: 'PAID' }, 'Payment marked as received')}>Mark received</button>}
                            {p.status === 'PAID' && <button className="btn-ghost btn-sm" onClick={async () => { if (await confirm({ title: `Refund ${money(p.amount, p.currency)}?`, text: 'The payment is marked as refunded. The record is kept.', confirmLabel: 'Mark refunded', danger: true })) patchPayment(p, { status: 'REFUNDED' }, 'Payment marked as refunded'); }}>Refund</button>}
                            {p.status !== 'REFUNDED' && <button className="btn-icon" onClick={() => { setEditPay(p); setPayOpen(true); }} aria-label="Edit payment"><Pencil className="h-4 w-4" /></button>}
                            {(p.status === 'PENDING' || p.status === 'FAILED') && <button className="btn-icon" onClick={() => deletePayment(p)} aria-label="Delete payment"><Trash2 className="h-4 w-4" /></button>}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>

      <LogCallForm open={callOpen} onClose={() => setCallOpen(false)} leadId={l.id} phone={l.phone} call={editCall} onSaved={reload} />
      <OpportunityForm open={dealOpen} onClose={() => setDealOpen(false)} leadId={l.id} deal={editDeal} onSaved={reload} />
      <PaymentForm open={payOpen} onClose={() => setPayOpen(false)} leadId={l.id} deals={l.opportunities.filter((d) => d.status !== 'LOST').map((d) => ({ id: d.id, name: d.name }))} payment={editPay} onSaved={reload} />
      <Modal open={!!losing} onClose={() => setLosing(null)} title={`Mark ${losing?.name ?? 'deal'} as lost`}
        footer={<><button className="btn-ghost" onClick={() => setLosing(null)}>Cancel</button><button className="btn-danger" onClick={() => { if (losing) patchDeal(losing, { status: 'LOST', lostReason: lostReason || null }, 'Deal marked as lost'); setLosing(null); }}>Mark lost</button></>}>
        <Field label="Reason" hint="Optional, shown on the deal and in the timeline"><input className="input" value={lostReason} onChange={(e) => setLostReason(e.target.value)} maxLength={300} autoFocus placeholder="Chose a competitor" /></Field>
      </Modal>

      <LeadForm open={editOpen} onClose={() => setEditOpen(false)} lead={l} onSaved={reload} />
      <TaskForm open={taskOpen} onClose={() => setTaskOpen(false)} leadId={l.id} task={editTask} onSaved={reload} />
    </div>
  );
}
