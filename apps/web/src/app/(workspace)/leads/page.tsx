'use client';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Bookmark, Download, Plus, Search, Tag, Upload, UserRound, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LeadForm } from '@/components/forms';
import { ImportLeads } from '@/components/import-leads';
import { Avatar, ColorDot, Dropdown, EmptyState, ErrorState, Field, LabelChip, Modal, PageHeader, Pagination, Skeleton, Spinner, Tabs, cx, useUi } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, money, relTime } from '@/lib/format';
import { Lead, useChanged, useRefs } from '@/lib/refs';

type View = 'all' | 'mine' | 'unassigned' | 'archived';
type Filters = { q: string; stageId: string; sourceId: string; ownerId: string; labelId: string; status: string };
const noFilters: Filters = { q: '', stageId: '', sourceId: '', ownerId: '', labelId: '', status: '' };
const COLUMNS: { key: string; label: string; sort?: string; className?: string }[] = [
  { key: 'name', label: 'Lead', sort: 'name' },
  { key: 'stage', label: 'Stage' },
  { key: 'owner', label: 'Owner', className: 'hidden md:table-cell' },
  { key: 'source', label: 'Source', className: 'hidden lg:table-cell' },
  { key: 'value', label: 'Value', sort: 'dealValue', className: 'hidden lg:table-cell text-right' },
  { key: 'activity', label: 'Last activity', sort: 'lastActivityAt', className: 'hidden xl:table-cell' },
  { key: 'created', label: 'Created', sort: 'createdAt', className: 'hidden sm:table-cell' },
];

type SavedView = { id: string; name: string; filters: Record<string, string>; shared: boolean; mine: boolean };

/** Named filter sets. A view is private unless its creator shares it with the workspace. */
function SavedViews({ current, canSave, onApply }: { current: Record<string, string>; canSave: boolean; onApply: (f: Record<string, string>) => void }) {
  const { toast } = useUi();
  const views = useApi<SavedView[]>('/saved-filters');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const filters = Object.fromEntries(Object.entries(current).filter(([, v]) => v));
      await api('/saved-filters', { body: { name, shared, filters } });
      toast('View saved');
      setSaving(false);
      setName('');
      setShared(false);
      views.reload();
    } catch (err) { setError((err as Error).message); }
  }
  async function remove(v: SavedView) {
    try { await api(`/saved-filters/${v.id}`, { method: 'DELETE' }); toast('View deleted'); views.reload(); } catch (err) { toast((err as Error).message, 'error'); }
  }

  return (
    <>
      <Dropdown align="left" className="w-72" trigger={() => <button className="btn-ghost btn-sm ml-auto"><Bookmark className="h-3.5 w-3.5" />Views{views.data?.length ? ` (${views.data.length})` : ''}</button>}>
        {(close) => (
          <>
            <div className="max-h-64 overflow-y-auto">
              {!views.data?.length && <p className="px-3 py-2 text-ink-muted">No saved views yet. Set some filters, then save them here.</p>}
              {views.data?.map((v) => (
                <div key={v.id} className="flex items-center">
                  <button className="menu-item min-w-0 flex-1" onClick={() => { close(); onApply(v.filters); }}>
                    <span className="truncate">{v.name}</span>{v.shared && <span className="pill-muted">Shared</span>}
                  </button>
                  {v.mine && <button className="btn-icon" onClick={() => remove(v)} aria-label={`Delete view ${v.name}`}><X className="h-3.5 w-3.5" /></button>}
                </div>
              ))}
            </div>
            <div className="mt-1 border-t border-ink/10 pt-1">
              <button className="menu-item font-semibold" disabled={!canSave} onClick={() => { close(); setSaving(true); }}><Plus className="h-4 w-4" />Save current filters as a view</button>
            </div>
          </>
        )}
      </Dropdown>
      <Modal open={saving} onClose={() => setSaving(false)} title="Save view"
        footer={<><button className="btn-ghost" onClick={() => setSaving(false)}>Cancel</button><button className="btn-primary" disabled={!name.trim()} onClick={save}>Save view</button></>}>
        <form className="space-y-3.5" onSubmit={save}>
          {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger" role="alert">{error}</p>}
          <Field label="View name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} placeholder="Hot Facebook leads" /></Field>
          <label className="flex cursor-pointer items-center gap-2.5"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /><span>Share with everyone in this workspace</span></label>
        </form>
      </Modal>
    </>
  );
}

