'use client';
import { CalendarCheck, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { TaskForm } from '@/components/forms';
import { EmptyState, ErrorState, PageHeader, Pagination, Skeleton, Tabs, cx, useUi } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { TASK_TYPES, Task, useChanged, useRefs } from '@/lib/refs';

type View = 'today' | 'overdue' | 'upcoming' | 'done';
const EMPTY: Record<View, [string, string]> = {
  today: ['Nothing due today', 'Follow-ups scheduled for today appear here.'],
  overdue: ['Nothing overdue', 'You are on top of every follow-up.'],
  upcoming: ['Nothing scheduled ahead', 'Schedule a follow-up so no lead is forgotten.'],
  done: ['No completed follow-ups yet', 'Tasks you complete are listed here.'],
};
const PRIORITY: Record<string, string> = { HIGH: 'pill-danger', MEDIUM: 'pill-muted', LOW: 'pill-muted' };

export default function FollowUpsPage() {
  const { me, can } = useAuth();
  const { members } = useRefs();
  const { toast, confirm } = useUi();
  const [view, setView] = useState<View>('today');
  const [assignee, setAssignee] = useState('me');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<{ open: boolean; task: Task | null }>({ open: false, task: null });

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('view');
    if (v && v in EMPTY) setView(v as View);
  }, []);
  useEffect(() => setPage(1), [view, assignee]);

  const list = useApi<{ items: Task[]; total: number; page: number; pageSize: number; counts: Record<'today' | 'overdue' | 'upcoming', number> }>(`/tasks${qs({ view, assignee, page, pageSize: 25 })}`);
  useChanged(list.reload);
  const c = list.data?.counts;

  async function setStatus(t: Task, status: string) {
    try {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status } });
      toast(status === 'DONE' ? 'Marked as done' : 'Reopened');
      list.reload();
      window.dispatchEvent(new Event('pmc:changed'));
    } catch (e) { toast((e as Error).message, 'error'); }
  }
  async function remove(t: Task) {
    if (!(await confirm({ title: 'Delete this task?', text: `"${t.title}" will be removed. This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api(`/tasks/${t.id}`, { method: 'DELETE' });
      toast('Task deleted');
      window.dispatchEvent(new Event('pmc:changed'));
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  return (
    <div className="mx-auto max-w-[1000px]">
      <PageHeader
        title="Follow-ups"
        subtitle="Callbacks, meetings and tasks"
        actions={
          <>
            {can('tasks.manage') && (
              <select className="input w-auto" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
                <option value="me">My tasks</option><option value="all">{me?.role.scope === 'ALL' ? 'Everyone' : 'My team'}</option>
                {members.filter((m) => m.id !== me?.user.id && m.status === 'ACTIVE').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
            <button className="btn-primary" onClick={() => setForm({ open: true, task: null })}><Plus className="h-4 w-4" />New follow-up</button>
          </>
        }
      />
      <Tabs
        value={view}
        onChange={setView}
        tabs={[
          { value: 'today', label: 'Today', count: c?.today },
          { value: 'overdue', label: 'Overdue', count: c?.overdue },
          { value: 'upcoming', label: 'Upcoming', count: c?.upcoming },
          { value: 'done', label: 'Done' },
        ]}
      />

      <div className="card mt-4 overflow-hidden">
        {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} />
          : !list.data ? <Skeleton rows={5} />
          : !list.data.items.length ? <EmptyState icon={CalendarCheck} title={EMPTY[view][0]} text={EMPTY[view][1]} />
          : (
            <ul className={cx('divide-y divide-ink/5', list.loading && 'opacity-60')}>
              {list.data.items.map((t) => {
                const late = t.status === 'OPEN' && new Date(t.dueAt) < new Date();
                return (
                  <li key={t.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                    <input type="checkbox" className="mt-1" checked={t.status === 'DONE'} onChange={() => setStatus(t, t.status === 'DONE' ? 'OPEN' : 'DONE')} aria-label={`Mark ${t.title} as done`} />
                    <div className="min-w-0 flex-1">
                      <p className={cx('font-medium', t.status === 'DONE' && 'text-ink-muted line-through')}>{t.title}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-ink-muted">
                        <span className="pill-muted">{TASK_TYPES[t.type]}</span>
                        {t.priority === 'HIGH' && <span className={PRIORITY[t.priority]}>High priority</span>}
                        <span className={late ? 'font-semibold text-danger' : undefined}>{fmtDateTime(t.dueAt)}</span>
                        {t.lead && <Link href={`/leads/${t.lead.id}`} className="font-medium text-ink hover:underline">{t.lead.name}</Link>}
                        {t.lead?.phone && <a href={`tel:${t.lead.phone.replace(/[^\d+]/g, '')}`} className="hover:underline">{t.lead.phone}</a>}
                        {assignee !== 'me' && <span>{t.assignee?.name}</span>}
                      </p>
                      {t.notes && <p className="mt-1 text-[13px] text-ink-soft">{t.notes}</p>}
                    </div>
                    <div className="flex shrink-0">
                      <button className="btn-icon" onClick={() => setForm({ open: true, task: t })} aria-label={`Edit ${t.title}`}><Pencil className="h-4 w-4" /></button>
                      <button className="btn-icon" onClick={() => remove(t)} aria-label={`Delete ${t.title}`}><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
      </div>

      <TaskForm open={form.open} task={form.task} onClose={() => setForm({ open: false, task: null })} />
    </div>
  );
}
