'use client';
import { BarChart3, CalendarCheck, Download, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Avatar, EmptyState, ErrorState, PageHeader, Skeleton, Tabs, cx, useUi } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { TASK_TYPES, useRefs } from '@/lib/refs';

type Unit = 'hour' | 'day' | 'week' | 'month';
type Tab = 'overview' | 'agents' | 'sources' | 'followups';
type Range = { from: string; to: string; fromAt: string; toAt: string; unit: Unit; timezone: string };
type Summary = {
  range: Range;
  totals: { created: number; won: number; lost: number; wonValue: number; conversion: number | null; avgWonValue: number | null; openNow: number };
  series: { bucket: string; fromAt?: string; toAt?: string; created: number; won: number; lost: number; wonValue: number }[];
};
type AgentRow = { id: string | null; name: string; active: boolean; created: number; won: number; lost: number; wonValue: number; open: number; conversion: number | null; tasksCompleted: number; tasksOnTime: number; tasksOverdue: number; notes: number; calls: number; talkTimeSec: number };
type SourceRow = { id: string | null; name: string; created: number; won: number; lost: number; wonValue: number; open: number; conversion: number | null };
type FuMeasures = { due: number; completed: number; onTime: number; cancelled: number; overdue: number; upcoming: number };
type FollowUps = { range: Range; totals: FuMeasures; rows: ({ id: string; name: string; active: boolean } & FuMeasures)[]; byType: ({ type: string } & FuMeasures)[] };

// Series colours for the chart: the stage-palette blue for "created", and the green and danger tokens for won and lost.
// Validated for colour-vision separation with a legend and the table below as secondary encoding.
const SERIES = [
  { key: 'created', label: 'Created', color: '#2563EB' },
  { key: 'won', label: 'Won', color: '#168A4C' },
  { key: 'lost', label: 'Lost', color: '#B42318' },
] as const;

const PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'today', label: 'Today', range: () => [iso(0), iso(0)] },
  { key: 'yesterday', label: 'Yesterday', range: () => [iso(-1), iso(-1)] },
  { key: '7d', label: 'Last 7 days', range: () => [iso(-6), iso(0)] },
  { key: '30d', label: 'Last 30 days', range: () => [iso(-29), iso(0)] },
  { key: 'month', label: 'This month', range: () => [iso(0).slice(0, 8) + '01', iso(0)] },
  { key: 'lastMonth', label: 'Last month', range: () => { const d = new Date(); const first = new Date(d.getFullYear(), d.getMonth() - 1, 1); const last = new Date(d.getFullYear(), d.getMonth(), 0); return [local(first), local(last)]; } },
  { key: '90d', label: 'Last 90 days', range: () => [iso(-89), iso(0)] },
  { key: 'custom', label: 'Custom dates', range: () => [iso(-29), iso(0)] },
];
function local(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function iso(offsetDays: number) { const d = new Date(); d.setDate(d.getDate() + offsetDays); return local(d); }

function bucketLabel(bucket: string, unit: Unit) {
  if (unit === 'hour') return `${bucket}:00`;
  if (unit === 'month') { const [y, m] = bucket.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); }
  const d = new Date(`${bucket}T00:00:00`);
  const day = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return unit === 'week' ? `Week of ${day}` : day;
}
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const n = (v: number) => v.toLocaleString('en-IN');