export default function LeadsPage() {
  const { me, can } = useAuth();
  const { pipelines, sources, labels, members, reload: reloadRefs } = useRefs();
  const { toast, confirm } = useUi();
  const [view, setView] = useState<View>('all');
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ by: 'createdAt', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [leadForm, setLeadForm] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Deep links such as /leads?ownerId=me or /leads?q=asha set the initial view.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const f = { ...noFilters };
    (Object.keys(noFilters) as (keyof Filters)[]).forEach((k) => { if (p.get(k)) f[k] = p.get(k)!; });
    if (f.ownerId === 'me') { setView('mine'); f.ownerId = ''; }
    setFilters(f);
    setSearch(f.q);
    setReady(true);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() })), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [filters, view, sort]);

  const query = useMemo(() => ({
    ...filters,
    ownerId: view === 'mine' ? 'me' : view === 'unassigned' ? 'unassigned' : filters.ownerId,
    archived: view === 'archived' ? 'true' : 'false',
    sort: sort.by,
    dir: sort.dir,
  }), [filters, view, sort]);
  const list = useApi<{ items: Lead[]; total: number; page: number; pageSize: number }>(ready ? `/leads${qs({ ...query, page, pageSize: 25 })}` : null);
  const reload = useCallback(() => { list.reload(); }, [list]);
  useChanged(reload);

  const stages = pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name })));
  const items = list.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((l) => selected.has(l.id));
  const activeFilters = (Object.keys(noFilters) as (keyof Filters)[]).filter((k) => k !== 'q' && filters[k]).length;
  const setFilter = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  async function bulk(action: string, value?: string | null, label?: string) {
    setBusy(true);
    try {
      const r = await api<{ updated: number; skipped: number }>('/leads/bulk', { body: { ids: [...selected], action, value } });
      toast(`${r.updated} lead${r.updated === 1 ? '' : 's'} ${label ?? 'updated'}${r.skipped ? `, ${r.skipped} skipped` : ''}`);
      setSelected(new Set());
      list.reload();
      reloadRefs();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    setBusy(true);
    try {
      const csv = await api<string>(`/leads/export${qs(query)}`, { text: true });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `leads-${new Date().toISOString().slice(0, 10)}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const sortBy = (key: string) => setSort((s) => ({ by: key, dir: s.by === key && s.dir === 'desc' ? 'asc' : 'desc' }));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const canBulk = can('leads.edit') || can('leads.assign') || can('leads.delete');

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle={list.data ? `${list.data.total.toLocaleString('en-IN')} ${view === 'archived' ? 'archived' : ''} lead${list.data.total === 1 ? '' : 's'}` : undefined}
        actions={
          <>
            {can('leads.export') && <button className="btn-ghost" onClick={exportCsv} disabled={busy || !list.data?.total}><Download className="h-4 w-4" />Export</button>}
            {can('leads.import') && <button className="btn-ghost" onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" />Import</button>}
            {can('leads.create') && <button className="btn-primary" onClick={() => setLeadForm(true)}><Plus className="h-4 w-4" />New lead</button>}
          </>
        }
      />

      <Tabs
        value={view}
        onChange={setView}
        tabs={[
          { value: 'all', label: 'All leads' },
          { value: 'mine', label: 'My leads' },
          ...(me?.role.scope !== 'OWN' ? [{ value: 'unassigned' as View, label: 'Unassigned' }] : []),
          ...(can('leads.delete') ? [{ value: 'archived' as View, label: 'Archived' }] : []),
        ]}
      />

      <div className="my-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input className="input pl-9" placeholder="Filter this list…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter leads" />
        </div>
        <select className="input w-auto" value={filters.stageId} onChange={setFilter('stageId')} aria-label="Stage">
          <option value="">All stages</option>
          {stages.map((s) => <option key={s.id} value={s.id}>{pipelines.length > 1 ? `${s.pipeline}: ` : ''}{s.name}</option>)}
        </select>
        <select className="input w-auto" value={filters.status} onChange={setFilter('status')} aria-label="Status">
          <option value="">Any status</option><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
        </select>
        <select className="input w-auto" value={filters.sourceId} onChange={setFilter('sourceId')} aria-label="Source">
          <option value="">All sources</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {view !== 'mine' && view !== 'unassigned' && me?.role.scope !== 'OWN' && (
          <select className="input w-auto" value={filters.ownerId} onChange={setFilter('ownerId')} aria-label="Owner">
            <option value="">All owners</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <select className="input w-auto" value={filters.labelId} onChange={setFilter('labelId')} aria-label="Label">
          <option value="">All labels</option>
          {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {(activeFilters > 0 || filters.q) && (
          <button className="btn-ghost btn-sm" onClick={() => { setFilters(noFilters); setSearch(''); }}><X className="h-3.5 w-3.5" />Clear</button>
        )}
        <SavedViews
          current={{ ...filters, view }}
          canSave={activeFilters > 0 || !!filters.q || view !== 'all'}
          onApply={(v) => {
            const f = { ...noFilters };
            (Object.keys(noFilters) as (keyof Filters)[]).forEach((k) => { if (v[k]) f[k] = v[k]; });
            setFilters(f);
            setSearch(f.q);
            setView((['all', 'mine', 'unassigned', 'archived'] as View[]).includes(v.view as View) ? (v.view as View) : 'all');
          }}
        />
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl bg-ink px-4 py-2.5 text-white">
          <span className="mr-1 font-semibold">{selected.size} selected</span>
          {busy && <Spinner />}
          {view !== 'archived' ? (
            <>
              {can('leads.assign') && (
                <Dropdown align="left" trigger={() => <button className="btn-on-ink btn-sm"><UserRound className="h-3.5 w-3.5" />Assign</button>}>
                  {(close) => (
                    <div className="max-h-64 overflow-y-auto text-ink">
                      <button className="menu-item" onClick={() => { close(); bulk('assign', null, 'unassigned'); }}>Unassigned</button>
                      {members.filter((m) => m.status === 'ACTIVE').map((m) => <button key={m.id} className="menu-item" onClick={() => { close(); bulk('assign', m.id, `assigned to ${m.name}`); }}><Avatar name={m.name} size={22} />{m.name}</button>)}
                    </div>
                  )}
                </Dropdown>
              )}
              {can('leads.edit') && (
                <>
                  <Dropdown align="left" trigger={() => <button className="btn-on-ink btn-sm">Move stage</button>}>
                    {(close) => <div className="max-h-64 overflow-y-auto text-ink">{stages.map((s) => <button key={s.id} className="menu-item" onClick={() => { close(); bulk('stage', s.id, `moved to ${s.name}`); }}><ColorDot color={s.color} />{s.name}</button>)}</div>}
                  </Dropdown>
                  <Dropdown align="left" trigger={() => <button className="btn-on-ink btn-sm"><Tag className="h-3.5 w-3.5" />Label</button>}>
                    {(close) => (
                      <div className="max-h-64 overflow-y-auto text-ink">
                        {labels.map((l) => (
                          <div key={l.id} className="flex items-center gap-1 px-1">
                            <span className="flex flex-1 items-center gap-2 px-2 py-2"><ColorDot color={l.color} />{l.name}</span>
                            <button className="btn-ghost btn-sm" onClick={() => { close(); bulk('addLabel', l.id, `labelled ${l.name}`); }}>Add</button>
                            <button className="btn-ghost btn-sm" onClick={() => { close(); bulk('removeLabel', l.id, `unlabelled`); }}>Remove</button>
                          </div>
                        ))}
                        {!labels.length && <p className="px-3 py-2 text-ink-muted">No labels yet. Create them in Settings.</p>}
                      </div>
                    )}
                  </Dropdown>
                </>
              )}
              {can('leads.delete') && (
                <button className="btn-on-ink btn-sm" onClick={async () => { if (await confirm({ title: `Archive ${selected.size} lead${selected.size === 1 ? '' : 's'}?`, text: 'Archived leads are hidden from lists and reports. You can restore them from the Archived tab.', confirmLabel: 'Archive' })) bulk('archive', null, 'archived'); }}>
                  <Archive className="h-3.5 w-3.5" />Archive
                </button>
              )}
            </>
          ) : (
            <button className="btn-on-ink btn-sm" onClick={() => bulk('restore', null, 'restored')}><ArchiveRestore className="h-3.5 w-3.5" />Restore</button>
          )}
          <button className="btn-icon ml-auto text-white/70 hover:bg-white/10 hover:text-white" onClick={() => setSelected(new Set())} aria-label="Clear selection"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="card overflow-hidden">
        {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} />
          : !list.data ? <Skeleton rows={8} />
          : !items.length ? (
            activeFilters || filters.q || view !== 'all'
              ? <EmptyState icon={Search} title="No leads match" text="Try a different search or clear the filters." />
              : <EmptyState icon={Users} title="No leads yet" text="Add your first lead or import a CSV file to get started." action={can('leads.create') ? <button className="btn-primary" onClick={() => setLeadForm(true)}><Plus className="h-4 w-4" />New lead</button> : undefined} />
          ) : (
            <div className={cx('overflow-x-auto', list.loading && 'opacity-60')}>
              <table className="table">
                <thead>
                  <tr>
                    {canBulk && <th className="w-10 pl-4"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((l) => l.id)))} aria-label="Select all on this page" /></th>}
                    {COLUMNS.map((c) => (
                      <th key={c.key} className={c.className} aria-sort={c.sort && sort.by === c.sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                        {c.sort ? (
                          <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => sortBy(c.sort!)}>
                            {c.label}
                            {sort.by === c.sort && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                          </button>
                        ) : c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((l) => (
                    <tr key={l.id} className={selected.has(l.id) ? 'bg-cream/70' : undefined}>
                      {canBulk && <td className="pl-4"><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.name}`} /></td>}
                      <td className="max-w-[280px]">
                        <Link href={`/leads/${l.id}`} className="block truncate font-semibold hover:underline">{l.name}</Link>
                        <span className="block truncate text-[12.5px] text-ink-muted">{[l.phone, l.company || l.email].filter(Boolean).join(' · ') || 'No contact details'}</span>
                        {l.labels.length > 0 && <span className="mt-1 flex flex-wrap gap-1">{l.labels.map((x) => <LabelChip key={x.id} {...x} />)}</span>}
                      </td>
                      <td><span className="pill" style={{ background: `${l.stage.color}1A`, color: l.stage.color }}>{l.stage.name}</span></td>
                      <td className="hidden md:table-cell">{l.owner ? <span className="flex items-center gap-2"><Avatar name={l.owner.name} size={22} /><span className="truncate">{l.owner.name}</span></span> : <span className="text-ink-faint">Unassigned</span>}</td>
                      <td className="hidden lg:table-cell">{l.source?.name ?? <span className="text-ink-faint">&mdash;</span>}</td>
                      <td className="hidden text-right lg:table-cell">{money(l.dealValue, me?.organisation.currency)}</td>
                      <td className="hidden text-ink-muted xl:table-cell">{relTime(l.lastActivityAt)}</td>
                      <td className="hidden text-ink-muted sm:table-cell">{fmtDate(l.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
      </div>

      <LeadForm open={leadForm} onClose={() => setLeadForm(false)} />
      <ImportLeads open={importOpen} onClose={() => setImportOpen(false)} onDone={() => { list.reload(); reloadRefs(); }} />
    </div>
  );
}
