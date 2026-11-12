'use client';
import { ArrowDown, ArrowUp, Banknote, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, ErrorState, PageHeader, Pagination, Skeleton, cx, useUi } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, money } from '@/lib/format';
import { PAYMENT_METHODS, PAYMENT_STATUS, Payment, useChanged, useRefs } from '@/lib/refs';

type Totals = Record<'paid' | 'pending' | 'failed' | 'refunded' | 'overdue', { count: number; amount: number }>;
type List = { items: Payment[]; total: number; page: number; pageSize: number; totals: Totals };
const COLS: { key: string; label: string; sort?: string; className?: string }[] = [
  { key: 'lead', label: 'Lead' },
  { key: 'amount', label: 'Amount', sort: 'amount', className: 'text-right' },
  { key: 'status', label: 'Status' },
  { key: 'method', label: 'Method', className: 'hidden md:table-cell' },
  { key: 'ref', label: 'Reference', className: 'hidden lg:table-cell' },
  { key: 'when', label: 'Received / due', sort: 'paidAt', className: 'hidden sm:table-cell' },
  { key: 'deal', label: 'Deal', className: 'hidden xl:table-cell' },
  { key: 'actions', label: '' },
];

function Stat({ label, value, sub, active, onClick }: { label: string; value: string; sub?: string; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx('card card-pad text-left transition hover:border-ink/20', active && 'border-ink')} aria-pressed={active}>
      <span className="text-[13px] text-ink-muted">{label}</span>
      <p className="mt-1.5 font-display text-[24px] font-extrabold leading-none tracking-tight">{value}</p>
      {sub && <p className="mt-2 text-[13px] text-ink-muted">{sub}</p>}
    </button>
  );
}

function PaymentStatusPill({ p }: { p: Payment }) {
  const overdue = p.status === 'PENDING' && p.dueAt && new Date(p.dueAt) < new Date();
  const cls = p.status === 'PAID' ? 'pill-green' : p.status === 'REFUNDED' ? 'pill-muted' : p.status === 'FAILED' ? 'pill-danger' : overdue ? 'pill-amber' : 'pill-muted';
  return <span className={cls}>{overdue ? 'Overdue' : PAYMENT_STATUS[p.status]}</span>;
}