/** Three thin bars per period. Hovering a period shows its figures; the table under the chart carries the same numbers. */
function GroupedBars({ series, unit }: { series: Summary['series']; unit: Unit }) {
  const max = Math.max(1, ...series.flatMap((s) => [s.created, s.won, s.lost]));
  const every = Math.max(1, Math.ceil(series.length / 12));
  const [hover, setHover] = useState<number | null>(null);
  const h = hover === null ? null : series[hover];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[13px] text-ink-soft" aria-hidden>
        {SERIES.map((s) => <span key={s.key} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}
        <span className="ml-auto min-h-[18px] text-ink-muted">{h ? `${bucketLabel(h.bucket, unit)}: ${h.created} created · ${h.won} won · ${h.lost} lost` : 'Hover a period for its figures'}</span>
      </div>
      <div className="flex h-44 items-end gap-[3px] border-b border-ink/10" role="img" aria-label={`Leads created, won and lost per ${unit}`} onMouseLeave={() => setHover(null)}>
        {series.map((s, i) => (
          <div key={s.bucket} className={cx('flex h-full flex-1 items-end justify-center gap-px rounded-t-md px-px transition', hover === i && 'bg-cream')} onMouseEnter={() => setHover(i)} title={`${bucketLabel(s.bucket, unit)}: ${s.created} created, ${s.won} won, ${s.lost} lost`}>
            {SERIES.map((k) => (
              <div key={k.key} className="w-full max-w-[14px] rounded-t-[3px]" style={{ height: `${(s[k.key] / max) * 100}%`, minHeight: s[k.key] ? 3 : 1, background: k.color, opacity: s[k.key] ? 1 : 0.15 }} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px] text-[10.5px] text-ink-faint">
        {series.map((s, i) => <span key={s.bucket} className="flex-1 truncate text-center">{i % every === 0 ? bucketLabel(s.bucket, unit).replace('Week of ', '') : ''}</span>)}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) {
  const body = <><span className="text-[13px] text-ink-muted">{label}</span><p className="mt-1.5 font-display text-[26px] font-extrabold leading-none tracking-tight">{value}</p>{sub && <p className="mt-2 text-[13px] text-ink-muted">{sub}</p>}</>;
  return href ? <Link href={href} className="card card-pad transition hover:border-ink/20 hover:shadow-soft">{body}</Link> : <div className="card card-pad">{body}</div>;
}

export default function ReportsPage() {
  const { me, can } = useAuth();
  const { members, sources } = useRefs();
  const { toast } = useUi();
  const [tab, setTab] = useState<Tab>('overview');
  const [preset, setPreset] = useState('30d');
  const [from, setFrom] = useState(iso(-29));
  const [to, setTo] = useState(iso(0));
  const [unit, setUnit] = useState<Unit>('day');
  const [ownerId, setOwnerId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = PRESETS.find((x) => x.key === preset);
    if (p && preset !== 'custom') { const [f, t] = p.range(); setFrom(f); setTo(t); }
  }, [preset]);

  const params = useMemo(() => ({ from, to, unit, ownerId, sourceId }), [from, to, unit, ownerId, sourceId]);
  const valid = from <= to;
  const summary = useApi<Summary>(valid && tab === 'overview' ? `/reports/summary${qs(params)}` : null);
  const agents = useApi<{ range: Range; rows: AgentRow[] }>(valid && tab === 'agents' ? `/reports/agents${qs(params)}` : null);
  const srcs = useApi<{ range: Range; rows: SourceRow[] }>(valid && tab === 'sources' ? `/reports/sources${qs(params)}` : null);
  const fu = useApi<FollowUps>(valid && tab === 'followups' ? `/reports/follow-ups${qs(params)}` : null);
  const cur = me?.organisation.currency;

  if (!can('reports.view')) return <div className="card"><EmptyState icon={BarChart3} title="Reports are not available to your role" text="Ask an administrator for the “View dashboard and reports” permission." /></div>;

  const range = summary.data?.range ?? agents.data?.range ?? srcs.data?.range ?? fu.data?.range;
  const drill = (extra: Record<string, string | undefined>) => `/leads${qs({ ownerId: ownerId || undefined, sourceId: sourceId || undefined, ...extra })}`;
  const createdLink = (r?: { fromAt?: string; toAt?: string }) => (r?.fromAt ? drill({ createdFrom: r.fromAt, createdTo: r.toAt }) : undefined);
  const closedLink = (status: 'won' | 'lost', r?: { fromAt?: string; toAt?: string }) => (r?.fromAt ? drill({ status, closedFrom: r.fromAt, closedTo: r.toAt }) : undefined);

  async function exportCsv() {
    setBusy(true);
    try {
      const report = tab === 'followups' ? 'followups' : tab === 'overview' ? 'summary' : tab;
      const csvText = await api<string>(`/reports/export${qs({ ...params, report })}`, { text: true });
      const url = URL.createObjectURL(new Blob([csvText], { type: 'text/csv;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `${report}-${from}-to-${to}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  const state = (q: { error: { message: string } | null; data: unknown; reload: () => void }, rows = 6) =>
    q.error ? <ErrorState message={q.error.message} onRetry={q.reload} /> : !q.data ? <Skeleton rows={rows} /> : null;
  const rangeText = range ? `${bucketLabel(range.from, 'day')} – ${bucketLabel(range.to, 'day')}${range.from.slice(0, 4) !== range.to.slice(0, 4) ? '' : ` ${range.to.slice(0, 4)}`} · ${range.timezone}` : undefined;

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader title="Reports" subtitle={rangeText} actions={<button className="btn-ghost" onClick={exportCsv} disabled={busy || !valid}><Download className="h-4 w-4" />Export CSV</button>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className="input w-auto" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Period">
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {preset === 'custom' && (
          <>
            <input type="date" className={cx('input w-auto', !valid && 'input-error')} value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="text-ink-muted">to</span>
            <input type="date" className={cx('input w-auto', !valid && 'input-error')} value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </>
        )}
        {tab === 'overview' && (
          <select className="input w-auto" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} aria-label="Group by">
            <option value="hour">By hour of day</option><option value="day">By day</option><option value="week">By week</option><option value="month">By month</option>
          </select>
        )}
        {me?.role.scope !== 'OWN' && (
          <select className="input w-auto" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Agent">
            <option value="">All agents</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.status !== 'ACTIVE' ? ' (deactivated)' : ''}</option>)}
          </select>
        )}
        <select className="input w-auto" value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Source">
          <option value="">All sources</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'agents', label: 'Agents' }, { value: 'sources', label: 'Lead sources' }, { value: 'followups', label: 'Follow-ups' }]} />

      {!valid && <div className="card mt-5"><ErrorState message="The start date must be on or before the end date." /></div>}

      {valid && tab === 'overview' && (state(summary) ? <div className="card mt-5">{state(summary)}</div> : summary.data && (
        <div className="mt-5 space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Leads created" value={n(summary.data.totals.created)} href={createdLink(summary.data.range)} />
            <Stat label="Won" value={n(summary.data.totals.won)} sub={summary.data.totals.avgWonValue === null ? undefined : `avg ${money(summary.data.totals.avgWonValue, cur)}`} href={closedLink('won', summary.data.range)} />
            <Stat label="Lost" value={n(summary.data.totals.lost)} href={closedLink('lost', summary.data.range)} />
            <Stat label="Won value" value={money(summary.data.totals.wonValue, cur)} />
            <Stat label="Conversion" value={pct(summary.data.totals.conversion)} sub={`${n(summary.data.totals.openNow)} open now`} href={drill({ status: 'open' })} />
          </div>
          <section className="card card-pad">
            <h2 className="card-title">Leads created, won and lost</h2>
            <p className="mb-4 text-ink-muted">{unit === 'hour' ? 'By hour of the day, across the whole period. Won and lost count the time a lead entered its closing stage.' : 'Won and lost count the day a lead entered its closing stage, not the day it was created.'}</p>
            {summary.data.series.some((s) => s.created || s.won || s.lost)
              ? <GroupedBars series={summary.data.series} unit={unit} />
              : <EmptyState icon={TrendingUp} title="Nothing in this period" text="No leads were created, won or lost between these dates." />}
          </section>
          <section className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th className="pl-5">Period</th><th className="text-right">Created</th><th className="text-right">Won</th><th className="text-right">Lost</th><th className="text-right">Conversion</th><th className="pr-5 text-right">Won value</th></tr></thead>
                <tbody>
                  {summary.data.series.map((s) => (
                    <tr key={s.bucket} className={!s.created && !s.won && !s.lost ? 'text-ink-faint' : undefined}>
                      <td className="pl-5 font-medium">{bucketLabel(s.bucket, unit)}</td>
                      <td className="text-right">{s.created && createdLink(s) ? <Link className="hover:underline" href={createdLink(s)!}>{n(s.created)}</Link> : n(s.created)}</td>
                      <td className="text-right">{s.won && closedLink('won', s) ? <Link className="hover:underline" href={closedLink('won', s)!}>{n(s.won)}</Link> : n(s.won)}</td>
                      <td className="text-right">{s.lost && closedLink('lost', s) ? <Link className="hover:underline" href={closedLink('lost', s)!}>{n(s.lost)}</Link> : n(s.lost)}</td>
                      <td className="text-right">{pct(s.won + s.lost ? s.won / (s.won + s.lost) : null)}</td>
                      <td className="pr-5 text-right">{money(s.wonValue, cur)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="font-semibold"><td className="pl-5">Total</td><td className="text-right">{n(summary.data.totals.created)}</td><td className="text-right">{n(summary.data.totals.won)}</td><td className="text-right">{n(summary.data.totals.lost)}</td><td className="text-right">{pct(summary.data.totals.conversion)}</td><td className="pr-5 text-right">{money(summary.data.totals.wonValue, cur)}</td></tr></tfoot>
              </table>
            </div>
          </section>
        </div>
      ))}

      {valid && tab === 'agents' && (
        <section className="card mt-5 overflow-hidden">
          <div className="card-pad pb-2"><h2 className="card-title">Agent leaderboard</h2><p className="text-ink-muted">Ranked by deals won, then won value. Open and overdue figures are as of now; everything else is within the period.</p></div>
          {state(agents) ?? (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th className="pl-5">#</th><th>Agent</th><th className="text-right">Created</th><th className="text-right">Won</th><th className="text-right">Lost</th><th className="text-right">Conversion</th><th className="text-right">Won value</th><th className="text-right">Open now</th><th className="text-right">Follow-ups done</th><th className="text-right">On time</th><th className="text-right">Overdue</th><th className="text-right">Notes</th><th className="text-right">Calls</th><th className="pr-5 text-right">Talk time</th></tr></thead>
                <tbody>
                  {agents.data!.rows.map((r, i) => (
                    <tr key={r.id ?? 'none'}>
                      <td className="pl-5 text-ink-muted">{i + 1}</td>
                      <td><span className="flex items-center gap-2"><Avatar name={r.name} size={24} />{r.id ? <Link className="font-medium hover:underline" href={drill({ ownerId: r.id, createdFrom: agents.data!.range.fromAt, createdTo: agents.data!.range.toAt })}>{r.name}</Link> : <span className="text-ink-muted">{r.name}</span>}{!r.active && r.id && <span className="pill-muted">Deactivated</span>}</span></td>
                      <td className="text-right">{n(r.created)}</td>
                      <td className="text-right">{r.won && r.id ? <Link className="hover:underline" href={drill({ ownerId: r.id, status: 'won', closedFrom: agents.data!.range.fromAt, closedTo: agents.data!.range.toAt })}>{n(r.won)}</Link> : n(r.won)}</td>
                      <td className="text-right">{n(r.lost)}</td><td className="text-right">{pct(r.conversion)}</td><td className="text-right">{money(r.wonValue, cur)}</td><td className="text-right">{n(r.open)}</td>
                      <td className="text-right">{n(r.tasksCompleted)}</td><td className="text-right">{r.tasksCompleted ? `${Math.round((r.tasksOnTime / r.tasksCompleted) * 100)}%` : '—'}</td>
                      <td className={cx('text-right', r.tasksOverdue > 0 && 'font-semibold text-danger')}>{n(r.tasksOverdue)}</td><td className="text-right">{n(r.notes)}</td><td className="text-right">{n(r.calls)}</td><td className="pr-5 text-right">{r.talkTimeSec ? `${Math.round(r.talkTimeSec / 60)} min` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {valid && tab === 'sources' && (
        <section className="card mt-5 overflow-hidden">
          <div className="card-pad pb-2"><h2 className="card-title">Lead sources</h2><p className="text-ink-muted">Which channels bring leads that close. Open figures are as of now.</p></div>
          {state(srcs) ?? (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th className="pl-5">Source</th><th className="text-right">Created</th><th className="text-right">Won</th><th className="text-right">Lost</th><th className="text-right">Conversion</th><th className="text-right">Won value</th><th className="pr-5 text-right">Open now</th></tr></thead>
                <tbody>
                  {srcs.data!.rows.map((r) => (
                    <tr key={r.id ?? 'none'} className={!r.created && !r.won && !r.lost && !r.open ? 'text-ink-faint' : undefined}>
                      <td className="pl-5 font-medium">{r.id ? <Link className="hover:underline" href={drill({ sourceId: r.id, createdFrom: srcs.data!.range.fromAt, createdTo: srcs.data!.range.toAt })}>{r.name}</Link> : r.name}</td>
                      <td className="text-right">{n(r.created)}</td><td className="text-right">{n(r.won)}</td><td className="text-right">{n(r.lost)}</td><td className="text-right">{pct(r.conversion)}</td><td className="text-right">{money(r.wonValue, cur)}</td><td className="pr-5 text-right">{n(r.open)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {valid && tab === 'followups' && (state(fu) ? <div className="card mt-5">{state(fu)}</div> : fu.data && (
        <div className="mt-5 space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Due in period" value={n(fu.data.totals.due)} />
            <Stat label="Completed" value={n(fu.data.totals.completed)} sub={fu.data.totals.completed ? `${Math.round((fu.data.totals.onTime / fu.data.totals.completed) * 100)}% on time` : undefined} />
            <Stat label="Overdue now" value={n(fu.data.totals.overdue)} href="/follow-ups?view=overdue" />
            <Stat label="Upcoming" value={n(fu.data.totals.upcoming)} href="/follow-ups?view=upcoming" />
          </div>
          <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
            <section className="card overflow-hidden">
              <div className="card-pad pb-2"><h2 className="card-title">By agent</h2></div>
              {fu.data.rows.length ? (
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead><tr><th className="pl-5">Agent</th><th className="text-right">Due</th><th className="text-right">Completed</th><th className="text-right">On time</th><th className="text-right">Cancelled</th><th className="text-right">Overdue now</th><th className="pr-5 text-right">Upcoming</th></tr></thead>
                    <tbody>
                      {fu.data.rows.map((r) => (
                        <tr key={r.id}>
                          <td className="pl-5"><span className="flex items-center gap-2"><Avatar name={r.name} size={24} /><span className="font-medium">{r.name}</span>{!r.active && <span className="pill-muted">Deactivated</span>}</span></td>
                          <td className="text-right">{n(r.due)}</td><td className="text-right">{n(r.completed)}</td><td className="text-right">{r.completed ? `${Math.round((r.onTime / r.completed) * 100)}%` : '—'}</td><td className="text-right">{n(r.cancelled)}</td>
                          <td className={cx('text-right', r.overdue > 0 && 'font-semibold text-danger')}>{n(r.overdue)}</td><td className="pr-5 text-right">{n(r.upcoming)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState icon={CalendarCheck} title="No follow-ups" text="Nothing was scheduled for this period." />}
            </section>
            <section className="card overflow-hidden">
              <div className="card-pad pb-2"><h2 className="card-title">By type</h2></div>
              {fu.data.byType.length ? (
                <table className="table">
                  <thead><tr><th className="pl-5">Type</th><th className="text-right">Due</th><th className="text-right">Completed</th><th className="pr-5 text-right">Overdue now</th></tr></thead>
                  <tbody>
                    {fu.data.byType.map((r) => (
                      <tr key={r.type}><td className="pl-5 font-medium">{TASK_TYPES[r.type] ?? r.type}</td><td className="text-right">{n(r.due)}</td><td className="text-right">{n(r.completed)}</td><td className={cx('pr-5 text-right', r.overdue > 0 && 'font-semibold text-danger')}>{n(r.overdue)}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="px-5 pb-6 text-center text-ink-muted">No follow-ups yet.</p>}
            </section>
          </div>
        </div>
      ))}
    </div>
  );
}
