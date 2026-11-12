'use client';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Integrations } from '@/components/integrations';
import { ColorDot, ErrorState, Field, PageHeader, Skeleton, Spinner, Tabs, useUi } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, relTime } from '@/lib/format';
import { CustomField, FIELD_TYPES, Stage, useRefs } from '@/lib/refs';

type Tab = 'account' | 'organisation' | 'pipeline' | 'sources' | 'labels' | 'fields' | 'lists' | 'rules' | 'integrations';
const COLORS = ['#2563EB', '#7C3AED', '#0E7490', '#168A4C', '#B54708', '#EA5A2A', '#B42318', '#78716C'];

export default function SettingsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('account');
  const tabs: { value: Tab; label: string }[] = [
    { value: 'account', label: 'My account' },
    ...(can('settings.manage') ? [{ value: 'organisation' as Tab, label: 'Organisation' }] : []),
    ...(can('pipeline.manage') ? [{ value: 'pipeline' as Tab, label: 'Pipeline stages' }, { value: 'sources' as Tab, label: 'Lead sources' }, { value: 'labels' as Tab, label: 'Labels' }, { value: 'fields' as Tab, label: 'Lead fields' }] : []),
    ...(can('leads.edit') ? [{ value: 'lists' as Tab, label: 'Lead lists' }] : []),
    ...(can('settings.manage') ? [{ value: 'rules' as Tab, label: 'Assignment rules' }, { value: 'integrations' as Tab, label: 'Integrations' }] : []),
  ];
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null;
    if (t && tabs.some((x) => x.value === t)) setTab(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mx-auto max-w-[860px]">
      <PageHeader title="Settings" />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      <div className="mt-5 space-y-5">
        {tab === 'account' && <Account />}
        {tab === 'organisation' && <Organisation />}
        {tab === 'pipeline' && <Stages />}
        {tab === 'sources' && <NamedList kind="sources" title="Lead sources" hint="Where your leads come from. Deleting a source keeps its leads and clears their source." />}
        {tab === 'labels' && <NamedList kind="labels" title="Labels" hint="Colour-coded tags for segmenting leads." withColor />}
        {tab === 'fields' && <LeadFields />}
        {tab === 'lists' && <LeadLists />}
        {tab === 'rules' && <AssignmentRules />}
        {tab === 'integrations' && <Integrations />}
      </div>
    </div>
  );
}

function useSave() {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); return true; } catch (e) { toast((e as Error).message, 'error'); return false; } finally { setBusy(false); }
  };
  return { busy, run };
}

