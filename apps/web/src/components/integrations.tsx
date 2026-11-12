'use client';
import { Check, Copy, KeyRound, Pencil, Plus, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorState, Field, Modal, Skeleton, Spinner, cx, useUi } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { fmtDateTime, relTime } from '@/lib/format';
import { useRefs } from '@/lib/refs';

type Integration = {
  id: string; provider: string; name: string; status: 'NOT_CONNECTED' | 'AWAITING_CREDENTIALS' | 'CONNECTED' | 'ERROR' | 'DISABLED';
  settings: { sourceId: string | null; ownerId: string | null; duplicateStrategy: 'skip' | 'update' | 'create'; redirectUrl: string | null };
  fieldMapping: Record<string, string>; lastError: string | null; lastEventAt: string | null; token: string | null; endpointUrl: string | null;
  events: { pending: number; processed: number; skipped: number; failed: number };
};
type IntegrationEvent = { id: string; status: 'PENDING' | 'PROCESSED' | 'SKIPPED' | 'FAILED'; type: string; payload: Record<string, unknown>; error: string | null; attempts: number; createdAt: string; lead: { id: string; name: string } | null };
type Endpoint = { id: string; name: string; url: string; events: string[]; active: boolean; lastDeliveryAt: string | null; lastStatus: number | null; deliveries: { pending: number; delivered: number; failed: number } };
type Delivery = { id: string; eventType: string; status: 'PENDING' | 'DELIVERED' | 'FAILED'; attempts: number; responseCode: number | null; error: string | null; createdAt: string; deliveredAt: string | null };
type ApiKey = { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };

const FIELD_LABELS: Record<string, string> = { name: 'Name', phone: 'Phone', email: 'Email', company: 'Company', city: 'City', message: 'Message (saved as a note)', source: 'Source name' };

function useSave() {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); return true; } catch (e) { toast((e as Error).message, 'error'); return false; } finally { setBusy(false); }
  };
  return { busy, run };
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn-ghost btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard unavailable */ } }}>
      {done ? <Check className="h-3.5 w-3.5 text-green" /> : <Copy className="h-3.5 w-3.5" />}{done ? 'Copied' : label}
    </button>
  );
}

function Secret({ value, onDone, title, text }: { value: string; onDone: () => void; title: string; text: string }) {
  return (
    <Modal open onClose={onDone} title={title} footer={<button className="btn-ink" onClick={onDone}>Done</button>}>
      <p className="mb-3 text-ink-soft">{text}</p>
      <div className="flex items-center gap-2 rounded-xl bg-cream px-3 py-2 font-mono text-[13px] break-all">{value}<CopyButton text={value} /></div>
    </Modal>
  );
}

/** Settings → Integrations: website forms, outbound webhooks and API keys. Only what works end to end is offered. */
export function Integrations() {
  return (
    <>
      <EmailSetup />
      <WebsiteForms />
      <Webhooks />
      <ApiKeys />
    </>
  );
}

