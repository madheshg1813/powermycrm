'use client';
import { Check, CheckCheck, MessageCircle, Search, Send } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, EmptyState, ErrorState, Field, PageHeader, Skeleton, cx, useUi } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, relTime } from '@/lib/format';
import { useChanged, useRefs } from '@/lib/refs';

type Conv = { id: string; channel: 'whatsapp' | 'sms'; phone: string; unread: number; lastMessageAt: string; lastInboundAt: string | null; lead: { id: string; name: string; phone: string | null } | null; assignee: { id: string; name: string } | null; last: { body: string; direction: 'IN' | 'OUT'; createdAt: string; status: string } | null };
type Msg = { id: string; direction: 'IN' | 'OUT'; type: string; body: string; status: 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'RECEIVED'; error: string | null; templateName: string | null; createdAt: string; sender: { id: string; name: string } | null };
type Thread = Conv & { messages: Msg[]; windowOpen: boolean; windowClosesAt: string | null };
type Template = { id: string; name: string; language: string; status: string; body: string; variables: number };

function Receipt({ m }: { m: Msg }) {
  if (m.direction === 'IN') return null;
  if (m.status === 'FAILED') return <span className="text-danger" title={m.error ?? ''}>Failed</span>;
  if (m.status === 'READ') return <CheckCheck className="inline h-3.5 w-3.5 text-green" />;
  if (m.status === 'DELIVERED') return <CheckCheck className="inline h-3.5 w-3.5" />;
  if (m.status === 'SENT') return <Check className="inline h-3.5 w-3.5" />;
  return <span>…</span>;
}

