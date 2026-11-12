'use client';
import { Building2, Search, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EmptyState, ErrorState, PageHeader, Pagination, Skeleton, Tabs, cx, useUi } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, money, relTime } from '@/lib/format';

type Overview = { organisations: number; suspended: number; users: number; leads: number; activeUsers24h: number; newOrganisations24h: number; last24h: Record<string, number>; undispatchedEvents: number; byPlan: { plan: string; organisations: number }[] };
type Org = { id: string; name: string; slug: string; status: 'ACTIVE' | 'SUSPENDED'; createdAt: string; owner: { name: string; email: string } | null; members: number; leads: number; plan: string | null; subscription: string | null; lastActiveAt: string | null };
type Plan = { id: string; key: string; name: string; priceMonthly: number; currency: string; limits: Record<string, number>; isDefault: boolean; active: boolean; position: number; organisations: number };
const LIMIT_LABELS: Record<string, string> = { users: 'Users', leads: 'Leads', automations: 'Automations', storageMb: 'Storage (MB)', webhooks: 'Webhooks' };

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return <div className="card card-pad"><span className="text-[13px] text-ink-muted">{label}</span><p className={cx('mt-1.5 font-display text-[26px] font-extrabold leading-none tracking-tight', warn && 'text-danger')}>{typeof value === 'number' ? value.toLocaleString('en-IN') : value}</p></div>;
}

/** Platform administration: every workspace, its plan and health. Visible to users flagged as super-admins. */
export default function AdminPage() {
  const { me } = useAuth();
  const [tab, setTab] = useState<'organisations' | 'plans'>('organisations');
  if (!me) return null;
  if (!me.user.isSuperAdmin) return <div className="card"><EmptyState icon={ShieldCheck} title="Platform administration" text="This area is for platform administrators. Add your email to SUPER_ADMIN_EMAILS on the API server and sign in again." /></div>;
  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader title="Platform admin" subtitle="Every workspace on this installation" />
      <OverviewStats />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'organisations', label: 'Workspaces' }, { value: 'plans', label: 'Plans' }]} />
      {tab === 'organisations' ? <Organisations /> : <Plans />}
    </div>
  );
}

function OverviewStats() {
  const ov = useApi<Overview>('/admin/overview');
  if (ov.error) return <div className="card mb-5"><ErrorState message={ov.error.message} onRetry={ov.reload} /></div>;
  if (!ov.data) return <div className="card mb-5"><Skeleton rows={2} /></div>;
  const d = ov.data;
  const failures = Object.values(d.last24h).reduce((a, b) => a + b, 0);
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
      <Stat label="Workspaces" value={d.organisations} />
      <Stat label="Suspended" value={d.suspended} warn={d.suspended > 0} />
      <Stat label="Users" value={d.users} />
      <Stat label="Leads" value={d.leads} />
      <Stat label="Active users (24 h)" value={d.activeUsers24h} />
      <Stat label="Failures (24 h)" value={failures} warn={failures > 0} />
      {failures > 0 && <p className="col-span-full text-[13px] text-ink-muted">Webhooks {d.last24h.failedWebhooks} · integration events {d.last24h.failedIntegrationEvents} · emails {d.last24h.failedEmails} · automation runs {d.last24h.failedAutomationRuns} · undispatched events {d.undispatchedEvents}</p>}
    </div>
  );
}

