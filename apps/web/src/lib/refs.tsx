'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';

export type Stage = { id: string; name: string; color: string; type: 'OPEN' | 'WON' | 'LOST'; position: number; leads: number; pipelineId: string };
export type Pipeline = { id: string; name: string; isDefault: boolean; stages: Stage[] };
export type Source = { id: string; name: string; leads: number };
export type Label = { id: string; name: string; color: string; leads: number };
export type Member = {
  membershipId: string; id: string; name: string; status: 'ACTIVE' | 'DEACTIVATED';
  role: { id: string; name: string; systemKey: string | null }; team: { id: string; name: string } | null;
  email?: string; phone?: string | null; joinedAt?: string;
};
export type CustomField = { id: string; key: string; label: string; type: 'TEXT' | 'LONG_TEXT' | 'NUMBER' | 'DATE' | 'DROPDOWN' | 'MULTI_SELECT' | 'CHECKBOX' | 'URL' | 'EMAIL' | 'PHONE'; options: string[]; required: boolean };
export const FIELD_TYPES: Record<CustomField['type'], string> = {
  TEXT: 'Text', LONG_TEXT: 'Long text', NUMBER: 'Number', DATE: 'Date', DROPDOWN: 'Dropdown', MULTI_SELECT: 'Multi-select', CHECKBOX: 'Checkbox', URL: 'Link', EMAIL: 'Email', PHONE: 'Phone',
};
export type Lead = {
  customFields: Record<string, any>;
  id: string; name: string; phone: string | null; email: string | null; company: string | null; city: string | null;
  score: number; dealValue: number | null; expectedCloseAt: string | null; lostReason: string | null;
  stageId: string; pipelineId: string; sourceId: string | null; ownerId: string | null;
  stage: { id: string; name: string; color: string; type: 'OPEN' | 'WON' | 'LOST' };
  source: { id: string; name: string } | null; owner: { id: string; name: string } | null;
  labels: { id: string; name: string; color: string }[];
  archivedAt: string | null; createdAt: string; updatedAt: string; lastActivityAt: string; stageEnteredAt: string;
};
export type Task = {
  id: string; title: string; type: string; dueAt: string; priority: 'LOW' | 'MEDIUM' | 'HIGH'; status: 'OPEN' | 'DONE' | 'CANCELLED';
  notes: string | null; leadId: string | null; assigneeId: string; completedAt: string | null;
  lead?: { id: string; name: string; phone: string | null } | null; assignee?: { id: string; name: string };
};

type Refs = { pipelines: Pipeline[]; sources: Source[]; labels: Label[]; members: Member[]; fields: CustomField[]; ready: boolean; reload: () => Promise<void> };
const RefsContext = createContext<Refs | null>(null);

/** Reference lists every screen needs (stages, sources, labels, users), loaded once per workspace. */
export function RefsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Omit<Refs, 'reload'>>({ pipelines: [], sources: [], labels: [], members: [], fields: [], ready: false });
  const reload = useCallback(async () => {
    const [pipelines, sources, labels, members, fields] = await Promise.all([
      api<Pipeline[]>('/pipelines'), api<Source[]>('/sources'), api<Label[]>('/labels'), api<Member[]>('/users'), api<CustomField[]>('/custom-fields'),
    ]);
    setState({ pipelines, sources, labels, members, fields, ready: true });
  }, []);
  useEffect(() => {
    reload().catch(() => setState((s) => ({ ...s, ready: true })));
  }, [reload]);
  return <RefsContext.Provider value={{ ...state, reload }}>{children}</RefsContext.Provider>;
}

export function useRefs() {
  const ctx = useContext(RefsContext);
  if (!ctx) throw new Error('useRefs must be used inside RefsProvider');
  return ctx;
}

/** Lets any screen refresh when a record is created from the global quick-add. */
export const emitChanged = () => window.dispatchEvent(new Event('pmc:changed'));
export function useChanged(fn: () => void) {
  useEffect(() => {
    window.addEventListener('pmc:changed', fn);
    return () => window.removeEventListener('pmc:changed', fn);
  }, [fn]);
}

export const TASK_TYPES: Record<string, string> = {
  FOLLOW_UP: 'Follow-up', CALLBACK: 'Callback', MEETING: 'Meeting', DEMO: 'Demo', SITE_VISIT: 'Site visit', TASK: 'Task',
};