type EmailStatus = { canSend: boolean; via: string | null; platformConfigured: boolean; integration: (Integration & { credentials: { host: string; port: number; secure: boolean; user: string; from: string; hasPassword: boolean } | null }) | null };
type EmailRow = { id: string; kind: string; to: string; subject: string; status: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED'; provider: string | null; error: string | null; sentAt: string | null; createdAt: string };

function EmailSetup() {
  const { toast, confirm } = useUi();
  const { busy, run } = useSave();
  const status = useApi<EmailStatus>('/integrations/email-status');
  const log = useApi<{ items: EmailRow[]; total: number }>('/emails?pageSize=10');
  const blank = { host: '', port: '587', secure: false, user: '', pass: '', from: '' };
  const [f, setF] = useState<typeof blank | null>(null);
  const reload = () => { status.reload(); log.reload(); };
  const i = status.data?.integration ?? null;
  const open = () => setF(i?.credentials ? { host: i.credentials.host, port: String(i.credentials.port), secure: i.credentials.secure, user: i.credentials.user, pass: '', from: i.credentials.from } : blank);

  return (
    <section className="card">
      <div className="card-pad pb-3">
        <h2 className="card-title">Email</h2>
        <p className="text-ink-muted">Invitations, password resets and verification emails are sent through your own SMTP account. Gmail, Microsoft 365, Zoho, Amazon SES and SendGrid all provide SMTP details; Gmail needs an app password.</p>
      </div>
      {status.error ? <ErrorState message={status.error.message} onRetry={status.reload} /> : !status.data ? <Skeleton rows={2} /> : (
        <div className="border-y border-ink/10 px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">
              {i ? (
                <>
                  <span className="font-medium">{i.credentials?.from}</span>
                  <span className={cx('ml-2', i.status === 'CONNECTED' ? 'pill-green' : i.status === 'ERROR' ? 'pill-danger' : 'pill-amber')}>{i.status === 'CONNECTED' ? 'Connected' : i.status === 'ERROR' ? 'Connection failed' : i.status === 'DISABLED' ? 'Paused' : 'Awaiting test'}</span>
                  <span className="block text-[13px] text-ink-muted">{i.credentials?.host}:{i.credentials?.port}{i.credentials?.user ? ` as ${i.credentials.user}` : ''}</span>
                  {i.lastError && <span className="block text-[13px] text-danger">{i.lastError}</span>}
                </>
              ) : status.data.platformConfigured ? (
                <><span className="font-medium">Using the platform email service</span><span className="pill-green ml-2">Ready</span><span className="block text-[13px] text-ink-muted">Connect your own account to send from your address.</span></>
              ) : (
                <><span className="font-medium">No email connection</span><span className="pill-amber ml-2">Not connected</span><span className="block text-[13px] text-ink-muted">Invitation links are shown to you to share by hand until an account is connected.</span></>
              )}
            </span>
            {i && <button className="btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api(`/integrations/${i.id}/test`, { body: {} }).then(reload), 'Connection tested')}><RefreshCw className="h-3.5 w-3.5" />Test connection</button>}
            {i?.status === 'CONNECTED' && <button className="btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api(`/integrations/${i.id}/send-test`, { body: {} }).then(() => setTimeout(reload, 2500)), 'Test email queued to your address')}><Send className="h-3.5 w-3.5" />Send test email</button>}
            <button className="btn-ghost btn-sm" onClick={open}>{i ? 'Edit' : 'Connect email'}</button>
            {i && <button className="btn-icon" disabled={busy} aria-label="Remove email connection" onClick={async () => { if (await confirm({ title: 'Remove the email connection?', text: 'Emails will stop being sent until another account is connected.', confirmLabel: 'Remove', danger: true })) run(() => api(`/integrations/${i.id}`, { method: 'DELETE' }).then(reload), 'Email connection removed'); }}><Trash2 className="h-4 w-4" /></button>}
          </div>
        </div>
      )}
      {f && (
        <form className="grid gap-3 card-pad sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          const credentials: Record<string, unknown> = { host: f.host, port: Number(f.port), secure: f.secure, user: f.user, from: f.from };
          if (f.pass) credentials.pass = f.pass;
          try {
            const r = await api<Integration>(i ? `/integrations/${i.id}` : '/integrations', { method: i ? 'PATCH' : 'POST', body: i ? { credentials } : { provider: 'smtp', name: 'Email', credentials } });
            toast(r.status === 'CONNECTED' ? 'Connected. Emails will be sent from this account.' : `Saved, but the connection failed: ${r.lastError ?? 'check the details'}`, r.status === 'CONNECTED' ? 'success' : 'error');
            setF(null);
            reload();
          } catch (err) { toast((err as Error).message, 'error'); }
        }}>
          <Field label="SMTP host"><input className="input" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp.gmail.com" required autoFocus /></Field>
          <Field label="Port"><input className="input" type="number" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} min={1} max={65535} required /></Field>
          <Field label="Username"><input className="input" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} placeholder="you@yourcompany.com" autoComplete="off" /></Field>
          <Field label={i?.credentials?.hasPassword ? 'Password (leave blank to keep)' : 'Password or app password'}><input className="input" type="password" value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} autoComplete="new-password" /></Field>
          <Field label="From address" hint="What recipients see" className="sm:col-span-2"><input className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="Sales Team <sales@yourcompany.com>" required /></Field>
          <label className="flex cursor-pointer items-center gap-2.5 sm:col-span-2"><input type="checkbox" checked={f.secure} onChange={(e) => setF({ ...f, secure: e.target.checked })} /><span>Use implicit TLS (port 465). Leave off for port 587 (STARTTLS).</span></label>
          <div className="flex gap-2 sm:col-span-2"><button className="btn-ink" disabled={busy}>Save and test</button><button type="button" className="btn-ghost" onClick={() => setF(null)}>Cancel</button></div>
        </form>
      )}
      {log.data && log.data.items.length > 0 && (
        <details className="px-5 pb-4 text-[13px]">
          <summary className="cursor-pointer font-medium text-ink-soft">Recent emails ({log.data.total})</summary>
          <ul className="mt-2 divide-y divide-ink/5 rounded-xl border border-ink/10">
            {log.data.items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className={m.status === 'SENT' ? 'pill-green' : m.status === 'FAILED' ? 'pill-danger' : m.status === 'SKIPPED' ? 'pill-amber' : 'pill-muted'}>{m.status === 'SENT' ? 'Sent' : m.status === 'FAILED' ? 'Failed' : m.status === 'SKIPPED' ? 'Not sent' : 'Queued'}</span>
                <span className="font-medium">{m.to}</span><span className="min-w-0 flex-1 truncate text-ink-muted">{m.subject}</span>
                {m.error && <span className="text-danger">{m.error}</span>}
                <span className="text-ink-muted">{fmtDateTime(m.sentAt ?? m.createdAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function WebsiteForms() {
  const { sources, members, fields } = useRefs();
  const { confirm } = useUi();
  const { busy, run } = useSave();
  const list = useApi<Integration[]>('/integrations');
  const blank = { id: '', name: '', sourceId: '', ownerId: 'auto', duplicateStrategy: 'skip', redirectUrl: '', mapping: {} as Record<string, string> };
  const [f, setF] = useState<typeof blank | null>(null);
  const [showEvents, setShowEvents] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>, ok: string) => run(() => fn().then(list.reload), ok);
  const mappable = ['name', 'phone', 'email', 'company', 'city', 'message', 'source', ...fields.map((x) => `cf_${x.key}`)];
  const labelOf = (k: string) => FIELD_LABELS[k] ?? fields.find((x) => `cf_${x.key}` === k)?.label ?? k;

  const snippet = (i: Integration) => `<form method="POST" action="${i.endpointUrl}">
  <input type="hidden" name="_token" value="${i.token}">
  <input type="text" name="${i.fieldMapping.name || 'name'}" placeholder="Your name" required>
  <input type="tel" name="${i.fieldMapping.phone || 'phone'}" placeholder="Phone" required>
  <input type="email" name="${i.fieldMapping.email || 'email'}" placeholder="Email">
  <textarea name="${i.fieldMapping.message || 'message'}" placeholder="How can we help?"></textarea>
  <input type="text" name="_hp" style="display:none" tabindex="-1" autocomplete="off">
  <button type="submit">Send</button>
</form>`;

  return (
    <section className="card">
      <div className="card-pad pb-3">
        <h2 className="card-title">Website forms</h2>
        <p className="text-ink-muted">Point any HTML form at a PowerMyCRM endpoint. Every submission is stored, turned into a lead, de-duplicated by phone or email and assigned by your rules. Field names on your form are mapped to lead fields below.</p>
      </div>
      {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} /> : !list.data ? <Skeleton rows={2} /> : (
        <ul className="divide-y divide-ink/5 border-y border-ink/10">
          {list.data.map((i) => (
            <li key={i.id} className="px-5 py-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{i.name}</span>
                  <span className={cx('ml-2', i.status === 'CONNECTED' ? 'pill-green' : i.status === 'ERROR' ? 'pill-danger' : 'pill-muted')}>{i.status === 'CONNECTED' ? 'Active' : i.status === 'DISABLED' ? 'Paused' : i.status === 'ERROR' ? 'Error' : i.status}</span>
                  <span className="block text-[13px] text-ink-muted">{i.events.processed} lead{i.events.processed === 1 ? '' : 's'} created · {i.events.skipped} repeat{i.events.skipped === 1 ? '' : 's'} · {i.events.failed} failed{i.lastEventAt ? ` · last submission ${relTime(i.lastEventAt)}` : ' · no submissions yet'}</span>
                  {i.lastError && <span className="block text-[13px] text-danger">{i.lastError}</span>}
                </span>
                <button className="btn-ghost btn-sm" onClick={() => setShowEvents(showEvents === i.id ? null : i.id)}>{showEvents === i.id ? 'Hide submissions' : 'Submissions'}</button>
                <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api(`/integrations/${i.id}`, { method: 'PATCH', body: { status: i.status === 'DISABLED' ? 'CONNECTED' : 'DISABLED' } }), i.status === 'DISABLED' ? 'Form resumed' : 'Form paused')}>{i.status === 'DISABLED' ? 'Resume' : 'Pause'}</button>
                <button className="btn-icon" onClick={() => setF({ id: i.id, name: i.name, sourceId: i.settings.sourceId ?? '', ownerId: i.settings.ownerId ?? '', duplicateStrategy: i.settings.duplicateStrategy, redirectUrl: i.settings.redirectUrl ?? '', mapping: i.fieldMapping })} aria-label={`Edit ${i.name}`}><Pencil className="h-4 w-4" /></button>
                <button className="btn-icon" disabled={busy} aria-label={`Delete ${i.name}`} onClick={async () => { if (await confirm({ title: `Delete the form ${i.name}?`, text: 'Its endpoint stops working at once. Leads already created are kept.', confirmLabel: 'Delete', danger: true })) act(() => api(`/integrations/${i.id}`, { method: 'DELETE' }), 'Form deleted'); }}><Trash2 className="h-4 w-4" /></button>
              </div>
              <details className="mt-2 text-[13px]">
                <summary className="cursor-pointer font-medium text-ink-soft">Endpoint, token and sample form</summary>
                <div className="mt-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-ink-muted">Endpoint</span><code className="rounded-lg bg-cream px-2 py-1 break-all">{i.endpointUrl}</code><CopyButton text={i.endpointUrl ?? ''} /></div>
                  <div className="flex flex-wrap items-center gap-2"><span className="text-ink-muted">Token</span><code className="rounded-lg bg-cream px-2 py-1 break-all">{i.token}</code><CopyButton text={i.token ?? ''} /><button className="btn-ghost btn-sm" disabled={busy} onClick={async () => { if (await confirm({ title: 'Rotate the form token?', text: 'Forms still using the old token will be rejected until you update them.', confirmLabel: 'Rotate' })) act(() => api(`/integrations/${i.id}/rotate-token`, { body: {} }), 'Token rotated'); }}><RefreshCw className="h-3.5 w-3.5" />Rotate</button></div>
                  <p className="text-ink-muted">Send JSON or a normal form post. Include the token as a hidden <code>_token</code> field, a <code>?token=</code> query parameter or an <code>X-Form-Token</code> header. An empty hidden <code>_hp</code> field catches bots; an optional <code>_id</code> prevents duplicate submissions.</p>
                  <div className="relative"><pre className="overflow-x-auto rounded-xl bg-ink p-3 text-[12px] text-white">{snippet(i)}</pre><span className="absolute right-2 top-2"><CopyButton text={snippet(i)} label="Copy form" /></span></div>
                </div>
              </details>
              {showEvents === i.id && <EventLog integrationId={i.id} onChanged={list.reload} />}
            </li>
          ))}
          {!list.data.length && <li className="px-5 py-6 text-center text-ink-muted">No website forms yet. Add one to get an endpoint and a sample form.</li>}
        </ul>
      )}
      {f ? (
        <form className="grid gap-3 card-pad sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          const body = { provider: 'website_form', name: f.name, settings: { sourceId: f.sourceId || null, ownerId: f.ownerId === '' ? null : f.ownerId, duplicateStrategy: f.duplicateStrategy, redirectUrl: f.redirectUrl || null }, fieldMapping: Object.fromEntries(Object.entries(f.mapping).filter(([, v]) => v.trim())) };
          if (await act(() => api(f.id ? `/integrations/${f.id}` : '/integrations', { method: f.id ? 'PATCH' : 'POST', body: f.id ? { ...body, provider: undefined } : body }), f.id ? 'Form saved' : 'Form created')) setF(null);
        }}>
          <Field label="Form name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus maxLength={80} placeholder="Landing page" /></Field>
          <Field label="Lead source"><select className="input" value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })}><option value="">From the form, or none</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Assign new leads to"><select className="input" value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}><option value="auto">Auto-assign by rule</option><option value="">Leave unassigned</option>{members.filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
          <Field label="If the phone or email already exists"><select className="input" value={f.duplicateStrategy} onChange={(e) => setF({ ...f, duplicateStrategy: e.target.value })}><option value="skip">Add a note to the existing lead</option><option value="update">Fill empty fields on the existing lead</option><option value="create">Create another lead</option></select></Field>
          <Field label="Redirect after a browser submission" hint="Optional thank-you page" className="sm:col-span-2"><input className="input" type="url" value={f.redirectUrl} onChange={(e) => setF({ ...f, redirectUrl: e.target.value })} placeholder="https://yoursite.com/thanks" /></Field>
          <div className="sm:col-span-2">
            <span className="label">Field mapping</span>
            <p className="mb-2 text-[13px] text-ink-muted">Enter the name attribute your form uses for each lead field. Leave blank to use the same name as the lead field.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {mappable.map((k) => (
                <label key={k} className="flex items-center gap-2 text-[13px]"><span className="w-40 shrink-0 text-ink-soft">{labelOf(k)}</span><input className="input" value={f.mapping[k] ?? ''} onChange={(e) => setF({ ...f, mapping: { ...f.mapping, [k]: e.target.value } })} placeholder={k.startsWith('cf_') ? k.slice(3) : k} /></label>
              ))}
            </div>
          </div>
          <div className="flex gap-2 sm:col-span-2"><button className="btn-ink" disabled={busy || !f.name.trim()}>{f.id ? 'Save form' : 'Create form'}</button><button type="button" className="btn-ghost" onClick={() => setF(null)}>Cancel</button></div>
        </form>
      ) : <div className="card-pad"><button className="btn-ink" onClick={() => setF(blank)}><Plus className="h-4 w-4" />Add website form</button></div>}
    </section>
  );
}

