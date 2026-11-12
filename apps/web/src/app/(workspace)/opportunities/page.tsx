'use client';
import { ArrowDown, ArrowUp, Handshake, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Avatar, EmptyState, ErrorState, PageHeader, Pagination, Skeleton, Tabs, cx } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, money } from '@/lib/format';
import { OPP_STATUS, Opportunity, useChanged, useRefs } from '@/lib/refs';

type View = 'OPEN' | 'WON' | 'LOST' | 'ALL';
type List = { items: Opportunity[]; total: number; page: number; pageSize: number; totals: Record<'open' | 'won' | 'lost', { count: number; value: number }> };
type Bucket = { count: number; value: number; weighted: number };
type Forecast = { timezone: string; months: ({ month: string } & Bucket)[]; overdue: Bucket; unscheduled: Bucket; later: Bucket; total: Bucket };
const COLS: { key: string; label: string; sort?: string; className?: string }[] = [
  { key: 'name', label: 'Deal', sort: 'name' },
  { key: 'lead', label: 'Lead' },
  { key: 'owner', label: 'Owner', className: 'hidden md:table-cell' },
  { key: 'value', label: 'Value', sort: 'value', className: 'text-right' },
  { key: 'prob', label: 'Probability', className: 'hidden sm:table-cell text-right' },
  { key: 'close', label: 'Expected close', sort: 'expectedCloseAt', className: 'hidden sm:table-cell' },
  { key: 'status', label: 'Status' },
];
const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); };

/** Open value by expected-close month, with the probability-weighted figure beside it. */
function ForecastCard({ fc, cur }: { fc: Forecast; cur?: string }) {
  const rows = [
    ...(fc.overdue.count ? [{ key: 'overdue', label: 'Past expected close', ...fc.overdue, warn: true }] : []),
    ...fc.months.map((m) => ({ key: m.month, label: monthLabel(m.month), ...m, warn: false })),
    ...(fc.later.count ? [{ key: 'later', label: 'Later', ...fc.later, warn: false }] : []),
    ...(fc.unscheduled.count ? [{ key: 'unscheduled', label: 'No expected close', ...fc.unscheduled, warn: false }] : []),
  ];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className="card card-pad">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="card-title">Forecast</h2>
        <p className="text-[13px] text-ink-muted"><span className="font-semibold text-ink">{money(fc.total.weighted, cur)}</span> weighted of {money(fc.total.value, cur)} open across {fc.total.count} deal{fc.total.count === 1 ? '' : 's'}</p>
      </div>
      <p className="mb-4 text-ink-muted">Open deals by expected close month. The weighted figure multiplies each value by its probability.</p>
      {fc.total.count ? (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={cx('font-medium', r.warn && 'text-amber')}>{r.label}<span className="ml-2 text-[12px] font-normal text-ink-muted">{r.count} deal{r.count === 1 ? '' : 's'}</span></span>
                <span className="shrink-0 text-ink-muted"><span className="font-semibold text-ink">{money(r.weighted, cur)}</span> of {money(r.value, cur)}</span>
              </div>
              <div className="relative mt-1.5 h-1.5 rounded-full bg-ink/5">
                <div className="absolute inset-y-0 left-0 rounded-full bg-ink/25" style={{ width: `${(r.value / max) * 100}%` }} />
                <div className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: `${(r.weighted / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="py-4 text-center text-ink-muted">No open deals. Add one from a lead page.</p>}
    </section>
  );
}

export default function OpportunitiesPage() {
  const { me } = useAuth();
  const { members } = useRefs();
  const [view, setView] = useState<View>('OPEN');
  const [ownerId, setOwnerId] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ by: 'expectedCloseAt', dir: 'asc' });
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => setPage(1), [view, ownerId, q, sort]);
  const params = useMemo(() => ({ status: view === 'ALL' ? '' : view, ownerId, q, sort: sort.by, dir: sort.dir, page, pageSize: 25 }), [view, ownerId, q, sort, page]);
  const list = useApi<List>(`/opportunities${qs(params)}`);
  const fc = useApi<Forecast>(view === 'OPEN' ? `/opportunities/forecast${qs({ months: 6 })}` : null);
  useChanged(() => { list.reload(); fc.reload(); });
  const cur = me?.organisation.currency;
  const t = list.data?.totals;
  const sortBy = (key: string) => setSort((s) => ({ by: key, dir: s.by === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader title="Deals" subtitle={t ? `${money(t.open.value, cur)} open in ${t.open.count} deal${t.open.count === 1 ? '' : 's'} · ${money(t.won.value, cur)} won` : undefined} />
      <Tabs value={view} onChange={setView} tabs={[{ value: 'OPEN', label: 'Open', count: t?.open.count }, { value: 'WON', label: 'Won', count: t?.won.count }, { value: 'LOST', label: 'Lost', count: t?.lost.count }, { value: 'ALL', label: 'All' }]} />
      <div className="my-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input className="input pl-9" placeholder="Search deals or leads…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search deals" />
        </div>
        {me?.role.scope !== 'OWN' && (
          <select className="input w-auto" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner">
            <option value="">All owners</option><option value="me">My deals</option><option value="unassigned">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
      </div>

      {view === 'OPEN' && fc.data && <div className="mb-5"><ForecastCard fc={fc.data} cur={cur} /></div>}

      <div className="card overflow-hidden">
        {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} />
          : !list.data ? <Skeleton rows={6} />
          : !list.data.items.length ? <EmptyState icon={Handshake} title={q || ownerId ? 'No deals match' : view === 'OPEN' ? 'No open deals' : 'No deals here'} text="Deals are added from a lead's page, under the Deals tab." />
          : (
            <div className={cx('overflow-x-auto', list.loading && 'opacity-60')}>
              <table className="table">
                <thead><tr>{COLS.map((c, i) => (
                  <th key={c.key} className={cx(c.className, i === 0 && 'pl-5')} aria-sort={c.sort && sort.by === c.sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sort ? <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => sortBy(c.sort!)}>{c.label}{sort.by === c.sort && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</button> : c.label}
                  </th>))}</tr></thead>
                <tbody>
                  {list.data.items.map((d) => {
                    const late = d.status === 'OPEN' && d.expectedCloseAt && new Date(d.expectedCloseAt) < new Date();
                    return (
                      <tr key={d.id}>
                        <td className="pl-5"><Link href={`/leads/${d.leadId}?tab=deals`} className="font-semibold hover:underline">{d.name}</Link></td>
                        <td><Link href={`/leads/${d.leadId}`} className="hover:underline">{d.lead?.name}</Link></td>
                        <td className="hidden md:table-cell">{d.owner ? <span className="flex items-center gap-2"><Avatar name={d.owner.name} size={22} />{d.owner.name}</span> : <span className="text-ink-faint">Unassigned</span>}</td>
                        <td className="text-right font-medium">{money(d.value, cur)}</td>
                        <td className="hidden text-right sm:table-cell">{d.probability}%</td>
                        <td className={cx('hidden sm:table-cell', late && 'font-semibold text-amber')}>{d.expectedCloseAt ? fmtDate(d.expectedCloseAt) : <span className="text-ink-faint">&mdash;</span>}</td>
                        <td><span className={d.status === 'WON' ? 'pill-green' : d.status === 'LOST' ? 'pill-danger' : 'pill-muted'}>{OPP_STATUS[d.status]}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
      </div>
    </div>
  );
}
