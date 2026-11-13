'use client';
import { Pencil, Play, Plus, Trash2, Zap } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorState, Field, Modal, Skeleton, cx, useUi } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { TASK_TYPES, useRefs } from '@/lib/refs';

type Opt = { key: string; label: string; kind?: string };
type Options = { triggers: Opt[]; conditionFields: Opt[]; ops: string[]; stepTypes: Opt[]; placeholders: string[] };
type Tpl = { id: string; name: string; language: string; status: string; body: string; variables: number };
type Condition = { field: string; op: string; value?: string };
type Step = { type: string } & Record<string, string | number | undefined>;
type Automation = { id: string; name: string; description: string | null; trigger: string; conditions: Condition[]; steps: Step[]; active: boolean; runs: number; lastRunAt: string | null; last30Days: Record<string, number> };
type Run = { id: string; status: 'RUNNING' | 'WAITING' | 'DONE' | 'FAILED' | 'SKIPPED'; log: { at: string; step: number; type: string; result: string }[]; error: string | null; startedAt: string; finishedAt: string | null; resumeAt: string | null; lead: { id: string; name: string } | null };

const OP_LABELS: Record<string, string> = { is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'does not contain', gt: 'is more than', lt: 'is less than', is_set: 'is set', is_empty: 'is empty' };
const RUN_STYLE: Record<Run['status'], string> = { DONE: 'pill-green', FAILED: 'pill-danger', SKIPPED: 'pill-muted', WAITING: 'pill-amber', RUNNING: 'pill-amber' };

