'use client';
import { Columns3 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Avatar, ColorDot, ErrorState, PageHeader, Skeleton, cx, useUi } from '@/components/ui';
import { api, qs, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money, relTime } from '@/lib/format';
import { Lead, useChanged, useRefs } from '@/lib/refs';

const LIMIT = 200;

export default function PipelinePage() {
  const { me, can } = useAuth();
  const { pipelines, members, ready, reload: reloadRefs } = useRefs();
  const { toast } = useUi();
  const [pipelineId, setPipelineId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  useEffect(() => {
    if (!pipelineId && pipelines.length) setPipelineId(pipelines[0].id);
  }, [pipelines, pipelineId]);

  const pipeline = pipelines.find((p) => p.id === pipelineId);
  const list = useApi<{ items: Lead[]; total: number }>(pipelineId ? `/leads${qs({ pipelineId, ownerId, pageSize: LIMIT, sort: 'lastActivityAt', dir: 'desc' })}` : null);
  useChanged(list.reload);
  const canMove = can('leads.edit');
  const cur = me?.organisation.currency;

  const byStage = useMemo(() => {
    const m = new Map<string, Lead[]>();
    for (const l of list.data?.items ?? []) m.set(l.stageId, [...(m.get(l.stageId) ?? []), l]);
    return m;
  }, [list.data]);

  async function move(leadId: string, stageId: string) {
    const lead = list.data?.items.find((l) => l.id === leadId);
    const stage = pipeline?.stages.find((s) => s.id === stageId);
    if (!lead || !stage || lead.stageId === stageId) return;
    const previous = list.data!;
    // Move the card at once, then confirm with the server; put it back if the save fails.
    list.setData({ ...previous, items: previous.items.map((l) => (l.id === leadId ? { ...l, stageId, stage: { id: stage.id, name: stage.name, color: stage.color, type: stage.type } } : l)) });
    try {
      await api(`/leads/${leadId}`, { method: 'PATCH', body: { stageId } });
      toast(`${lead.name} moved to ${stage.name}`);
      reloadRefs();
    } catch (e) {
      list.setData(previous);
      toast((e as Error).message, 'error');
    }
  }

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      <PageHeader
        title="Pipeline"
        subtitle={list.data ? `${list.data.total.toLocaleString('en-IN')} lead${list.data.total === 1 ? '' : 's'}${list.data.total > LIMIT ? `, showing the ${LIMIT} most recently active` : ''}` : undefined}
        actions={
          <>
            {pipelines.length > 1 && (
              <select className="input w-auto" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} aria-label="Pipeline">
                {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            {me?.role.scope !== 'OWN' && (
              <select className="input w-auto" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner">
                <option value="">All owners</option><option value="me">My leads</option><option value="unassigned">Unassigned</option>
                {members.filter((m) => m.id !== me?.user.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
          </>
        }
      />

      {list.error ? <div className="card"><ErrorState message={list.error.message} onRetry={list.reload} /></div>
        : !ready || !list.data || !pipeline ? <div className="card"><Skeleton rows={6} /></div>
        : (
          <div className="-mx-3 flex min-h-0 flex-1 gap-3 overflow-x-auto px-3 pb-2 sm:-mx-6 sm:px-6">
            {pipeline.stages.map((s) => {
              const cards = byStage.get(s.id) ?? [];
              const value = cards.reduce((a, l) => a + (l.dealValue ?? 0), 0);
              return (
                <section
                  key={s.id}
                  aria-label={`${s.name}, ${cards.length} leads`}
                  onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(s.id); } }}
                  onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
                  onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); setOver(null); setDragging(null); if (id) move(id, s.id); }}
                  className={cx('flex w-[272px] shrink-0 flex-col rounded-2xl border bg-white/60 transition', over === s.id ? 'border-ink bg-white' : 'border-ink/10')}
                >
                  <header className="flex items-center justify-between gap-2 px-3.5 pb-2 pt-3">
                    <span className="flex min-w-0 items-center gap-2 font-display font-bold"><ColorDot color={s.color} /><span className="truncate">{s.name}</span></span>
                    <span className="pill-muted">{cards.length}</span>
                  </header>
                  <p className="px-3.5 pb-2 text-xs text-ink-muted">{value ? money(value, cur) : 'No deal value'}</p>
                  <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                    {cards.map((l) => (
                      <article
                        key={l.id}
                        draggable={canMove}
                        onDragStart={(e) => { e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; setDragging(l.id); }}
                        onDragEnd={() => { setDragging(null); setOver(null); }}
                        className={cx('card p-3 shadow-sm transition', canMove && 'cursor-grab active:cursor-grabbing', dragging === l.id && 'opacity-40')}
                      >
                        <Link href={`/leads/${l.id}`} className="block truncate font-semibold hover:underline" draggable={false}>{l.name}</Link>
                        <p className="truncate text-[12.5px] text-ink-muted">{l.company || l.phone || l.email || 'No contact details'}</p>
                        <div className="mt-2.5 flex items-center justify-between gap-2 text-xs text-ink-muted">
                          <span className="font-semibold text-ink">{l.dealValue === null ? '' : money(l.dealValue, cur)}</span>
                          <span className="flex items-center gap-1.5">{relTime(l.lastActivityAt)}{l.owner && <Avatar name={l.owner.name} size={20} />}</span>
                        </div>
                        {canMove && (
                          <select className="input mt-2.5 py-1 text-xs lg:hidden" value={l.stageId} onChange={(e) => move(l.id, e.target.value)} aria-label={`Move ${l.name} to stage`}>
                            {pipeline.stages.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </select>
                        )}
                      </article>
                    ))}
                    {!cards.length && <p className="flex flex-col items-center gap-1.5 px-3 py-8 text-center text-xs text-ink-faint"><Columns3 className="h-4 w-4" />{canMove ? 'Drop a lead here' : 'No leads'}</p>}
                  </div>
                </section>
              );
            })}
          </div>
        )}
    </div>
  );
}