export default function PaymentsPage() {
  const { me, can } = useAuth();
  const { members, connected } = useRefs();
  const { toast, confirm } = useUi();
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ by: 'createdAt', dir: 'desc' });
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => setPage(1), [status, method, ownerId, from, to, q, sort]);
  const params = useMemo(() => ({
    status, method, ownerId, q, sort: sort.by, dir: sort.dir, page, pageSize: 25,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : '', to: to ? new Date(`${to}T23:59:59.999`).toISOString() : '',
  }), [status, method, ownerId, from, to, q, sort, page]);
  const list = useApi<List>(`/payments${qs(params)}`);
  useChanged(list.reload);
  const cur = me?.organisation.currency;
  const t = list.data?.totals;
  const sortBy = (key: string) => setSort((s) => ({ by: key, dir: s.by === key && s.dir === 'desc' ? 'asc' : 'desc' }));

  async function createLink(p: Payment) {
    try { const r = await api<Payment>(`/payments/${p.id}/link`, { body: {} }); toast('Payment link created'); if (r.linkUrl) { try { await navigator.clipboard.writeText(r.linkUrl); toast('Link copied to clipboard'); } catch { /* clipboard unavailable */ } } list.reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }
  async function setPaymentStatus(p: Payment, next: 'PAID' | 'REFUNDED') {
    if (next === 'REFUNDED' && !(await confirm({ title: `Refund ${money(p.amount, cur)}?`, text: `The payment from ${p.lead?.name} is marked as refunded. The record is kept.`, confirmLabel: 'Mark refunded', danger: true }))) return;
    try { await api(`/payments/${p.id}`, { method: 'PATCH', body: { status: next } }); toast(next === 'PAID' ? 'Payment marked as received' : 'Payment marked as refunded'); list.reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader title="Payments" subtitle={t ? `${money(t.paid.amount, cur)} received · ${money(t.pending.amount, cur)} expected` : undefined} />
      {t && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Received" value={money(t.paid.amount, cur)} sub={`${t.paid.count} payment${t.paid.count === 1 ? '' : 's'}`} active={status === 'PAID'} onClick={() => setStatus(status === 'PAID' ? '' : 'PAID')} />
          <Stat label="Expected" value={money(t.pending.amount, cur)} sub={`${t.pending.count} pending`} active={status === 'PENDING'} onClick={() => setStatus(status === 'PENDING' ? '' : 'PENDING')} />
          <Stat label="Overdue" value={money(t.overdue.amount, cur)} sub={`${t.overdue.count} past due date`} active={status === 'OVERDUE'} onClick={() => setStatus(status === 'OVERDUE' ? '' : 'OVERDUE')} />
          <Stat label="Refunded" value={money(t.refunded.amount, cur)} sub={`${t.refunded.count} refunded · ${t.failed.count} failed`} active={status === 'REFUNDED'} onClick={() => setStatus(status === 'REFUNDED' ? '' : 'REFUNDED')} />
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input className="input pl-9" placeholder="Lead, reference or note…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search payments" />
        </div>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>{Object.entries(PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}<option value="OVERDUE">Overdue</option>
        </select>
        <select className="input w-auto" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
          <option value="">Any method</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {me?.role.scope !== 'OWN' && (
          <select className="input w-auto" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Lead owner">
            <option value="">All lead owners</option><option value="me">My leads</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <input type="date" className="input w-auto" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        <span className="text-ink-muted">to</span>
        <input type="date" className="input w-auto" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
      </div>

      <div className="card overflow-hidden">
        {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} />
          : !list.data ? <Skeleton rows={6} />
          : !list.data.items.length ? <EmptyState icon={Banknote} title={status || method || q || from || to ? 'No payments match' : 'No payments yet'} text="Record a payment from a lead's page, under the Payments tab." />
          : (
            <div className={cx('overflow-x-auto', list.loading && 'opacity-60')}>
              <table className="table">
                <thead><tr>{COLS.map((c, i) => (
                  <th key={c.key} className={cx(c.className, i === 0 && 'pl-5')} aria-sort={c.sort && sort.by === c.sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sort ? <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => sortBy(c.sort!)}>{c.label}{sort.by === c.sort && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</button> : c.label}
                  </th>))}</tr></thead>
                <tbody>
                  {list.data.items.map((p) => (
                    <tr key={p.id}>
                      <td className="pl-5"><Link href={`/leads/${p.leadId}?tab=payments`} className="font-semibold hover:underline">{p.lead?.name}</Link><span className="block text-[12.5px] text-ink-muted">{p.lead?.phone ?? ''}</span></td>
                      <td className="text-right font-medium">{money(p.amount, p.currency)}</td>
                      <td><PaymentStatusPill p={p} /></td>
                      <td className="hidden md:table-cell">{PAYMENT_METHODS[p.method]}</td>
                      <td className="hidden lg:table-cell">{p.reference ?? <span className="text-ink-faint">&mdash;</span>}</td>
                      <td className="hidden text-ink-muted sm:table-cell">{p.status === 'PAID' || p.status === 'REFUNDED' ? fmtDate(p.paidAt) : p.dueAt ? `Due ${fmtDate(p.dueAt)}` : '—'}</td>
                      <td className="hidden xl:table-cell">{p.opportunity?.name ?? <span className="text-ink-faint">&mdash;</span>}</td>
                      <td className="text-right">
                        {p.linkUrl && <a className="btn-ghost btn-sm mr-1" href={p.linkUrl} target="_blank" rel="noopener noreferrer">Link</a>}
                        {can('payments.manage') && p.status === 'PENDING' && connected.razorpay && !p.linkUrl && <button className="btn-ghost btn-sm mr-1" onClick={() => createLink(p)}>Payment link</button>}
                        {can('payments.manage') && p.status === 'PENDING' && <button className="btn-ghost btn-sm" onClick={() => setPaymentStatus(p, 'PAID')}>Mark received</button>}
                        {can('payments.manage') && p.status === 'PAID' && <button className="btn-ghost btn-sm" onClick={() => setPaymentStatus(p, 'REFUNDED')}>Refund</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
      </div>
    </div>
  );
}