function Organisations() {
  const { toast, confirm } = useUi();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => setPage(1), [q, status]);
  const list = useApi<{ items: Org[]; total: number; page: number; pageSize: number }>(`/admin/organisations${qs({ q, status, page, pageSize: 25 })}`);
  const plans = useApi<Plan[]>('/admin/plans');
  const [busy, setBusy] = useState<string | null>(null);

  async function patch(o: Org, body: Record<string, unknown>, message: string) {
    setBusy(o.id);
    try { await api(`/admin/organisations/${o.id}`, { method: 'PATCH', body }); toast(message); list.reload(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  }

  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" /><input className="input pl-9" placeholder="Workspace, slug or owner email…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search workspaces" /></div>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Any status</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select>
      </div>
      <div className="card overflow-hidden">
        {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} /> : !list.data ? <Skeleton rows={6} /> : !list.data.items.length ? <EmptyState icon={Building2} title="No workspaces match" /> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th className="pl-5">Workspace</th><th>Owner</th><th>Plan</th><th className="text-right">Users</th><th className="text-right">Leads</th><th>Last active</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {list.data.items.map((o) => (
                  <tr key={o.id} className={o.status === 'SUSPENDED' ? 'bg-danger-soft/40' : undefined}>
                    <td className="pl-5"><span className="font-semibold">{o.name}</span>{o.status === 'SUSPENDED' && <span className="pill-danger ml-2">Suspended</span>}<span className="block text-[12.5px] text-ink-muted">{o.slug}</span></td>
                    <td>{o.owner ? <>{o.owner.name}<span className="block text-[12.5px] text-ink-muted">{o.owner.email}</span></> : <span className="text-ink-faint">—</span>}</td>
                    <td>
                      <select className="input w-auto py-1 text-[13px]" value={plans.data?.find((p) => p.name === o.plan)?.id ?? ''} disabled={busy === o.id || !plans.data} onChange={(e) => patch(o, { planId: e.target.value }, `${o.name} moved to ${plans.data?.find((p) => p.id === e.target.value)?.name}`)} aria-label={`Plan for ${o.name}`}>
                        {plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{!p.active ? ' (retired)' : ''}</option>)}
                      </select>
                    </td>
                    <td className="text-right">{o.members}</td><td className="text-right">{o.leads.toLocaleString('en-IN')}</td>
                    <td className="text-ink-muted">{o.lastActiveAt ? relTime(o.lastActiveAt) : 'never'}</td><td className="text-ink-muted">{fmtDate(o.createdAt)}</td>
                    <td className="pr-4 text-right">
                      {o.status === 'ACTIVE'
                        ? <button className="btn-ghost btn-sm" disabled={busy === o.id} onClick={async () => { if (await confirm({ title: `Suspend ${o.name}?`, text: 'Everyone in the workspace is signed out immediately and cannot sign in until it is reactivated. Data is kept.', confirmLabel: 'Suspend', danger: true })) patch(o, { status: 'SUSPENDED' }, `${o.name} suspended`); }}>Suspend</button>
                        : <button className="btn-ink btn-sm" disabled={busy === o.id} onClick={() => patch(o, { status: 'ACTIVE' }, `${o.name} reactivated`)}>Reactivate</button>}
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

function Plans() {
  const { toast } = useUi();
  const plans = useApi<Plan[]>('/admin/plans');
  const blank = { id: '', key: '', name: '', priceMonthly: '0', currency: 'INR', limits: { users: '5', leads: '5000', automations: '5', storageMb: '1000', webhooks: '2' } as Record<string, string>, isDefault: false, active: true };
  const [f, setF] = useState<typeof blank | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!f) return;
    setBusy(true);
    try {
      const body = { key: f.key, name: f.name, priceMonthly: Number(f.priceMonthly), currency: f.currency, limits: Object.fromEntries(Object.entries(f.limits).map(([k, v]) => [k, Number(v)])), isDefault: f.isDefault, active: f.active };
      await api(f.id ? `/admin/plans/${f.id}` : '/admin/plans', { method: f.id ? 'PATCH' : 'POST', body: f.id ? { ...body, key: undefined } : body });
      toast(f.id ? 'Plan saved' : 'Plan created');
      setF(null);
      plans.reload();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  }
  return (
    <div className="mt-4 space-y-4">
      <div className="card overflow-hidden">
        {plans.error ? <ErrorState message={plans.error.message} onRetry={plans.reload} /> : !plans.data ? <Skeleton rows={3} /> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th className="pl-5">Plan</th><th className="text-right">Price / month</th>{Object.values(LIMIT_LABELS).map((l) => <th key={l} className="text-right">{l}</th>)}<th className="text-right">Workspaces</th><th></th></tr></thead>
              <tbody>
                {plans.data.map((p) => (
                  <tr key={p.id} className={!p.active ? 'text-ink-faint' : undefined}>
                    <td className="pl-5"><span className="font-semibold">{p.name}</span>{p.isDefault && <span className="pill-green ml-2">Default for new workspaces</span>}{!p.active && <span className="pill-muted ml-2">Retired</span>}<span className="block text-[12.5px] text-ink-muted">{p.key}</span></td>
                    <td className="text-right">{p.priceMonthly ? money(p.priceMonthly, p.currency) : 'Free'}</td>
                    {Object.keys(LIMIT_LABELS).map((k) => <td key={k} className="text-right">{(p.limits[k] ?? 0).toLocaleString('en-IN')}</td>)}
                    <td className="text-right">{p.organisations}</td>
                    <td className="pr-4 text-right"><button className="btn-ghost btn-sm" onClick={() => setF({ id: p.id, key: p.key, name: p.name, priceMonthly: String(p.priceMonthly), currency: p.currency, limits: Object.fromEntries(Object.keys(LIMIT_LABELS).map((k) => [k, String(p.limits[k] ?? 0)])), isDefault: p.isDefault, active: p.active })}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {f ? (
        <form className="card card-pad grid gap-3 sm:grid-cols-3" onSubmit={save}>
          <label className="block"><span className="label">Key</span><input className="input" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} disabled={!!f.id} pattern="[a-z0-9_-]{2,30}" required /></label>
          <label className="block"><span className="label">Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label className="block"><span className="label">Price per month ({f.currency})</span><input className="input" type="number" min={0} step="any" value={f.priceMonthly} onChange={(e) => setF({ ...f, priceMonthly: e.target.value })} /></label>
          {Object.entries(LIMIT_LABELS).map(([k, l]) => <label key={k} className="block"><span className="label">{l}</span><input className="input" type="number" min={0} value={f.limits[k]} onChange={(e) => setF({ ...f, limits: { ...f.limits, [k]: e.target.value } })} required /></label>)}
          <label className="flex cursor-pointer items-center gap-2.5"><input type="checkbox" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} /><span>Default for new workspaces</span></label>
          <label className="flex cursor-pointer items-center gap-2.5"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /><span>Active (offered to workspaces)</span></label>
          <div className="flex gap-2 sm:col-span-3"><button className="btn-ink" disabled={busy}>{f.id ? 'Save plan' : 'Create plan'}</button><button type="button" className="btn-ghost" onClick={() => setF(null)}>Cancel</button></div>
        </form>
      ) : <div><button className="btn-ink" onClick={() => setF(blank)}>New plan</button> <Link href="/settings" className="btn-ghost ml-2">Back to settings</Link></div>}
      <p className="text-[13px] text-ink-muted">Prices are shown to workspaces for information. Self-service billing needs a payment gateway; until then plan changes are made here.</p>
    </div>
  );
}