function Account() {
  const { me, reloadMe } = useAuth();
  const { busy, run } = useSave();
  const pw = useSave();
  const [name, setName] = useState(me?.user.name ?? '');
  const [phone, setPhone] = useState(me?.user.phone ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const sessions = useApi<{ id: string; userAgent: string | null; ip: string | null; lastUsedAt: string; createdAt: string; current: boolean }[]>('/auth/sessions');
  const { toast } = useUi();

  return (
    <>
      <form className="card card-pad" onSubmit={(e) => { e.preventDefault(); run(() => api('/auth/profile', { body: { name, phone: phone || null } }).then(reloadMe), 'Profile saved'); }}>
        <h2 className="card-title mb-4">Profile</h2>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
          <Field label="Phone"><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field>
          <Field label="Email" hint="Contact an administrator to change your login email"><input className="input" value={me?.user.email ?? ''} disabled /></Field>
          <Field label="Role"><input className="input" value={me?.role.name ?? ''} disabled /></Field>
        </div>
        <button className="btn-ink mt-4" disabled={busy}>{busy && <Spinner />}Save profile</button>
      </form>

      <form className="card card-pad" onSubmit={async (e) => { e.preventDefault(); if (await pw.run(() => api('/auth/change-password', { body: { currentPassword: current, newPassword: next } }), 'Password changed. Other devices were signed out.')) { setCurrent(''); setNext(''); sessions.reload(); } }}>
        <h2 className="card-title mb-4">Password</h2>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Current password"><input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required /></Field>
          <Field label="New password" hint="At least 10 characters, with a letter and a number"><input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={10} /></Field>
        </div>
        <button className="btn-ink mt-4" disabled={pw.busy}>{pw.busy && <Spinner />}Change password</button>
      </form>

      <section className="card">
        <div className="card-pad pb-2"><h2 className="card-title">Signed-in devices</h2><p className="text-ink-muted">Sign out a device you no longer use or do not recognise.</p></div>
        {sessions.error ? <ErrorState message={sessions.error.message} onRetry={sessions.reload} /> : !sessions.data ? <Skeleton rows={2} /> : (
          <ul className="divide-y divide-ink/5 border-t border-ink/10">
            {sessions.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{describeAgent(s.userAgent)}{s.current && <span className="pill-green ml-2">This device</span>}</p>
                  <p className="text-[13px] text-ink-muted">Last active {relTime(s.lastUsedAt)} · signed in {fmtDateTime(s.createdAt)}{s.ip ? ` · ${s.ip}` : ''}</p>
                </div>
                {!s.current && <button className="btn-ghost btn-sm" onClick={async () => { try { await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }); toast('Device signed out'); sessions.reload(); } catch (e) { toast((e as Error).message, 'error'); } }}>Sign out</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function Organisation() {
  const { reloadMe } = useAuth();
  const org = useApi<{ name: string; timezone: string; currency: string; dateFormat: string }>('/organisation');
  const { busy, run } = useSave();
  const [f, setF] = useState({ name: '', timezone: '', currency: '', dateFormat: '' });
  useEffect(() => {
    if (org.data) setF({ name: org.data.name, timezone: org.data.timezone, currency: org.data.currency, dateFormat: org.data.dateFormat });
  }, [org.data]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  if (org.error) return <div className="card"><ErrorState message={org.error.message} onRetry={org.reload} /></div>;
  if (!org.data) return <div className="card"><Skeleton rows={4} /></div>;
  return (
    <form className="card card-pad" onSubmit={(e) => { e.preventDefault(); run(() => api('/organisation', { method: 'PATCH', body: f }).then(reloadMe), 'Organisation saved'); }}>
      <h2 className="card-title mb-4">Organisation</h2>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Organisation name"><input className="input" value={f.name} onChange={set('name')} required minLength={2} /></Field>
        <Field label="Timezone">
          <select className="input" value={f.timezone} onChange={set('timezone')}>
            {[...new Set([f.timezone, 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'])].filter(Boolean).map((z) => <option key={z}>{z}</option>)}
          </select>
        </Field>
        <Field label="Currency">
          <select className="input" value={f.currency} onChange={set('currency')}>
            {['INR', 'USD', 'AED', 'EUR', 'GBP', 'SGD'].map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Date format">
          <select className="input" value={f.dateFormat} onChange={set('dateFormat')}>
            {['DD MMM YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
      </div>
      <button className="btn-ink mt-4" disabled={busy}>{busy && <Spinner />}Save organisation</button>
    </form>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <span className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
      {COLORS.map((c) => (
        <button type="button" key={c} role="radio" aria-checked={value === c} aria-label={c} onClick={() => onChange(c)} className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: c }}>
          {value === c && <Check className="h-3.5 w-3.5 text-white" />}
        </button>
      ))}
    </span>
  );
}

function Stages() {
  const { pipelines, reload, ready } = useRefs();
  const { confirm } = useUi();
  const { busy, run } = useSave();
  const [pipelineId, setPipelineId] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [editing, setEditing] = useState<{ id: string; name: string; color: string } | null>(null);
  const [newPipeline, setNewPipeline] = useState('');
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0];
  if (!ready || !pipeline) return <div className="card"><Skeleton rows={5} /></div>;

  const act = (fn: () => Promise<unknown>, ok: string) => run(() => fn().then(reload), ok);
  const moveStage = (s: Stage, dir: -1 | 1) => {
    const ids = pipeline.stages.map((x) => x.id);
    const i = ids.indexOf(s.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    act(() => api(`/pipelines/${pipeline.id}/stages/reorder`, { body: { stageIds: ids } }), 'Stage order saved');
  };

  return (
    <>
      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 card-pad pb-3">
          <div><h2 className="card-title">Stages</h2><p className="text-ink-muted">The steps a lead moves through. Won and Lost stages close a lead.</p></div>
          {pipelines.length > 1 && (
            <select className="input w-auto" value={pipeline.id} onChange={(e) => setPipelineId(e.target.value)} aria-label="Pipeline">
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' (default)' : ''}</option>)}
            </select>
          )}
        </div>
        <ul className="divide-y divide-ink/5 border-y border-ink/10">
          {pipeline.stages.map((s, i) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
              {editing?.id === s.id ? (
                <form className="flex flex-1 flex-wrap items-center gap-3" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api(`/stages/${s.id}`, { method: 'PATCH', body: { name: editing.name, color: editing.color } }), 'Stage saved')) setEditing(null); }}>
                  <input className="input max-w-[200px]" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus aria-label="Stage name" />
                  <ColorPicker value={editing.color} onChange={(c) => setEditing({ ...editing, color: c })} />
                  <button className="btn-ink btn-sm" disabled={busy}>Save</button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <ColorDot color={s.color} />
                  <span className="flex-1 font-medium">{s.name}{s.type !== 'OPEN' && <span className={s.type === 'WON' ? 'pill-green ml-2' : 'pill-danger ml-2'}>{s.type === 'WON' ? 'Closes as won' : 'Closes as lost'}</span>}</span>
                  <span className="text-[13px] text-ink-muted">{s.leads} lead{s.leads === 1 ? '' : 's'}</span>
                  <span className="flex">
                    <button className="btn-icon" disabled={i === 0 || busy} onClick={() => moveStage(s, -1)} aria-label={`Move ${s.name} up`}><ArrowUp className="h-4 w-4" /></button>
                    <button className="btn-icon" disabled={i === pipeline.stages.length - 1 || busy} onClick={() => moveStage(s, 1)} aria-label={`Move ${s.name} down`}><ArrowDown className="h-4 w-4" /></button>
                    <button className="btn-icon" onClick={() => setEditing({ id: s.id, name: s.name, color: s.color })} aria-label={`Edit ${s.name}`}><Pencil className="h-4 w-4" /></button>
                    <button className="btn-icon" disabled={busy} aria-label={`Delete ${s.name}`} onClick={async () => { if (await confirm({ title: `Delete stage ${s.name}?`, text: 'A stage can only be deleted when it has no leads.', confirmLabel: 'Delete', danger: true })) act(() => api(`/stages/${s.id}`, { method: 'DELETE' }), 'Stage deleted'); }}><Trash2 className="h-4 w-4" /></button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
        <form className="flex flex-wrap items-center gap-3 card-pad" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && (await act(() => api(`/pipelines/${pipeline.id}/stages`, { body: { name, color } }), 'Stage added'))) setName(''); }}>
          <input className="input max-w-[220px]" placeholder="New stage name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New stage name" maxLength={60} />
          <ColorPicker value={color} onChange={setColor} />
          <button className="btn-ink" disabled={busy || !name.trim()}><Plus className="h-4 w-4" />Add stage</button>
        </form>
      </section>

      <section className="card card-pad">
        <h2 className="card-title">Pipelines</h2>
        <p className="mb-3 text-ink-muted">Use separate pipelines for different sales processes, such as new business and renewals.</p>
        <ul className="mb-4 space-y-2">
          {pipelines.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{p.name}{p.isDefault && <span className="pill-muted ml-2">Default</span>}</span>
              {!p.isDefault && (
                <span className="flex gap-2">
                  <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api(`/pipelines/${p.id}`, { method: 'PATCH', body: { isDefault: true } }), 'Default pipeline changed')}>Make default</button>
                  <button className="btn-ghost btn-sm" disabled={busy} onClick={async () => { if (await confirm({ title: `Delete pipeline ${p.name}?`, text: 'A pipeline can only be deleted when it has no leads.', confirmLabel: 'Delete', danger: true })) act(() => api(`/pipelines/${p.id}`, { method: 'DELETE' }), 'Pipeline deleted'); }}>Delete</button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (newPipeline.trim() && (await act(() => api('/pipelines', { body: { name: newPipeline } }), 'Pipeline created'))) setNewPipeline(''); }}>
          <input className="input max-w-[260px]" placeholder="New pipeline name" value={newPipeline} onChange={(e) => setNewPipeline(e.target.value)} aria-label="New pipeline name" maxLength={60} />
          <button className="btn-ghost" disabled={busy || !newPipeline.trim()}><Plus className="h-4 w-4" />Add pipeline</button>
        </form>
      </section>
    </>
  );
}

function LeadFields() {
  const { fields, reload, ready } = useRefs();
  const { confirm } = useUi();
  const { busy, run } = useSave();
  const blank = { label: '', type: 'TEXT' as CustomField['type'], options: '', required: false };
  const [f, setF] = useState(blank);
  const [editing, setEditing] = useState<{ id: string; label: string; options: string; required: boolean; hasOptions: boolean } | null>(null);
  const act = (fn: () => Promise<unknown>, ok: string) => run(() => fn().then(reload), ok);
  const split = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const hasOptions = (t: string) => t === 'DROPDOWN' || t === 'MULTI_SELECT';
  const move = (i: number, dir: -1 | 1) => {
    const ids = fields.map((x) => x.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    act(() => api('/custom-fields/reorder', { body: { ids } }), 'Field order saved');
  };

  return (
    <section className="card">
      <div className="card-pad pb-3"><h2 className="card-title">Lead fields</h2><p className="text-ink-muted">Extra information to capture on every lead. These appear on the lead form, the lead page, imports and exports.</p></div>
      {!ready ? <Skeleton rows={4} /> : (
        <ul className="divide-y divide-ink/5 border-y border-ink/10">
          {fields.map((x, i) => (
            <li key={x.id} className="px-5 py-2.5">
              {editing?.id === x.id ? (
                <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api(`/custom-fields/${x.id}`, { method: 'PATCH', body: { label: editing.label, required: editing.required, ...(editing.hasOptions ? { options: split(editing.options) } : {}) } }), 'Field saved')) setEditing(null); }}>
                  <Field label="Field name"><input className="input" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} autoFocus maxLength={60} /></Field>
                  {editing.hasOptions && <Field label="Options" hint="Separate with commas"><input className="input" value={editing.options} onChange={(e) => setEditing({ ...editing, options: e.target.value })} /></Field>}
                  <label className="flex cursor-pointer items-center gap-2.5 sm:col-span-2"><input type="checkbox" checked={editing.required} onChange={(e) => setEditing({ ...editing, required: e.target.checked })} /><span>Required when creating a lead</span></label>
                  <div className="flex gap-2 sm:col-span-2"><button className="btn-ink btn-sm" disabled={busy}>Save</button><button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button></div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{x.label}</span>{x.required && <span className="pill-amber ml-2">Required</span>}
                    {x.options.length > 0 && <span className="block truncate text-[13px] text-ink-muted">{x.options.join(', ')}</span>}
                  </span>
                  <span className="pill-muted">{FIELD_TYPES[x.type]}</span>
                  <span className="flex">
                    <button className="btn-icon" disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label={`Move ${x.label} up`}><ArrowUp className="h-4 w-4" /></button>
                    <button className="btn-icon" disabled={i === fields.length - 1 || busy} onClick={() => move(i, 1)} aria-label={`Move ${x.label} down`}><ArrowDown className="h-4 w-4" /></button>
                    <button className="btn-icon" onClick={() => setEditing({ id: x.id, label: x.label, options: x.options.join(', '), required: x.required, hasOptions: hasOptions(x.type) })} aria-label={`Edit ${x.label}`}><Pencil className="h-4 w-4" /></button>
                    <button className="btn-icon" disabled={busy} aria-label={`Delete ${x.label}`} onClick={async () => { if (await confirm({ title: `Delete the field ${x.label}?`, text: 'The value stored in this field is removed from every lead. This cannot be undone.', confirmLabel: 'Delete field', danger: true })) act(() => api(`/custom-fields/${x.id}`, { method: 'DELETE' }), 'Field deleted'); }}><Trash2 className="h-4 w-4" /></button>
                  </span>
                </div>
              )}
            </li>
          ))}
          {!fields.length && <li className="px-5 py-6 text-center text-ink-muted">No custom fields yet. Add your first one below.</li>}
        </ul>
      )}
      <form className="grid gap-3 card-pad sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('/custom-fields', { body: { label: f.label, type: f.type, required: f.required, options: hasOptions(f.type) ? split(f.options) : [] } }), 'Field added')) setF(blank); }}>
        <Field label="New field name"><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={60} placeholder="Budget" /></Field>
        <Field label="Type" hint="The type cannot be changed later">
          <select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as CustomField['type'] })}>
            {Object.entries(FIELD_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {hasOptions(f.type) && <Field label="Options" hint="Separate with commas" className="sm:col-span-2"><input className="input" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} placeholder="2 BHK, 3 BHK, Villa" /></Field>}
        <label className="flex cursor-pointer items-center gap-2.5"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /><span>Required when creating a lead</span></label>
        <div className="sm:col-span-2"><button className="btn-ink" disabled={busy || !f.label.trim() || (hasOptions(f.type) && !split(f.options).length)}><Plus className="h-4 w-4" />Add field</button></div>
      </form>
    </section>
  );
}