function EventLog({ integrationId, onChanged }: { integrationId: string; onChanged: () => void }) {
  const { toast } = useUi();
  const log = useApi<{ items: IntegrationEvent[]; total: number }>(`/integrations/${integrationId}/events?pageSize=25`);
  const retry = async (e: IntegrationEvent) => { try { await api(`/integrations/${integrationId}/events/${e.id}/retry`, { body: {} }); toast('Submission queued again'); setTimeout(() => { log.reload(); onChanged(); }, 1500); } catch (err) { toast((err as Error).message, 'error'); } };
  if (log.error) return <ErrorState message={log.error.message} onRetry={log.reload} />;
  if (!log.data) return <Skeleton rows={2} />;
  return (
    <div className="mt-3 rounded-xl border border-ink/10">
      <div className="flex items-center justify-between px-3 py-2 text-[13px] text-ink-muted"><span>Last {log.data.items.length} of {log.data.total} submissions</span><button className="btn-ghost btn-sm" onClick={log.reload}><RefreshCw className="h-3.5 w-3.5" />Refresh</button></div>
      {!log.data.items.length ? <p className="px-3 pb-3 text-[13px] text-ink-muted">Nothing received yet.</p> : (
        <ul className="divide-y divide-ink/5 border-t border-ink/10 text-[13px]">
          {log.data.items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className={e.status === 'PROCESSED' ? 'pill-green' : e.status === 'FAILED' ? 'pill-danger' : e.status === 'SKIPPED' ? 'pill-amber' : 'pill-muted'}>{e.status === 'PROCESSED' ? 'Lead created' : e.status === 'SKIPPED' ? 'Repeat / ignored' : e.status === 'FAILED' ? 'Failed' : 'Processing'}</span>
              <span className="min-w-0 flex-1 truncate text-ink-soft" title={JSON.stringify(e.payload)}>{Object.entries(e.payload).slice(0, 4).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') || '(empty)'}</span>
              {e.lead && <Link href={`/leads/${e.lead.id}`} className="font-medium hover:underline">{e.lead.name}</Link>}
              {e.error && <span className="text-danger">{e.error}</span>}
              <span className="text-ink-muted">{fmtDateTime(e.createdAt)}</span>
              {e.status === 'FAILED' && <button className="btn-ghost btn-sm" onClick={() => retry(e)}>Retry</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Webhooks() {
  const { confirm, toast } = useUi();
  const { busy, run } = useSave();
  const list = useApi<Endpoint[]>('/webhook-endpoints');
  const types = useApi<string[]>('/webhook-events');
  const blank = { id: '', name: '', url: '', events: [] as string[] };
  const [f, setF] = useState<typeof blank | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [showLog, setShowLog] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>, ok: string) => run(() => fn().then(list.reload), ok);
  const toggleEvent = (t: string) => setF((s) => s && { ...s, events: s.events.includes(t) ? s.events.filter((x) => x !== t) : [...s.events, t] });

  return (
    <section className="card">
      <div className="card-pad pb-3">
        <h2 className="card-title">Webhooks</h2>
        <p className="text-ink-muted">Send a signed JSON message to your own system whenever something happens here. Failed deliveries are retried with increasing delays for up to a day, and every attempt is logged. Verify the <code>X-PowerMyCRM-Signature</code> header with HMAC-SHA256 of <code>timestamp.body</code> using the endpoint secret.</p>
      </div>
      {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} /> : !list.data ? <Skeleton rows={2} /> : (
        <ul className="divide-y divide-ink/5 border-y border-ink/10">
          {list.data.map((ep) => (
            <li key={ep.id} className="px-5 py-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{ep.name}</span>{!ep.active && <span className="pill-amber ml-2">Paused</span>}
                  <span className="block truncate text-[13px] text-ink-muted">{ep.url}</span>
                  <span className="block text-[13px] text-ink-muted">{ep.events.includes('*') ? 'All events' : ep.events.join(', ')} · {ep.deliveries.delivered} delivered · {ep.deliveries.pending} pending · {ep.deliveries.failed} failed{ep.lastDeliveryAt ? ` · last attempt ${relTime(ep.lastDeliveryAt)}${ep.lastStatus ? ` (HTTP ${ep.lastStatus})` : ''}` : ''}</span>
                </span>
                <button className="btn-ghost btn-sm" onClick={() => setShowLog(showLog === ep.id ? null : ep.id)}>{showLog === ep.id ? 'Hide log' : 'Delivery log'}</button>
                <button className="btn-ghost btn-sm" disabled={busy} onClick={async () => { try { await api(`/webhook-endpoints/${ep.id}/test`, { body: {} }); toast('Test event queued'); setTimeout(list.reload, 2000); } catch (e) { toast((e as Error).message, 'error'); } }}><Send className="h-3.5 w-3.5" />Send test</button>
                <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api(`/webhook-endpoints/${ep.id}`, { method: 'PATCH', body: { active: !ep.active } }), ep.active ? 'Webhook paused' : 'Webhook resumed')}>{ep.active ? 'Pause' : 'Resume'}</button>
                <button className="btn-icon" onClick={() => setF({ id: ep.id, name: ep.name, url: ep.url, events: ep.events })} aria-label={`Edit ${ep.name}`}><Pencil className="h-4 w-4" /></button>
                <button className="btn-icon" disabled={busy} aria-label={`Rotate secret for ${ep.name}`} title="Rotate secret" onClick={async () => { if (await confirm({ title: 'Rotate the signing secret?', text: 'Update your receiver with the new secret; the old one stops validating at once.', confirmLabel: 'Rotate' })) { try { const r = await api<{ secret: string }>(`/webhook-endpoints/${ep.id}/rotate-secret`, { body: {} }); setSecret(r.secret); } catch (e) { toast((e as Error).message, 'error'); } } }}><KeyRound className="h-4 w-4" /></button>
                <button className="btn-icon" disabled={busy} aria-label={`Delete ${ep.name}`} onClick={async () => { if (await confirm({ title: `Delete the webhook ${ep.name}?`, text: 'Pending deliveries are dropped.', confirmLabel: 'Delete', danger: true })) act(() => api(`/webhook-endpoints/${ep.id}`, { method: 'DELETE' }), 'Webhook deleted'); }}><Trash2 className="h-4 w-4" /></button>
              </div>
              {showLog === ep.id && <DeliveryLog endpointId={ep.id} />}
            </li>
          ))}
          {!list.data.length && <li className="px-5 py-6 text-center text-ink-muted">No webhooks yet.</li>}
        </ul>
      )}
      {f ? (
        <form className="grid gap-3 card-pad sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api<Endpoint & { secret?: string }>(f.id ? `/webhook-endpoints/${f.id}` : '/webhook-endpoints', { method: f.id ? 'PATCH' : 'POST', body: { name: f.name, url: f.url, events: f.events } });
            toast(f.id ? 'Webhook saved' : 'Webhook created');
            setF(null);
            list.reload();
            if (r.secret) setSecret(r.secret);
          } catch (err) { toast((err as Error).message, 'error'); }
        }}>
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus maxLength={80} placeholder="Zapier" /></Field>
          <Field label="URL"><input className="input" type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://hooks.example.com/powermycrm" required /></Field>
          <div className="sm:col-span-2">
            <span className="label">Events</span>
            <div className="flex flex-wrap gap-1.5">
              {['*', ...(types.data ?? [])].map((t) => (
                <button type="button" key={t} aria-pressed={f.events.includes(t)} onClick={() => toggleEvent(t)} className={f.events.includes(t) ? 'pill border border-ink bg-ink py-1 text-white' : 'pill border border-ink/15 py-1 text-ink-soft hover:border-ink/40'}>{t === '*' ? 'All events' : t}</button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 sm:col-span-2"><button className="btn-ink" disabled={busy || !f.name.trim() || !f.url.trim() || !f.events.length}>{f.id ? 'Save webhook' : 'Create webhook'}</button><button type="button" className="btn-ghost" onClick={() => setF(null)}>Cancel</button></div>
        </form>
      ) : <div className="card-pad"><button className="btn-ink" onClick={() => setF(blank)}><Webhook className="h-4 w-4" />Add webhook</button></div>}
      {secret && <Secret value={secret} onDone={() => setSecret(null)} title="Webhook signing secret" text="Copy this secret now. It is shown once; later you can only rotate it." />}
    </section>
  );
}

function DeliveryLog({ endpointId }: { endpointId: string }) {
  const { toast } = useUi();
  const log = useApi<{ items: Delivery[]; total: number }>(`/webhook-endpoints/${endpointId}/deliveries?pageSize=25`);
  const retry = async (d: Delivery) => { try { await api(`/webhook-deliveries/${d.id}/retry`, { body: {} }); toast('Delivery queued again'); setTimeout(log.reload, 2000); } catch (err) { toast((err as Error).message, 'error'); } };
  if (log.error) return <ErrorState message={log.error.message} onRetry={log.reload} />;
  if (!log.data) return <Skeleton rows={2} />;
  return (
    <div className="mt-3 rounded-xl border border-ink/10">
      <div className="flex items-center justify-between px-3 py-2 text-[13px] text-ink-muted"><span>Last {log.data.items.length} of {log.data.total} deliveries</span><button className="btn-ghost btn-sm" onClick={log.reload}><RefreshCw className="h-3.5 w-3.5" />Refresh</button></div>
      {!log.data.items.length ? <p className="px-3 pb-3 text-[13px] text-ink-muted">No deliveries yet.</p> : (
        <ul className="divide-y divide-ink/5 border-t border-ink/10 text-[13px]">
          {log.data.items.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className={d.status === 'DELIVERED' ? 'pill-green' : d.status === 'FAILED' ? 'pill-danger' : 'pill-amber'}>{d.status === 'DELIVERED' ? 'Delivered' : d.status === 'FAILED' ? 'Failed' : 'Retrying'}</span>
              <span className="font-medium">{d.eventType}</span>
              <span className="text-ink-muted">{d.attempts} attempt{d.attempts === 1 ? '' : 's'}{d.responseCode ? ` · HTTP ${d.responseCode}` : ''}{d.error ? ` · ${d.error}` : ''}</span>
              <span className="ml-auto text-ink-muted">{fmtDateTime(d.deliveredAt ?? d.createdAt)}</span>
              {d.status !== 'DELIVERED' && <button className="btn-ghost btn-sm" onClick={() => retry(d)}>Retry now</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApiKeys() {
  const { confirm, toast } = useUi();
  const { busy, run } = useSave();
  const list = useApi<ApiKey[]>('/api-keys');
  const [name, setName] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const apiBase = typeof window === 'undefined' ? '' : `${window.location.origin}/api/v1`;
  const curl = `curl -X POST ${apiBase}/public/leads \\
  -H "Authorization: Bearer pmc_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Asha Rao","phone":"9876543210","email":"asha@example.com","source":"Partner portal","message":"Interested in the annual plan"}'`;
  return (
    <section className="card">
      <div className="card-pad pb-3">
        <h2 className="card-title">API keys</h2>
        <p className="text-ink-muted">Create leads from your own software with a bearer key. Duplicates are matched on phone or email and new leads are assigned by your rules.</p>
      </div>
      {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} /> : !list.data ? <Skeleton rows={2} /> : (
        <ul className="divide-y divide-ink/5 border-y border-ink/10">
          {list.data.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span className="min-w-0 flex-1"><span className="font-medium">{k.name}</span>{k.revokedAt && <span className="pill-muted ml-2">Revoked</span>}<span className="block font-mono text-[12.5px] text-ink-muted">{k.prefix}…</span></span>
              <span className="text-[13px] text-ink-muted">{k.lastUsedAt ? `Last used ${relTime(k.lastUsedAt)}` : 'Never used'} · created {fmtDateTime(k.createdAt)}</span>
              {!k.revokedAt && <button className="btn-ghost btn-sm" disabled={busy} onClick={async () => { if (await confirm({ title: `Revoke the key ${k.name}?`, text: 'Requests using it will be rejected immediately.', confirmLabel: 'Revoke', danger: true })) run(() => api(`/api-keys/${k.id}`, { method: 'DELETE' }).then(list.reload), 'Key revoked'); }}>Revoke</button>}
            </li>
          ))}
          {!list.data.length && <li className="px-5 py-6 text-center text-ink-muted">No API keys yet.</li>}
        </ul>
      )}
      <form className="flex flex-wrap items-center gap-3 card-pad" onSubmit={async (e) => { e.preventDefault(); try { const r = await api<{ key: string }>('/api-keys', { body: { name } }); setName(''); list.reload(); setShown(r.key); } catch (err) { toast((err as Error).message, 'error'); } }}>
        <input className="input max-w-[260px]" placeholder="Key name (e.g. Website backend)" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Key name" />
        <button className="btn-ink" disabled={busy || !name.trim()}><Plus className="h-4 w-4" />Create key</button>
      </form>
      <div className="px-5 pb-5 text-[13px]">
        <p className="mb-1 font-medium text-ink-soft">Example</p>
        <div className="relative"><pre className="overflow-x-auto rounded-xl bg-ink p-3 text-[12px] text-white">{curl}</pre><span className="absolute right-2 top-2"><CopyButton text={curl} /></span></div>
        <p className="mt-2 text-ink-muted">Fields: name, phone, email, company, city, source, message, customFields, externalId, duplicateStrategy (skip, update or create) and ownerId (&ldquo;auto&rdquo;, a user id or null). The response gives the lead id and whether it was created, updated or matched to an existing lead.</p>
      </div>
      {shown && <Secret value={shown} onDone={() => setShown(null)} title="Your new API key" text="Copy this key now. It is shown once and cannot be retrieved later." />}
    </section>
  );
}
