'use client';
import { ArrowUpRight, BarChart3, CalendarCheck, Sparkles, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { TaskForm } from '@/components/forms';
import { Avatar, ColorDot, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, greeting, money } from '@/lib/format';
import { TASK_TYPES, Task, useChanged } from '@/lib/refs';

type Summary = {
  days: number;
  leads: { total: number; new: number; open: number; won: number; lost: number; unassigned: number };
  conversionRate: number | null;
  value: { pipeline: number; won: number };
  tasks: { today: number; overdue: number };
  byStage: { id: string; name: string; color: string; type: string; count: number; value: number }[];
  bySource: { id: string | null; name: string; count: number }[];
  byOwner: { id: string | null; name: string; leads: number; won: number; wonValue: number }[];
  trend: { date: string; count: number }[];
};

function Stat({ label, value, sub, href }: { label: string; value: string; sub: string; href?: string }) {
  const body = (
    <>
      <div className="flex items-center justify-between text-ink-muted">
        <span className="text-[13px]">{label}</span>
        {href && <ArrowUpRight className="h-3.5 w-3.5" />}
      </div>
      <p className="mt-1.5 font-display text-[28px] font-extrabold leading-none tracking-tight">{value}</p>
      <p className="mt-2 text-[13px] text-ink-muted">{sub}</p>
    </>
  );
  return href ? <Link href={href} className="card card-pad transition hover:border-ink/20 hover:shadow-soft">{body}</Link> : <div className="card card-pad">{body}</div>;
}

function Bars({ rows, total }: { rows: { key: string; name: string; count: number; color?: string; extra?: string }[]; total: number }) {
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 font-medium"><ColorDot color={r.color ?? '#1C1917'} /><span className="truncate">{r.name}</span></span>
            <span className="shrink-0 text-ink-muted"><span className="font-semibold text-ink">{r.count}</span>{r.extra ? ` · ${r.extra}` : ''}</span>
          </div>
          <div className="mt-1.5 h-1.5 rounded-full bg-ink/5">
            <div className="h-full rounded-full" style={{ width: `${total ? Math.max((r.count / total) * 100, r.count ? 2 : 0) : 0}%`, background: r.color ?? '#1C1917' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Trend({ data }: { data: Summary['trend'] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex h-36 items-end gap-1.5" role="img" aria-label={`New leads per day for the last 14 days, ${data.reduce((a, d) => a + d.count, 0)} in total`}>
      {data.map((d) => (
        <div key={d.date} className="group flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${new Date(d.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}: ${d.count}`}>
          <span className="text-[11px] font-semibold text-ink-muted opacity-0 transition group-hover:opacity-100">{d.count}</span>
          <div className="w-full rounded-t-md bg-ink/80 transition group-hover:bg-brand" style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count ? 4 : 2, opacity: d.count ? 1 : 0.15 }} />
          <span className="text-[10px] text-ink-faint">{new Date(d.date).getDate()}</span>
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const { me, can } = useAuth();
  const canReports = can('reports.view');
  const summary = useApi<Summary>(canReports ? '/dashboard?days=30' : null);
  const today = useApi<{ items: Task[]; counts: { today: number; overdue: number; upcoming: number } }>('/tasks?view=today&pageSize=6');
  const [taskForm, setTaskForm] = useState(false);
  useChanged(() => { summary.reload(); today.reload(); });
  if (!me) return null;
  const d = summary.data;
  const cur = me.organisation.currency;
  const overdue = today.data?.counts.overdue ?? 0;

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader
        title={<>{greeting()}, <span className="text-green">{me.user.name.split(' ')[0]}</span></>}
        subtitle={`${me.organisation.name} · ${new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`}
        actions={
          <>
            {canReports && <Link href="/reports" className="btn-ghost"><BarChart3 className="h-4 w-4" />Reports</Link>}
            {can('leads.view') && <Link href="/leads" className="btn-ghost"><UserPlus className="h-4 w-4" />View leads</Link>}
            <button className="btn-primary" onClick={() => setTaskForm(true)}><CalendarCheck className="h-4 w-4" />Schedule follow-up</button>
          </>
        }
      />

      {overdue > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-ink px-6 py-5 text-white">
          <div>
            <p className="font-display text-xl font-extrabold tracking-tight">{overdue} follow-up{overdue > 1 ? 's are' : ' is'} overdue</p>
            <p className="mt-0.5 text-white/70">Leads are waiting to hear back from you.</p>
          </div>
          <Link href="/follow-ups?view=overdue" className="btn-primary">Review overdue</Link>
        </div>
      )}

      {canReports && (summary.error ? (
        <div className="card mb-5"><ErrorState message={summary.error.message} onRetry={summary.reload} /></div>
      ) : !d ? (
        <div className="card mb-5"><Skeleton rows={4} /></div>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Active leads" value={d.leads.open.toLocaleString('en-IN')} sub={`${d.leads.new} new in ${d.days} days · ${d.leads.unassigned} unassigned`} href="/leads?status=open" />
            <Stat label="Pipeline value" value={money(d.value.pipeline, cur)} sub={`${d.leads.total.toLocaleString('en-IN')} leads in total`} href="/pipeline" />
            <Stat label="Won" value={d.leads.won.toLocaleString('en-IN')} sub={`${money(d.value.won, cur)} closed`} href="/leads?status=won" />
            <Stat label="Conversion rate" value={d.conversionRate === null ? '—' : `${Math.round(d.conversionRate * 100)}%`} sub={d.conversionRate === null ? 'No closed leads yet' : `${d.leads.won} won · ${d.leads.lost} lost`} />
          </div>

          <div className="mb-5 grid gap-5 lg:grid-cols-[1.6fr_1fr]">
            <section className="card card-pad">
              <h2 className="card-title">New leads</h2>
              <p className="mb-4 text-ink-muted">Last 14 days</p>
              {d.trend.some((t) => t.count) ? <Trend data={d.trend} /> : <EmptyState icon={Sparkles} title="Your trend appears here" text="Add or import leads and this chart fills in." />}
            </section>
            <section className="card card-pad">
              <h2 className="card-title">Pipeline</h2>
              <p className="mb-4 text-ink-muted">Leads by stage</p>
              <Bars total={d.leads.total} rows={d.byStage.map((s) => ({ key: s.id, name: s.name, count: s.count, color: s.color, extra: s.value ? money(s.value, cur) : undefined }))} />
            </section>
          </div>

          <div className="mb-5 grid gap-5 lg:grid-cols-2">
            <section className="card card-pad">
              <h2 className="card-title">Lead sources</h2>
              <p className="mb-4 text-ink-muted">New leads in the last {d.days} days</p>
              {d.bySource.length ? <Bars total={d.leads.new} rows={d.bySource.slice(0, 8).map((s) => ({ key: s.id ?? 'none', name: s.name, count: s.count }))} /> : <p className="py-6 text-center text-ink-muted">No new leads in this period.</p>}
            </section>
            <section className="card">
              <div className="card-pad pb-2">
                <h2 className="card-title">Team</h2>
                <p className="text-ink-muted">Leads owned and deals won</p>
              </div>
              {d.byOwner.length ? (
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead><tr><th className="pl-5">Owner</th><th className="text-right">Leads</th><th className="text-right">Won</th><th className="pr-5 text-right">Won value</th></tr></thead>
                    <tbody>
                      {d.byOwner.slice(0, 8).map((o) => (
                        <tr key={o.id ?? 'none'}>
                          <td className="pl-5"><span className="flex items-center gap-2"><Avatar name={o.name} size={24} />{o.name}</span></td>
                          <td className="text-right">{o.leads}</td><td className="text-right">{o.won}</td><td className="pr-5 text-right">{money(o.wonValue, cur)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="px-5 pb-8 pt-4 text-center text-ink-muted">No leads yet.</p>}
            </section>
          </div>
        </>
      ))}

      <section className="card">
        <div className="flex items-center justify-between card-pad pb-3">
          <div>
            <h2 className="card-title">Today&rsquo;s follow-ups</h2>
            <p className="text-ink-muted">{today.data ? `${today.data.counts.today} due today · ${today.data.counts.upcoming} upcoming` : 'Loading…'}</p>
          </div>
          <Link href="/follow-ups" className="btn-ghost btn-sm">See all</Link>
        </div>
        {today.error ? <ErrorState message={today.error.message} onRetry={today.reload} />
          : !today.data ? <Skeleton rows={3} />
          : !today.data.items.length ? <EmptyState icon={CalendarCheck} title="Nothing due today" text="Schedule a follow-up so no lead is forgotten." action={<button className="btn-ghost btn-sm" onClick={() => setTaskForm(true)}>Schedule follow-up</button>} />
          : (
            <ul className="divide-y divide-ink/5 border-t border-ink/10">
              {today.data.items.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="pill-muted">{TASK_TYPES[t.type]}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{t.title}{t.lead && <Link href={`/leads/${t.lead.id}`} className="font-normal text-ink-muted hover:underline">{' · '}{t.lead.name}</Link>}</span>
                  <span className="shrink-0 text-[13px] text-ink-muted">{fmtDateTime(t.dueAt)}</span>
                </li>
              ))}
            </ul>
          )}
      </section>

      <TaskForm open={taskForm} onClose={() => setTaskForm(false)} />
    </div>
  );
}
