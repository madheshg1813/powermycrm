'use client';
import { CheckCircle2, FileUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { parseCsv } from '@/lib/format';
import { useRefs } from '@/lib/refs';
import { Field, Modal, Spinner } from './ui';

const TARGETS: { key: string; label: string; match: RegExp }[] = [
  { key: 'name', label: 'Name', match: /^(full ?name|name|lead ?name|customer|contact)$/i },
  { key: 'phone', label: 'Phone', match: /phone|mobile|contact ?(no|number)|whatsapp/i },
  { key: 'email', label: 'Email', match: /e-?mail/i },
  { key: 'company', label: 'Company', match: /company|organi[sz]ation|business/i },
  { key: 'city', label: 'City', match: /city|location|town/i },
  { key: 'source', label: 'Source', match: /source|channel|campaign/i },
  { key: 'dealValue', label: 'Deal value', match: /value|amount|budget|price/i },
  { key: 'note', label: 'Note', match: /note|remark|comment|requirement/i },
];
const CHUNK = 1000;
type Result = { created: number; updated: number; skipped: number; errors: { row: number; message: string }[] };

export function ImportLeads({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { me, can } = useAuth();
  const { members, sources, fields } = useRefs();
  // Custom fields are sent as "cf_<key>" columns and auto-matched on their exact name.
  const targets = [
    ...TARGETS,
    ...fields.map((f) => ({ key: `cf_${f.key}`, label: f.label, match: new RegExp(`^${f.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })),
  ];
  const [rows, setRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [strategy, setStrategy] = useState('skip');
  const [ownerId, setOwnerId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (open) { setRows(null); setFileName(''); setError(''); setResult(null); setProgress(null); setStrategy('skip'); setOwnerId(me?.user.id ?? ''); setSourceId(''); }
  }, [open, me]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError('');
    if (!/\.csv$/i.test(file.name)) return setError('Choose a .csv file. In Excel or Google Sheets, use File → Save as / Download → CSV.');
    if (file.size > 20 * 1024 * 1024) return setError('This file is larger than 20 MB. Split it into smaller files.');
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) return setError('This file has no data rows under its header row.');
    const header = parsed[0];
    const auto: Record<string, string> = {};
    for (const t of targets) {
      const i = header.findIndex((h, idx) => t.match.test(h.trim()) && !Object.values(auto).includes(String(idx)));
      if (i >= 0) auto[t.key] = String(i);
    }
    setMapping(auto);
    setRows(parsed);
    setFileName(file.name);
  }

  const header = rows?.[0] ?? [];
  const data = rows?.slice(1) ?? [];
  const mappedKeys = Object.entries(mapping).filter(([, v]) => v !== '');
  const canImport = ['name', 'phone', 'email'].some((k) => mapping[k]);

  async function run() {
    setError('');
    const total: Result = { created: 0, updated: 0, skipped: 0, errors: [] };
    try {
      for (let i = 0; i < data.length; i += CHUNK) {
        setProgress(Math.round((i / data.length) * 100));
        const chunk = data.slice(i, i + CHUNK).map((r) => Object.fromEntries(mappedKeys.map(([k, col]) => [k, r[Number(col)] ?? ''])));
        const body: Record<string, unknown> = { rows: chunk, duplicateStrategy: strategy, sourceId: sourceId || null };
        if (can('leads.assign')) body.ownerId = ownerId || null;
        const r = await api<Result>('/leads/import', { body });
        total.created += r.created; total.updated += r.updated; total.skipped += r.skipped;
        total.errors.push(...r.errors.map((e) => ({ row: e.row + i + 1, message: e.message }))); // +1 for the header row
      }
      setResult(total);
      onDone();
    } catch (e) {
      setError(`${(e as Error).message}${total.created || total.updated ? ` ${total.created} lead(s) were imported before the error.` : ''}`);
      if (total.created || total.updated) onDone();
    } finally {
      setProgress(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import leads"
      wide
      footer={
        result ? <button className="btn-ink" onClick={onClose}>Done</button> : (
          <>
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={!rows || !canImport || progress !== null} onClick={run}>
              {progress !== null && <Spinner />}{progress !== null ? `Importing ${progress}%` : rows ? `Import ${data.length.toLocaleString('en-IN')} rows` : 'Import'}
            </button>
          </>
        )
      }
    >
      {error && <p className="mb-3 rounded-xl bg-danger-soft px-3 py-2 text-danger" role="alert">{error}</p>}
      {result ? (
        <div>
          <p className="flex items-center gap-2 font-display text-lg font-bold"><CheckCircle2 className="h-5 w-5 text-green" />Import finished</p>
          <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
            {[['Created', result.created], ['Updated', result.updated], ['Skipped duplicates', result.skipped]].map(([k, v]) => (
              <div key={k} className="rounded-2xl bg-cream px-3 py-4"><dd className="font-display text-2xl font-extrabold">{v}</dd><dt className="text-[13px] text-ink-muted">{k}</dt></div>
            ))}
          </dl>
          {result.errors.length > 0 && (
            <div className="mt-4">
              <p className="font-semibold text-danger">{result.errors.length} row{result.errors.length === 1 ? ' was' : 's were'} not imported</p>
              <ul className="mt-1 max-h-40 overflow-y-auto text-[13px] text-ink-soft">
                {result.errors.slice(0, 200).map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}
              </ul>
            </div>
          )}
        </div>
      ) : !rows ? (
        <label className="flex cursor-pointer flex-col items-center rounded-2xl border border-dashed border-ink/25 px-6 py-12 text-center transition hover:border-ink/50 hover:bg-cream/60">
          <FileUp className="h-7 w-7 text-ink-faint" />
          <span className="mt-3 font-display text-base font-bold">Choose a CSV file</span>
          <span className="mt-1 max-w-sm text-ink-muted">The first row must contain column names. Any column layout works; you map the columns in the next step.</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
      ) : (
        <div className="space-y-5">
          <p className="text-ink-muted"><strong className="text-ink">{fileName}</strong> &middot; {data.length.toLocaleString('en-IN')} rows &middot; {header.length} columns</p>
          <div>
            <p className="overline mb-2">Match your columns</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {targets.map((t) => (
                <Field key={t.key} label={t.label}>
                  <select className="input" value={mapping[t.key] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [t.key]: e.target.value }))}>
                    <option value="">Do not import</option>
                    {header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </Field>
              ))}
            </div>
            {!canImport && <p className="mt-2 text-xs text-danger">Map at least one of Name, Phone or Email.</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="If a lead already exists" hint="Matched on phone or email">
              <select className="input" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                <option value="skip">Skip the row</option><option value="update">Update the existing lead</option><option value="create">Create a duplicate</option>
              </select>
            </Field>
            <Field label="Assign to">
              <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={!can('leads.assign')}>
                <option value="">Unassigned</option>
                <option value="auto">Auto-assign by rule</option>
                {members.filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
            <Field label="Default source" hint="Used when a row has none">
              <select className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">No source</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          {mappedKeys.length > 0 && (
            <div>
              <p className="overline mb-2">Preview</p>
              <div className="overflow-x-auto rounded-xl border border-ink/10">
                <table className="table">
                  <thead><tr>{mappedKeys.map(([k]) => <th key={k}>{targets.find((t) => t.key === k)!.label}</th>)}</tr></thead>
                  <tbody>{data.slice(0, 4).map((r, i) => <tr key={i}>{mappedKeys.map(([k, col]) => <td key={k} className="max-w-[180px] truncate">{r[Number(col)]}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