function LeadLists() {
  const { lists, reload, ready } = useRefs();
  const { can } = useAuth();
  const { confirm } = useUi();
  const { busy, run } = useSave();
  const [f, setF] = useState({ name: '', description: '' });
  const [editing, setEditing] = useState<{ id: string; name: string; description: string } | null>(null);
  const act = (fn: () => Promise<unknown>, ok: string) => run(() => fn().then(reload), ok);
  const manages = (l: { mine: boolean }) => l.mine || can('pipeline.manage');

  return (
    <section className="card">
      <div className="card-pad pb-3"><h2 className="card-title">Lead lists</h2><p className="text-ink-muted">Hand-picked sets of leads, such as a calling list or a campaign batch. Add leads from the Leads page by selecting them and choosing &ldquo;Add to list&rdquo;. Deleting a list never deletes its leads.</p></div>
      {!ready ? <Skeleton rows={3} /> : (
        <ul className="divide-y divide-ink/5 border-y border-ink/10">
          {lists.map((l) => (
            <li key={l.id} className="px-5 py-2.5">
              {editing?.id === l.id ? (
                <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api(`/lists/${l.id}`, { method: 'PATCH', body: { name: editing.name, description: editing.description || null } }), 'List saved')) setEditing(null); }}>
                  <Field label="List name"><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus maxLength={80} /></Field>
                  <Field label="Description"><input className="input" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} maxLength={300} /></Field>
                  <div className="flex gap-2 sm:col-span-2"><button className="btn-ink btn-sm" disabled={busy || !editing.name.trim()}>Save</button><button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button></div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{l.name}</span>
                    {l.description && <span className="block truncate text-[13px] text-ink-muted">{l.description}</span>}
                  </span>
                  <Link href={`/leads?listId=${l.id}`} className="text-[13px] text-ink-muted hover:text-ink hover:underline">{l.leads} lead{l.leads === 1 ? '' : 's'}</Link>
                  {manages(l) && (
                    <span className="flex">
                      <button className="btn-icon" onClick={() => setEditing({ id: l.id, name: l.name, description: l.description ?? '' })} aria-label={`Edit ${l.name}`}><Pencil className="h-4 w-4" /></button>
                      <button className="btn-icon" disabled={busy} aria-label={`Delete ${l.name}`} onClick={async () => { if (await confirm({ title: `Delete the list ${l.name}?`, text: 'The leads in it are kept; only the list is removed.', confirmLabel: 'Delete list', danger: true })) act(() => api(`/lists/${l.id}`, { method: 'DELETE' }), 'List deleted'); }}><Trash2 className="h-4 w-4" /></button>
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
          {!lists.length && <li className="px-5 py-6 text-center text-ink-muted">No lists yet. Create one below, then add leads to it from the Leads page.</li>}
        </ul>
      )}
      <form className="grid gap-3 card-pad sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('/lists', { body: { name: f.name, description: f.description || null } }), 'List created')) setF({ name: '', description: '' }); }}>
        <Field label="New list name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder="Diwali offer calls" /></Field>
        <Field label="Description" hint="Optional"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={300} placeholder="Call before the 20th" /></Field>
        <div className="sm:col-span-2"><button className="btn-ink" disabled={busy || !f.name.trim()}><Plus className="h-4 w-4" />Create list</button></div>
      </form>
    </section>
  );
}

type Rule = { id: string; name: string; sourceId: string | null; userIds: string[]; active: boolean };

function AssignmentRules() {
  const { members, sources } = useRefs();
  const { confirm } = useUi();
  const { busy, run } = useSave();
  const rules = useApi<Rule[]>('/assignment-rules');
  const blank = { id: '', name: '', sourceId: '', userIds: [] as string[] };
  const [f, setF] = useState<typeof blank | null>(null);
  const act = (fn: () => Promise<unknown>, ok: string) => run(() => fn().then(rules.reload), ok);
  const active = members.filter((m) => m.status === 'ACTIVE');
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? 'Removed user';
  const toggleUser = (id: string) => setF((s) => s && { ...s, userIds: s.userIds.includes(id) ? s.userIds.filter((x) => x !== id) : [...s.userIds, id] });

  return (
    <section className="card">
      <div className="card-pad pb-3">
        <h2 className="card-title">Assignment rules</h2>
        <p className="text-ink-muted">Share new leads out in turn (round-robin). Rules apply when a lead is created or imported with the owner set to &ldquo;Auto-assign by rule&rdquo;. A rule for the lead&rsquo;s source is used before a rule for all sources.</p>
      </div>
      {rules.error ? <ErrorState message={rules.error.message} onRetry={rules.reload} /> : !rules.data ? <Skeleton rows={3} /> : (
        <ul className="divide-y divide-ink/5 border-y border-ink/10">
          {rules.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{r.name}</span>
                <span className="pill-muted ml-2">{r.sourceId ? sources.find((s) => s.id === r.sourceId)?.name ?? 'Deleted source' : 'All sources'}</span>
                {!r.active && <span className="pill-amber ml-2">Paused</span>}
                <span className="block truncate text-[13px] text-ink-muted">{r.userIds.map(nameOf).join(' → ')}</span>
              </span>
              <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api(`/assignment-rules/${r.id}`, { method: 'PATCH', body: { active: !r.active } }), r.active ? 'Rule paused' : 'Rule resumed')}>{r.active ? 'Pause' : 'Resume'}</button>
              <button className="btn-icon" onClick={() => setF({ id: r.id, name: r.name, sourceId: r.sourceId ?? '', userIds: r.userIds.filter((u) => active.some((m) => m.id === u)) })} aria-label={`Edit ${r.name}`}><Pencil className="h-4 w-4" /></button>
              <button className="btn-icon" disabled={busy} aria-label={`Delete ${r.name}`} onClick={async () => { if (await confirm({ title: `Delete the rule ${r.name}?`, text: 'Leads already assigned keep their owners.', confirmLabel: 'Delete', danger: true })) act(() => api(`/assignment-rules/${r.id}`, { method: 'DELETE' }), 'Rule deleted'); }}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
          {!rules.data.length && <li className="px-5 py-6 text-center text-ink-muted">No rules yet. Without a rule, auto-assigned leads stay unassigned.</li>}
        </ul>
      )}
      {f ? (
        <form className="grid gap-3 card-pad sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          const body = { name: f.name, sourceId: f.sourceId || null, userIds: f.userIds };
          if (await act(() => api(f.id ? `/assignment-rules/${f.id}` : '/assignment-rules', { method: f.id ? 'PATCH' : 'POST', body }), f.id ? 'Rule saved' : 'Rule created')) setF(null);
        }}>
          <Field label="Rule name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus maxLength={80} placeholder="Website enquiries" /></Field>
          <Field label="Applies to">
            <select className="input" value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })}>
              <option value="">All sources</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <span className="label">Users in the rotation</span>
            <div className="flex flex-wrap gap-1.5">
              {active.map((m) => (
                <button type="button" key={m.id} aria-pressed={f.userIds.includes(m.id)} onClick={() => toggleUser(m.id)} className={f.userIds.includes(m.id) ? 'pill border border-ink bg-ink py-1 text-white' : 'pill border border-ink/15 py-1 text-ink-soft hover:border-ink/40'}>{m.name}</button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <button className="btn-ink" disabled={busy || !f.name.trim() || !f.userIds.length}>{f.id ? 'Save rule' : 'Create rule'}</button>
            <button type="button" className="btn-ghost" onClick={() => setF(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="card-pad"><button className="btn-ink" onClick={() => setF(blank)}><Plus className="h-4 w-4" />New rule</button></div>
      )}
    </section>
  );
}

function NamedList({ kind, title, hint, withColor }: { kind: 'sources' | 'labels'; title: string; hint: string; withColor?: boolean }) {
  const refs = useRefs();
  const { confirm } = useUi();
  const { busy, run } = useSave();
  const items = refs[kind] as { id: string; name: string; leads: number; color?: string }[];
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[5]);
  const [editing, setEditing] = useState<{ id: string; name: string; color: string } | null>(null);
  const act = (fn: () => Promise<unknown>, ok: string) => run(() => fn().then(refs.reload), ok);
  const one = kind === 'sources' ? 'Source' : 'Label';

  return (
    <section className="card">
      <div className="card-pad pb-3"><h2 className="card-title">{title}</h2><p className="text-ink-muted">{hint}</p></div>
      {!refs.ready ? <Skeleton rows={4} /> : (
        <ul className="divide-y divide-ink/5 border-y border-ink/10">
          {items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
              {editing?.id === it.id ? (
                <form className="flex flex-1 flex-wrap items-center gap-3" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api(`/${kind}/${it.id}`, { method: 'PATCH', body: withColor ? { name: editing.name, color: editing.color } : { name: editing.name } }), `${one} saved`)) setEditing(null); }}>
                  <input className="input max-w-[220px]" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus aria-label={`${one} name`} />
                  {withColor && <ColorPicker value={editing.color} onChange={(c) => setEditing({ ...editing, color: c })} />}
                  <button className="btn-ink btn-sm" disabled={busy}>Save</button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  {withColor && <ColorDot color={it.color!} />}
                  <span className="flex-1 font-medium">{it.name}</span>
                  <span className="text-[13px] text-ink-muted">{it.leads} lead{it.leads === 1 ? '' : 's'}</span>
                  <span className="flex">
                    <button className="btn-icon" onClick={() => setEditing({ id: it.id, name: it.name, color: it.color ?? COLORS[5] })} aria-label={`Edit ${it.name}`}><Pencil className="h-4 w-4" /></button>
                    <button className="btn-icon" disabled={busy} aria-label={`Delete ${it.name}`} onClick={async () => { if (await confirm({ title: `Delete ${it.name}?`, text: it.leads ? `${it.leads} lead${it.leads === 1 ? '' : 's'} will lose this ${one.toLowerCase()}. The leads themselves are kept.` : 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) act(() => api(`/${kind}/${it.id}`, { method: 'DELETE' }), `${one} deleted`); }}><Trash2 className="h-4 w-4" /></button>
                  </span>
                </>
              )}
            </li>
          ))}
          {!items.length && <li className="px-5 py-6 text-center text-ink-muted">None yet. Add your first one below.</li>}
        </ul>
      )}
      <form className="flex flex-wrap items-center gap-3 card-pad" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && (await act(() => api(`/${kind}`, { body: withColor ? { name, color } : { name } }), `${one} added`))) setName(''); }}>
        <input className="input max-w-[220px]" placeholder={`New ${one.toLowerCase()} name`} value={name} onChange={(e) => setName(e.target.value)} aria-label={`New ${one.toLowerCase()} name`} maxLength={60} />
        {withColor && <ColorPicker value={color} onChange={setColor} />}
        <button className="btn-ink" disabled={busy || !name.trim()}><Plus className="h-4 w-4" />Add</button>
      </form>
    </section>
  );
}