/** WhatsApp and SMS threads with leads. Free-form WhatsApp replies are allowed within 24 hours of the customer's last message; otherwise a template is offered. */
export default function InboxPage() {
  const { me } = useAuth();
  const { connected } = useRefs();
  const { toast } = useUi();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => { setSelected(new URLSearchParams(window.location.search).get('conversation')); }, []);
  const list = useApi<{ items: Conv[]; total: number; unreadTotal: number }>(`/conversations${qs({ q, unread: unreadOnly ? 'true' : '', pageSize: 100 })}`);
  const thread = useApi<Thread>(selected ? `/conversations/${selected}` : null);
  const templates = useApi<Template[]>(connected.whatsapp ? '/message-templates' : null);
  const reloadAll = useCallback(() => { list.reload(); thread.reload(); }, [list, thread]);
  useChanged(reloadAll);
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === 'visible') reloadAll(); }, 20_000); return () => clearInterval(t); }, [reloadAll]);
  useEffect(() => { if (thread.data && thread.data.unread > 0) api(`/conversations/${thread.data.id}/read`, { body: {} }).then(() => list.reload()).catch(() => undefined); }, [thread.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const [text, setText] = useState('');
  const [tpl, setTpl] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [thread.data?.messages.length]);
  const chosen = templates.data?.find((t) => `${t.name}:${t.language}` === tpl);
  useEffect(() => { setParams(Array.from({ length: chosen?.variables ?? 0 }, () => '')); }, [chosen?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!thread.data) return;
    setBusy(true);
    try {
      if (thread.data.channel === 'whatsapp' && !thread.data.windowOpen) {
        if (!chosen) { toast('Choose a template: the 24-hour window for free-form replies has closed.', 'error'); return; }
        await api(`/conversations/${thread.data.id}/messages`, { body: { templateName: chosen.name, language: chosen.language, params } });
      } else {
        await api(`/conversations/${thread.data.id}/messages`, { body: { text } });
      }
      setText('');
      reloadAll();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  }

  if (!me) return null;
  if (!connected.whatsapp && !connected.sms_http) {
    return <div className="mx-auto max-w-[1240px]"><PageHeader title="Inbox" /><div className="card"><EmptyState icon={MessageCircle} title="No messaging channel is connected" text="Connect WhatsApp Cloud API or an SMS gateway under Settings → Integrations to message leads from here." action={<Link href="/settings?tab=integrations" className="btn-ink">Open integrations</Link>} /></div></div>;
  }
  const t = thread.data;
  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader title="Inbox" subtitle={list.data ? `${list.data.total} conversation${list.data.total === 1 ? '' : 's'} · ${list.data.unreadTotal} unread` : undefined} />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <section className="card flex max-h-[75vh] flex-col overflow-hidden">
          <div className="space-y-2 border-b border-ink/10 p-3">
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" /><input className="input pl-9" placeholder="Name or number…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search conversations" /></div>
            <label className="flex cursor-pointer items-center gap-2 text-[13px]"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />Unread only</label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.error ? <ErrorState message={list.error.message} onRetry={list.reload} /> : !list.data ? <Skeleton rows={5} /> : !list.data.items.length ? <EmptyState icon={MessageCircle} title="No conversations yet" text="Open one from a lead's page with the WhatsApp or SMS button." /> : (
              <ul className="divide-y divide-ink/5">
                {list.data.items.map((c) => (
                  <li key={c.id}>
                    <button className={cx('flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-cream/60', selected === c.id && 'bg-cream')} onClick={() => setSelected(c.id)}>
                      <Avatar name={c.lead?.name ?? c.phone} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2"><span className={cx('truncate', c.unread ? 'font-semibold' : 'font-medium')}>{c.lead?.name ?? c.phone}</span><span className="shrink-0 text-[11px] text-ink-muted">{relTime(c.lastMessageAt)}</span></span>
                        <span className="flex items-center gap-1.5 text-[12.5px] text-ink-muted"><span className="pill-muted px-1.5 py-0 text-[10px] uppercase">{c.channel}</span><span className="truncate">{c.last ? `${c.last.direction === 'OUT' ? 'You: ' : ''}${c.last.body}` : 'No messages yet'}</span></span>
                      </span>
                      {c.unread > 0 && <span className="pill bg-brand text-white">{c.unread}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="card flex max-h-[75vh] min-h-[420px] flex-col overflow-hidden">
          {!selected ? <EmptyState icon={MessageCircle} title="Pick a conversation" text="Messages you send and receive appear here and on the lead's timeline." />
            : thread.error ? <ErrorState message={thread.error.message} onRetry={thread.reload} />
            : !t ? <Skeleton rows={6} /> : (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-ink/10 px-4 py-3">
                <Avatar name={t.lead?.name ?? t.phone} size={32} />
                <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{t.lead ? <Link href={`/leads/${t.lead.id}`} className="hover:underline">{t.lead.name}</Link> : 'Unknown number'}</span><span className="text-[12.5px] text-ink-muted">+{t.phone} · {t.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}{t.channel === 'whatsapp' ? (t.windowOpen ? ` · reply window open until ${fmtDateTime(t.windowClosesAt)}` : ' · reply window closed: send a template') : ' · one-way'}</span></span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-cream/50 px-4 py-3">
                {t.messages.map((m) => (
                  <div key={m.id} className={cx('flex', m.direction === 'OUT' ? 'justify-end' : 'justify-start')}>
                    <div className={cx('max-w-[78%] rounded-2xl px-3.5 py-2 text-[13.5px] shadow-sm', m.direction === 'OUT' ? 'bg-ink text-white' : 'bg-white text-ink')}>
                      {m.templateName && <span className={cx('mb-0.5 block text-[10.5px] uppercase tracking-wide', m.direction === 'OUT' ? 'text-white/60' : 'text-ink-muted')}>Template · {m.templateName}</span>}
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      <p className={cx('mt-1 flex items-center justify-end gap-1 text-[10.5px]', m.direction === 'OUT' ? 'text-white/60' : 'text-ink-muted')}>{m.sender?.name ? `${m.sender.name} · ` : ''}{fmtDateTime(m.createdAt)} <Receipt m={m} /></p>
                    </div>
                  </div>
                ))}
                <div ref={bottom} />
              </div>
              <form className="border-t border-ink/10 p-3" onSubmit={send}>
                {t.channel === 'whatsapp' && !t.windowOpen ? (
                  <div className="space-y-2">
                    <Field label="Approved template"><select className="input" value={tpl} onChange={(e) => setTpl(e.target.value)}><option value="">Choose…</option>{templates.data?.filter((x) => x.status === 'APPROVED').map((x) => <option key={x.id} value={`${x.name}:${x.language}`}>{x.name} ({x.language})</option>)}</select></Field>
                    {chosen && <p className="rounded-xl bg-cream px-3 py-2 text-[13px] text-ink-soft">{chosen.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`)}</p>}
                    {chosen && params.map((p, i) => <input key={i} className="input" placeholder={`Value for {{${i + 1}}}`} value={p} onChange={(e) => setParams(params.map((x, j) => (j === i ? e.target.value : x)))} />)}
                    <div className="flex items-center justify-between"><span className="text-[12px] text-ink-muted">{templates.data?.some((x) => x.status === 'APPROVED') ? 'Templates come from your WhatsApp Business Account (sync under Settings → Integrations).' : 'No approved templates synced yet. Sync them under Settings → Integrations.'}</span><button className="btn-primary" disabled={busy || !chosen || params.some((p) => !p.trim())}><Send className="h-4 w-4" />Send template</button></div>
                  </div>
                ) : (
                  <div className="flex items-end gap-2">
                    <textarea className="input min-h-[44px]" rows={2} placeholder={t.channel === 'sms' ? 'SMS text…' : 'Reply…'} value={text} onChange={(e) => setText(e.target.value)} maxLength={t.channel === 'sms' ? 480 : 4096} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send(e); }} />
                    <button className="btn-primary" disabled={busy || !text.trim()}><Send className="h-4 w-4" />Send</button>
                  </div>
                )}
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