/** Settings → Automations: trigger + conditions + steps, with a per-run log and a "run on this lead" test. */
export function Automations() {
  const { toast, confirm } = useUi();
  const list = useApi<Automation[]>('/automations');
  const options = useApi<Options>('/automations/options');
  const [editing, setEditing] = useState<Partial<Automation> | null>(null);
  const [showRuns, setShowRuns] = useState<string | null>(null);
  const [testing, setTesting] = useState<Automation | null>(null);
  const label = (list: Opt[] | undefined, key: string) => list?.find((o) => o.key === key)?.label ?? key;

  async function toggle(a: Automation) {
    try { await api(`/automations/${a.id}`, { method: 'PATCH', body: { active: !a.active } }); toast(a.active ? 'Automation paused' : 'Automation resumed'); list.reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }
  async function remove(a: Automation) {
    if (!(await confirm({ title: `Delete ${a.name}?`, text: 'Its run history is deleted too. Changes it already made to leads are kept.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api(`/automations/${a.id}`, { method: 'DELETE' }); toast('Automation deleted'); list.reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  return (
    <section className="card">
      <div className="card-pad pb-3">
        <h2 className="card-title">Automations</h2>
        <p className="text-ink-muted">When something happens to a lead, check a few conditions and run steps: assign, label, move stage, create a follow-up, notify, email, call a webhook, wait. Every run is logged step by step. The same automation runs at most once per lead every ten minutes.</p>
      </div>
      {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} /> : !list.data || !options.data ? <Skeleton rows={3} /> : (
        <ul className="divide-y divide-ink/5 border-y border-ink/10">
          {list.data.map((a) => (
            <li key={a.id} className="px-5 py-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{a.name}</span>{!a.active && <span className="pill-amber ml-2">Paused</span>}
                  <span className="block text-[13px] text-ink-muted">When <strong className="font-medium text-ink-soft">{label(options.data!.triggers, a.trigger)}</strong>{a.conditions.length ? ` and ${a.conditions.length} condition${a.conditions.length === 1 ? '' : 's'} hold` : ''}: {a.steps.map((s) => label(options.data!.stepTypes, s.type)).join(' → ')}</span>
                  <span className="block text-[13px] text-ink-muted">{a.runs} run{a.runs === 1 ? '' : 's'}{a.lastRunAt ? ` · last ${fmtDateTime(a.lastRunAt)}` : ''} · last 30 days: {a.last30Days.done} done, {a.last30Days.skipped} skipped, {a.last30Days.failed} failed</span>
                </span>
                <button className="btn-ghost btn-sm" onClick={() => setShowRuns(showRuns === a.id ? null : a.id)}>{showRuns === a.id ? 'Hide runs' : 'Runs'}</button>
                <button className="btn-ghost btn-sm" onClick={() => setTesting(a)}><Play className="h-3.5 w-3.5" />Run on a lead</button>
                <button className="btn-ghost btn-sm" onClick={() => toggle(a)}>{a.active ? 'Pause' : 'Resume'}</button>
                <button className="btn-icon" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`}><Pencil className="h-4 w-4" /></button>
                <button className="btn-icon" onClick={() => remove(a)} aria-label={`Delete ${a.name}`}><Trash2 className="h-4 w-4" /></button>
              </div>
              {showRuns === a.id && <RunLog automationId={a.id} />}
            </li>
          ))}
          {!list.data.length && <li className="px-5 py-6 text-center text-ink-muted">No automations yet. Start with &ldquo;Lead created&rdquo; → &ldquo;Create follow-up&rdquo;.</li>}
        </ul>
      )}
      <div className="card-pad"><button className="btn-ink" onClick={() => setEditing({ name: '', trigger: 'lead.created', conditions: [], steps: [{ type: 'create_task', title: 'Follow up with {{lead.name}}', dueInHours: 24, assignee: 'owner' }], active: true })}><Zap className="h-4 w-4" />New automation</button></div>
      {editing && options.data && <Builder initial={editing} options={options.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
      {testing && <TestRun automation={testing} onClose={() => { setTesting(null); list.reload(); }} />}
    </section>
  );
}

function RunLog({ automationId }: { automationId: string }) {
  const runs = useApi<{ items: Run[]; total: number }>(`/automations/${automationId}/runs?pageSize=20`);
  if (runs.error) return <ErrorState message={runs.error.message} onRetry={runs.reload} />;
  if (!runs.data) return <Skeleton rows={2} />;
  return (
    <div className="mt-3 rounded-xl border border-ink/10 text-[13px]">
      <div className="flex items-center justify-between px-3 py-2 text-ink-muted"><span>Last {runs.data.items.length} of {runs.data.total} runs</span><button className="btn-ghost btn-sm" onClick={runs.reload}>Refresh</button></div>
      {!runs.data.items.length ? <p className="px-3 pb-3 text-ink-muted">Not run yet.</p> : (
        <ul className="divide-y divide-ink/5 border-t border-ink/10">
          {runs.data.items.map((r) => (
            <li key={r.id} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={RUN_STYLE[r.status]}>{r.status === 'DONE' ? 'Done' : r.status === 'FAILED' ? 'Failed' : r.status === 'SKIPPED' ? 'Skipped' : r.status === 'WAITING' ? `Waiting${r.resumeAt ? ` until ${fmtDateTime(r.resumeAt)}` : ''}` : 'Running'}</span>
                {r.lead ? <Link href={`/leads/${r.lead.id}`} className="font-medium hover:underline">{r.lead.name}</Link> : <span className="text-ink-muted">No lead</span>}
                <span className="ml-auto text-ink-muted">{fmtDateTime(r.startedAt)}</span>
              </div>
              {r.log.length > 0 && <ol className="mt-1 space-y-0.5 pl-1 text-ink-soft">{r.log.map((l, i) => <li key={i}><span className="text-ink-muted">{l.type}:</span> {l.result}</li>)}</ol>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TestRun({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const { toast } = useUi();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; name: string; phone: string | null }[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => { try { setResults((await api<{ items: any[] }>(`/leads?pageSize=6&q=${encodeURIComponent(q.trim())}`)).items); } catch { setResults([]); } }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const go = async (leadId: string) => {
    setBusy(true);
    try { setRun(await api<Run>(`/automations/${automation.id}/test`, { body: { leadId } })); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Run "${automation.name}" on a lead`} footer={<button className="btn-ink" onClick={onClose}>Close</button>}>
      <p className="mb-3 text-ink-muted">Runs the steps on one lead right now (conditions still apply; the trigger does not). Changes are real.</p>
      <input className="input" placeholder="Search a lead by name or phone…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {results.length > 0 && <ul className="mt-2 divide-y divide-ink/5 rounded-xl border border-ink/10">{results.map((l) => <li key={l.id}><button className="menu-item" disabled={busy} onClick={() => go(l.id)}><span className="flex-1 text-left">{l.name}<span className="text-ink-muted"> {l.phone ?? ''}</span></span><Play className="h-3.5 w-3.5" /></button></li>)}</ul>}
      {run && (
        <div className="mt-4 rounded-xl bg-cream p-3 text-[13px]">
          <p><span className={RUN_STYLE[run.status]}>{run.status}</span>{run.error && <span className="ml-2 text-danger">{run.error}</span>}</p>
          <ol className="mt-2 space-y-0.5 text-ink-soft">{run.log.map((l, i) => <li key={i}><span className="text-ink-muted">{l.type}:</span> {l.result}</li>)}</ol>
          {run.status === 'WAITING' && <p className="mt-2 text-ink-muted">The run continues in the background after the wait.</p>}
        </div>
      )}
    </Modal>
  );
}

function Builder({ initial, options, onClose, onSaved }: { initial: Partial<Automation>; options: Options; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const { pipelines, sources, labels, lists, members, connected } = useRefs();
  const templates = useApi<Tpl[]>(connected.whatsapp ? '/message-templates' : null);
  const stages = pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name })));
  const active = members.filter((m) => m.status === 'ACTIVE');
  const [name, setName] = useState(initial.name ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [trigger, setTrigger] = useState(initial.trigger ?? 'lead.created');
  const [conditions, setConditions] = useState<Condition[]>(initial.conditions ?? []);
  const [steps, setSteps] = useState<Step[]>(initial.steps ?? []);
  const [enabled, setEnabled] = useState(initial.active ?? true);
  const [busy, setBusy] = useState(false);
  const setCond = (i: number, patch: Partial<Condition>) => setConditions((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setStep = (i: number, patch: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, dir: -1 | 1) => setSteps((s) => { const n = [...s]; [n[i], n[i + dir]] = [n[i + dir], n[i]]; return n; });
  const kindOf = (field: string) => options.conditionFields.find((f) => f.key === field)?.kind ?? 'text';

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { name, description: description || null, trigger, conditions, steps, active: enabled };
      await api(initial.id ? `/automations/${initial.id}` : '/automations', { method: initial.id ? 'PATCH' : 'POST', body });
      toast(initial.id ? 'Automation saved' : 'Automation created');
      onSaved();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  }

  const valueInput = (c: Condition, i: number) => {
    if (c.op === 'is_set' || c.op === 'is_empty') return null;
    const kind = kindOf(c.field);
    const sel = (opts: { value: string; label: string }[]) => <select className="input" value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })}><option value="">Choose…</option>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
    if (kind === 'source') return sel(sources.map((s) => ({ value: s.id, label: s.name })));
    if (kind === 'stage') return sel(stages.map((s) => ({ value: s.id, label: pipelines.length > 1 ? `${s.pipeline}: ${s.name}` : s.name })));
    if (kind === 'stageType') return sel([{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }]);
    if (kind === 'owner') return sel([{ value: 'unassigned', label: 'Unassigned' }, ...active.map((m) => ({ value: m.id, label: m.name }))]);
    if (kind === 'label') return sel(labels.map((l) => ({ value: l.id, label: l.name })));
    return <input className="input" type={kind === 'number' ? 'number' : 'text'} value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="Value" />;
  };

  const userSelect = (value: string, onChange: (v: string) => void, ownerLabel: string) => (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}><option value="owner">{ownerLabel}</option>{active.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
  );
  const stepConfig = (s: Step, i: number) => {
    const v = (k: string) => String(s[k] ?? '');
    switch (s.type) {
      case 'assign': return <select className="input" value={v('ownerId')} onChange={(e) => setStep(i, { ownerId: e.target.value })}><option value="">Choose…</option><option value="auto">Auto-assign by rule</option><option value="unassigned">Unassigned</option>{active.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>;
      case 'move_stage': return <select className="input" value={v('stageId')} onChange={(e) => setStep(i, { stageId: e.target.value })}><option value="">Choose a stage…</option>{stages.map((st) => <option key={st.id} value={st.id}>{pipelines.length > 1 ? `${st.pipeline}: ` : ''}{st.name}</option>)}</select>;
      case 'add_label': case 'remove_label': return <select className="input" value={v('labelId')} onChange={(e) => setStep(i, { labelId: e.target.value })}><option value="">Choose a label…</option>{labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>;
      case 'add_to_list': return <select className="input" value={v('listId')} onChange={(e) => setStep(i, { listId: e.target.value })}><option value="">Choose a static list…</option>{lists.filter((l) => l.kind !== 'DYNAMIC').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>;
      case 'create_task': return <div className="grid gap-2 sm:grid-cols-2"><input className="input sm:col-span-2" value={v('title')} onChange={(e) => setStep(i, { title: e.target.value })} placeholder="Title, e.g. Welcome call for {{lead.name}}" /><select className="input" value={v('taskType') || 'FOLLOW_UP'} onChange={(e) => setStep(i, { taskType: e.target.value })}>{Object.entries(TASK_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><div className="flex items-center gap-2"><span className="text-[13px] text-ink-muted">Due in</span><input className="input" type="number" min={0} step="any" value={v('dueInHours') || '24'} onChange={(e) => setStep(i, { dueInHours: e.target.value })} /><span className="text-[13px] text-ink-muted">hours</span></div>{userSelect(v('assignee') || 'owner', (x) => setStep(i, { assignee: x }), 'The lead’s owner')}</div>;
      case 'notify': return <div className="grid gap-2 sm:grid-cols-2">{userSelect(v('userId') || 'owner', (x) => setStep(i, { userId: x }), 'The lead’s owner')}<input className="input" value={v('title')} onChange={(e) => setStep(i, { title: e.target.value })} placeholder="Message, e.g. {{lead.name}} moved to {{lead.stage}}" /></div>;
      case 'send_email': return <div className="grid gap-2"><div className="grid gap-2 sm:grid-cols-2"><select className="input" value={v('to') || 'lead'} onChange={(e) => setStep(i, { to: e.target.value })}><option value="lead">To the lead</option><option value="owner">To the lead’s owner</option><option value="custom">To an address</option></select>{v('to') === 'custom' ? <input className="input" type="email" value={v('email')} onChange={(e) => setStep(i, { email: e.target.value })} placeholder="someone@company.com" /> : <input className="input" value={v('subject')} onChange={(e) => setStep(i, { subject: e.target.value })} placeholder="Subject" />}</div>{v('to') === 'custom' && <input className="input" value={v('subject')} onChange={(e) => setStep(i, { subject: e.target.value })} placeholder="Subject" />}<textarea className="input min-h-[80px]" value={v('body')} onChange={(e) => setStep(i, { body: e.target.value })} placeholder={`Hi {{lead.name}},\n\nThanks for your interest…`} /><p className="text-[12px] text-ink-muted">Needs an email connection (Integrations → Email). Placeholders: {options.placeholders.join(' ')}</p></div>;
      case 'webhook': return <input className="input" type="url" value={v('url')} onChange={(e) => setStep(i, { url: e.target.value })} placeholder="https://hooks.example.com/…" />;
      case 'send_whatsapp': {
        const t = templates.data?.find((x) => x.name === v('templateName') && x.language === (v('language') || 'en'));
        return <div className="grid gap-2"><select className="input" value={t ? `${t.name}:${t.language}` : ''} onChange={(e) => { const [name, language] = e.target.value.split(':'); setStep(i, { templateName: name, language }); }}><option value="">{connected.whatsapp ? 'Choose an approved template…' : 'Connect WhatsApp first'}</option>{templates.data?.filter((x) => x.status === 'APPROVED').map((x) => <option key={x.id} value={`${x.name}:${x.language}`}>{x.name} ({x.language})</option>)}</select>{t && <p className="rounded-xl bg-cream px-3 py-2 text-[13px] text-ink-soft">{t.body}</p>}{t && t.variables > 0 && <input className="input" value={v('params')} onChange={(e) => setStep(i, { params: e.target.value })} placeholder={`${t.variables} value${t.variables === 1 ? '' : 's'} separated by | e.g. {{lead.name}} | {{org.name}}`} />}</div>;
      }
      case 'send_sms': return <div><textarea className="input min-h-[64px]" value={v('body')} onChange={(e) => setStep(i, { body: e.target.value })} placeholder="Hi {{lead.name}}, thanks for contacting {{org.name}}." maxLength={480} /><p className="text-[12px] text-ink-muted">{connected.sms_http ? 'Sent through the connected SMS gateway. In India the text must match an approved DLT template.' : 'Connect an SMS gateway under Integrations first.'}</p></div>;
      case 'update_field': return <div className="grid gap-2 sm:grid-cols-2"><select className="input" value={v('field')} onChange={(e) => setStep(i, { field: e.target.value })}><option value="">Choose a field…</option><option value="score">Score</option><option value="dealValue">Deal value</option><option value="city">City</option><option value="company">Company</option>{options.conditionFields.filter((f) => f.key.startsWith('cf_')).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select><input className="input" value={v('value')} onChange={(e) => setStep(i, { value: e.target.value })} placeholder="New value" /></div>;
      case 'wait': return <div className="flex flex-wrap items-center gap-2"><input className="input w-24" type="number" min={0} value={v('days') || '0'} onChange={(e) => setStep(i, { days: e.target.value })} aria-label="Days" /><span className="text-[13px] text-ink-muted">days</span><input className="input w-24" type="number" min={0} value={v('hours') || '0'} onChange={(e) => setStep(i, { hours: e.target.value })} aria-label="Hours" /><span className="text-[13px] text-ink-muted">hours</span><input className="input w-24" type="number" min={0} value={v('minutes') || '0'} onChange={(e) => setStep(i, { minutes: e.target.value })} aria-label="Minutes" /><span className="text-[13px] text-ink-muted">minutes</span></div>;
      default: return null;
    }
  };

  return (
    <Modal open onClose={onClose} title={initial.id ? 'Edit automation' : 'New automation'} wide
      footer={<><button className="btn-ghost" onClick={onClose} type="button">Cancel</button><button className="btn-primary" form="automation-form" disabled={busy || !name.trim() || !steps.length}>{initial.id ? 'Save automation' : 'Create automation'}</button></>}>
      <form id="automation-form" className="space-y-5" onSubmit={save}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} placeholder="Facebook welcome" /></Field>
          <Field label="When this happens"><select className="input" value={trigger} onChange={(e) => setTrigger(e.target.value)}>{options.triggers.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></Field>
          <Field label="Description" className="sm:col-span-2"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Optional" /></Field>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between"><span className="label mb-0">Only if…</span><button type="button" className="btn-ghost btn-sm" onClick={() => setConditions((c) => [...c, { field: 'source', op: 'is', value: '' }])}><Plus className="h-3.5 w-3.5" />Add condition</button></div>
          {!conditions.length && <p className="text-[13px] text-ink-muted">No conditions: every matching event runs the steps.</p>}
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <select className="input" value={c.field} onChange={(e) => setCond(i, { field: e.target.value, value: '' })}>{options.conditionFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
                <select className="input" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>{options.ops.map((op) => <option key={op} value={op}>{OP_LABELS[op] ?? op}</option>)}</select>
                <div>{valueInput(c, i)}</div>
                <button type="button" className="btn-icon" onClick={() => setConditions((x) => x.filter((_, j) => j !== i))} aria-label="Remove condition"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between"><span className="label mb-0">Then do, in order</span><button type="button" className="btn-ghost btn-sm" onClick={() => setSteps((s) => [...s, { type: 'add_label' }])}><Plus className="h-3.5 w-3.5" />Add step</button></div>
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className={cx('rounded-xl border border-ink/10 p-3', s.type === 'wait' && 'bg-cream')}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="pill-ink">{i + 1}</span>
                  <select className="input w-auto" value={s.type} onChange={(e) => setSteps((x) => x.map((y, j) => (j === i ? { type: e.target.value } : y)))}>{options.stepTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
                  <span className="ml-auto flex">
                    <button type="button" className="btn-ghost btn-sm" disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
                    <button type="button" className="btn-ghost btn-sm" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>Down</button>
                    <button type="button" className="btn-icon" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Remove step"><Trash2 className="h-4 w-4" /></button>
                  </span>
                </div>
                {stepConfig(s, i)}
              </li>
            ))}
          </ol>
        </div>
        <label className="flex cursor-pointer items-center gap-2.5"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span>Active</span></label>
      </form>
    </Modal>
  );
}
