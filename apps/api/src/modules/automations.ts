import { BadRequestException, Body, Controller, Delete, Get, Injectable, Logger, NotFoundException, OnModuleInit, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, pageSchema, parse } from '../common/core';
import { ALL_PERMISSION_KEYS } from '../common/permissions';
import { QueueService } from '../common/queue';
import { PlanService } from './admin';
import { EmailService, layout } from './email';
import { LeadsService } from './leads';

export const TRIGGERS = [
  { key: 'lead.created', label: 'Lead created' },
  { key: 'lead.stage_changed', label: 'Lead moved to a stage' },
  { key: 'lead.assigned', label: 'Lead assigned' },
  { key: 'lead.archived', label: 'Lead archived' },
  { key: 'opportunity.won', label: 'Deal won' },
  { key: 'opportunity.lost', label: 'Deal lost' },
  { key: 'payment.received', label: 'Payment received' },
  { key: 'task.completed', label: 'Follow-up completed' },
  { key: 'call.logged', label: 'Call logged' },
] as const;
export const CONDITION_FIELDS = [
  { key: 'source', label: 'Source', kind: 'source' }, { key: 'stage', label: 'Stage', kind: 'stage' }, { key: 'stageType', label: 'Stage type (open/won/lost)', kind: 'stageType' },
  { key: 'owner', label: 'Owner', kind: 'owner' }, { key: 'label', label: 'Label', kind: 'label' }, { key: 'city', label: 'City', kind: 'text' }, { key: 'company', label: 'Company', kind: 'text' },
  { key: 'dealValue', label: 'Deal value', kind: 'number' }, { key: 'score', label: 'Score', kind: 'number' }, { key: 'via', label: 'Created via (app, import, website_form, api)', kind: 'text' },
  { key: 'fromStage', label: 'Previous stage (stage changes)', kind: 'stage' }, { key: 'amount', label: 'Amount (deals, payments)', kind: 'number' }, { key: 'disposition', label: 'Call outcome (calls)', kind: 'text' },
] as const;
export const OPS = ['is', 'is_not', 'contains', 'not_contains', 'gt', 'lt', 'is_set', 'is_empty'] as const;
export const STEP_TYPES = [
  { key: 'assign', label: 'Assign owner' }, { key: 'move_stage', label: 'Move to stage' }, { key: 'add_label', label: 'Add label' }, { key: 'remove_label', label: 'Remove label' },
  { key: 'add_to_list', label: 'Add to list' }, { key: 'create_task', label: 'Create follow-up' }, { key: 'send_email', label: 'Send email' }, { key: 'notify', label: 'Notify a user' },
  { key: 'webhook', label: 'Call a webhook URL' }, { key: 'update_field', label: 'Update a field' }, { key: 'archive', label: 'Archive the lead' }, { key: 'wait', label: 'Wait' },
] as const;

const conditionSchema = z.object({ field: z.string().min(1).max(60), op: z.enum(OPS), value: z.string().max(300).optional() });
const stepSchema = z.object({ type: z.enum(STEP_TYPES.map((s) => s.key) as [string, ...string[]]) }).passthrough();
const automationSchema = z.object({
  name: z.string().trim().min(1, 'Name the automation').max(100),
  description: z.string().trim().max(500).transform((v) => v || null).nullable().optional(),
  trigger: z.enum(TRIGGERS.map((t) => t.key) as [string, ...string[]]),
  conditions: z.array(conditionSchema).max(20).default([]),
  steps: z.array(stepSchema).min(1, 'Add at least one step').max(20),
  active: z.boolean().default(true),
});
type Step = z.infer<typeof stepSchema> & Record<string, unknown>;
type LogEntry = { at: string; step: number; type: string; result: string };
const leadInclude = { stage: true, source: true, owner: { select: { id: true, name: true, email: true } }, labels: { include: { label: true } } } satisfies Prisma.LeadInclude;
type LeadRow = Prisma.LeadGetPayload<{ include: typeof leadInclude }>;

/** Everything the automation performs is attributed to its creator (or, failing that, the workspace owner), with full permissions and ALL scope. */
async function systemCtx(prisma: PrismaService, orgId: string, preferredUserId: string | null): Promise<Ctx> {
  const m = (preferredUserId && (await prisma.membership.findFirst({ where: { organisationId: orgId, userId: preferredUserId, status: 'ACTIVE' } })))
    || (await prisma.membership.findFirst({ where: { organisationId: orgId, status: 'ACTIVE', role: { systemKey: 'owner' } } }))
    || (await prisma.membership.findFirst({ where: { organisationId: orgId, status: 'ACTIVE' } }));
  if (!m) throw new Error('The workspace has no active member to act as');
  return { userId: m.userId, orgId, sessionId: 'automation', roleId: m.roleId, roleKey: 'owner', scope: 'ALL', teamId: null, perms: new Set(ALL_PERMISSION_KEYS) };
}

function fill(template: string, lead: LeadRow | null, org: { name: string }) {
  const map: Record<string, string> = {
    'lead.name': lead?.name ?? '', 'lead.phone': lead?.phone ?? '', 'lead.email': lead?.email ?? '', 'lead.company': lead?.company ?? '', 'lead.city': lead?.city ?? '',
    'lead.owner': lead?.owner?.name ?? '', 'lead.stage': lead?.stage.name ?? '', 'lead.source': lead?.source?.name ?? '', 'lead.url': lead ? `${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}/leads/${lead.id}` : '',
    'org.name': org.name,
  };
  return template.replace(/\{\{\s*([a-z.]+)\s*\}\}/gi, (_, k) => map[k.toLowerCase()] ?? '');
}

/** Evaluates one condition against the lead and the event payload. Unknown fields never match. */
export function matches(c: z.infer<typeof conditionSchema>, lead: LeadRow | null, payload: Record<string, any>): boolean {
  let actual: unknown;
  switch (c.field) {
    case 'source': actual = lead?.sourceId ?? null; break;
    case 'stage': actual = lead?.stageId ?? null; break;
    case 'stageType': actual = lead?.stage.type.toLowerCase() ?? null; break;
    case 'owner': actual = lead?.ownerId ?? 'unassigned'; break;
    case 'label': actual = lead?.labels.map((l) => l.labelId) ?? []; break;
    case 'city': actual = lead?.city ?? null; break;
    case 'company': actual = lead?.company ?? null; break;
    case 'dealValue': actual = lead?.dealValue === null || lead?.dealValue === undefined ? null : Number(lead.dealValue); break;
    case 'score': actual = lead?.score ?? null; break;
    case 'via': actual = payload.via ?? null; break;
    case 'fromStage': actual = payload.from?.id ?? null; break;
    case 'amount': actual = payload.payment?.amount ?? payload.opportunity?.value ?? null; break;
    case 'disposition': actual = payload.call?.disposition ?? null; break;
    default: {
      if (!c.field.startsWith('cf_')) return false;
      actual = (lead?.customFields as Record<string, unknown> | null)?.[c.field.slice(3)] ?? null;
    }
  }
  const empty = actual === null || actual === undefined || actual === '' || (Array.isArray(actual) && !actual.length);
  const v = (c.value ?? '').trim();
  const str = (x: unknown) => String(x ?? '').toLowerCase();
  const has = (x: unknown) => (Array.isArray(x) ? x.map(str).includes(v.toLowerCase()) : str(x) === v.toLowerCase());
  switch (c.op) {
    case 'is_set': return !empty;
    case 'is_empty': return empty;
    case 'is': return !empty && has(actual);
    case 'is_not': return empty || !has(actual);
    case 'contains': return !empty && str(Array.isArray(actual) ? actual.join(' ') : actual).includes(v.toLowerCase());
    case 'not_contains': return empty || !str(Array.isArray(actual) ? actual.join(' ') : actual).includes(v.toLowerCase());
    case 'gt': return !empty && Number(actual) > Number(v);
    case 'lt': return !empty && Number(actual) < Number(v);
  }
}

/**
 * Workflow automation: when a trigger event happens and every condition holds, the steps run in order on the lead.
 * "Wait" steps park the run and resume through the queue. The same automation does not run twice on one lead within ten minutes.
 */
@Injectable()
export class AutomationsService implements OnModuleInit {
  private readonly log = new Logger('Automations');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly leads: LeadsService,
    private readonly email: EmailService,
  ) {}

  onModuleInit() {
    this.queue.work<{ automationId: string; eventId: string }>('automation.run', async (d) => { await this.start(d.automationId, d.eventId); }, { retryLimit: 2, retryDelay: 30 });
    this.queue.work<{ runId: string }>('automation.resume', async ({ runId }) => { await this.execute(runId); }, { retryLimit: 2, retryDelay: 30 });
  }

  static leadIdFrom(payload: Record<string, any>): string | null {
    return payload.lead?.id ?? payload.opportunity?.leadId ?? payload.payment?.leadId ?? payload.task?.leadId ?? null;
  }

  /** Entry point from the outbox: creates the run, checks the ten-minute guard and conditions, then executes. */
  async start(automationId: string, eventId: string, manual = false) {
    const [a, event] = await Promise.all([this.prisma.automation.findUnique({ where: { id: automationId } }), this.prisma.outboxEvent.findUnique({ where: { id: eventId } })]);
    if (!a || !event || a.organisationId !== event.organisationId || (!manual && (!a.active || a.trigger !== event.type))) return null;
    const payload = event.payload as Record<string, any>;
    const leadId = AutomationsService.leadIdFrom(payload);
    if (!manual && leadId) {
      const recent = await this.prisma.automationRun.findFirst({ where: { automationId, leadId, startedAt: { gt: new Date(Date.now() - 10 * 60_000) }, status: { in: ['RUNNING', 'WAITING', 'DONE'] } } });
      if (recent) {
        return this.prisma.automationRun.create({ data: { organisationId: a.organisationId, automationId, leadId, eventId, status: 'SKIPPED', log: [{ at: new Date().toISOString(), step: 0, type: 'guard', result: 'Already ran for this lead in the last 10 minutes' }], finishedAt: new Date() } });
      }
    }
    const lead = leadId ? await this.prisma.lead.findFirst({ where: { id: leadId, organisationId: a.organisationId }, include: leadInclude }) : null;
    const conditions = (a.conditions as z.infer<typeof conditionSchema>[]) ?? [];
    const failed = conditions.find((c) => !matches(c, lead, payload));
    const run = await this.prisma.automationRun.create({
      data: {
        organisationId: a.organisationId, automationId, leadId, eventId,
        status: failed ? 'SKIPPED' : 'RUNNING',
        log: failed ? [{ at: new Date().toISOString(), step: 0, type: 'conditions', result: `Condition not met: ${failed.field} ${failed.op} ${failed.value ?? ''}`.trim() }] : [],
        finishedAt: failed ? new Date() : null,
      },
    });
    if (failed) return run;
    return this.execute(run.id);
  }

  async execute(runId: string) {
    const run = await this.prisma.automationRun.findUnique({ where: { id: runId }, include: { automation: true, event: true } });
    if (!run || run.status === 'DONE' || run.status === 'FAILED' || run.status === 'SKIPPED') return run;
    const a = run.automation;
    const steps = (a.steps as Step[]) ?? [];
    const log = [...((run.log as LogEntry[]) ?? [])];
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: a.organisationId }, select: { name: true } });
    const payload = (run.event?.payload ?? {}) as Record<string, any>;
    let ctx: Ctx;
    try { ctx = await systemCtx(this.prisma, a.organisationId, a.createdById); }
    catch (e) { return this.finish(runId, log, 'FAILED', (e as Error).message); }

    for (let i = run.step; i < steps.length; i++) {
      const step = steps[i];
      const lead = run.leadId ? await this.prisma.lead.findFirst({ where: { id: run.leadId, organisationId: a.organisationId }, include: leadInclude }) : null;
      if (!lead && step.type !== 'webhook' && step.type !== 'notify' && step.type !== 'wait') {
        log.push({ at: new Date().toISOString(), step: i, type: step.type, result: 'Skipped: no lead on this event' });
        continue;
      }
      try {
        if (step.type === 'wait') {
          const seconds = Number(step.seconds ?? 0) + Number(step.minutes ?? 0) * 60 + Number(step.hours ?? 0) * 3600 + Number(step.days ?? 0) * 86400;
          log.push({ at: new Date().toISOString(), step: i, type: 'wait', result: `Waiting ${seconds} seconds` });
          await this.prisma.automationRun.update({ where: { id: runId }, data: { status: 'WAITING', step: i + 1, log: log as Prisma.InputJsonValue, resumeAt: new Date(Date.now() + seconds * 1000) } });
          await this.queue.send('automation.resume', { runId }, { singletonKey: `${runId}:${i}`, startAfter: Math.max(0, Math.round(seconds)) });
          return this.prisma.automationRun.findUnique({ where: { id: runId } });
        }
        const result = await this.perform(step, ctx, lead!, payload, org);
        log.push({ at: new Date().toISOString(), step: i, type: step.type, result });
        await this.prisma.automationRun.update({ where: { id: runId }, data: { step: i + 1, log: log as Prisma.InputJsonValue } });
      } catch (e) {
        const message = (e as { response?: { message?: string } }).response?.message ?? (e as Error).message;
        log.push({ at: new Date().toISOString(), step: i, type: step.type, result: `Failed: ${message}` });
        return this.finish(runId, log, 'FAILED', message);
      }
    }
    const done = await this.finish(runId, log, 'DONE', null);
    await this.prisma.automation.update({ where: { id: a.id }, data: { runs: { increment: 1 }, lastRunAt: new Date() } });
    if (run.leadId) await this.prisma.leadActivity.create({ data: { organisationId: a.organisationId, leadId: run.leadId, actorId: null, type: 'automation_ran', data: { id: a.id, name: a.name, steps: steps.length } } }).catch(() => undefined);
    return done;
  }

  private finish(runId: string, log: LogEntry[], status: 'DONE' | 'FAILED', error: string | null) {
    if (status === 'FAILED') this.log.warn(`Automation run ${runId} failed: ${error}`);
    return this.prisma.automationRun.update({ where: { id: runId }, data: { status, log: log as Prisma.InputJsonValue, error, finishedAt: new Date() } });
  }

  /** One step. Returns a short description of what happened for the run log. */
  private async perform(step: Step, ctx: Ctx, lead: LeadRow, payload: Record<string, any>, org: { name: string }): Promise<string> {
    const s = (k: string) => String(step[k] ?? '').trim();
    switch (step.type) {
      case 'assign': {
        const target = s('ownerId');
        if (target === 'auto') {
          const dist = await this.leads.distributor(ctx.orgId);
          const next = dist.next(lead.sourceId);
          if (!next) return 'No assignment rule matched; owner unchanged';
          await this.prisma.$transaction(async (tx) => { await dist.flush(tx); });
          await this.leads.update(ctx, lead.id, { ownerId: next });
          return `Assigned by rule`;
        }
        await this.leads.update(ctx, lead.id, { ownerId: target === 'unassigned' || !target ? null : target });
        return target === 'unassigned' || !target ? 'Unassigned' : 'Assigned';
      }
      case 'move_stage': {
        if (lead.stageId === s('stageId')) return 'Already in that stage';
        const r = await this.leads.update(ctx, lead.id, { stageId: s('stageId') });
        return `Moved to ${r.stage.name}`;
      }
      case 'add_label': await this.leads.bulk(ctx, { ids: [lead.id], action: 'addLabel', value: s('labelId') }); return 'Label added';
      case 'remove_label': await this.leads.bulk(ctx, { ids: [lead.id], action: 'removeLabel', value: s('labelId') }); return 'Label removed';
      case 'add_to_list': await this.leads.bulk(ctx, { ids: [lead.id], action: 'addToList', value: s('listId') }); return 'Added to list';
      case 'archive': await this.leads.bulk(ctx, { ids: [lead.id], action: 'archive' }); return 'Archived';
      case 'update_field': {
        const field = s('field'), value = s('value');
        const body: Record<string, unknown> = field.startsWith('cf_') ? { customFields: { [field.slice(3)]: value || null } } : { [field]: ['score', 'dealValue'].includes(field) ? Number(value) : value || null };
        if (!['score', 'dealValue', 'city', 'company', 'lostReason'].includes(field) && !field.startsWith('cf_')) throw new Error(`Field "${field}" cannot be updated by an automation`);
        await this.leads.update(ctx, lead.id, body);
        return `Set ${field}`;
      }
      case 'create_task': {
        const assigneeId = s('assignee') === 'owner' || !s('assignee') ? lead.ownerId ?? ctx.userId : s('assignee');
        const member = await this.prisma.membership.findFirst({ where: { organisationId: ctx.orgId, userId: assigneeId, status: 'ACTIVE' } });
        const who = member ? assigneeId : ctx.userId;
        const dueAt = new Date(Date.now() + Number(step.dueInHours ?? 24) * 3600e3);
        const title = fill(s('title') || 'Follow up with {{lead.name}}', lead, org);
        await this.prisma.$transaction(async (tx) => {
          const task = await tx.task.create({ data: { organisationId: ctx.orgId, title, type: (s('taskType') || 'FOLLOW_UP') as any, dueAt, priority: (s('priority') || 'MEDIUM') as any, leadId: lead.id, assigneeId: who, createdById: ctx.userId } });
          await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: lead.id, actorId: ctx.userId, type: 'task_created', data: { title: task.title, type: task.type, dueAt: task.dueAt, automation: true } } });
          await tx.notification.create({ data: { organisationId: ctx.orgId, userId: who, type: 'task.assigned', title: `New task: ${title}`, link: `/leads/${lead.id}` } });
        });
        return `Follow-up "${title}" created`;
      }
      case 'notify': {
        const target = s('userId') === 'owner' || !s('userId') ? lead.ownerId : s('userId');
        if (!target) return 'Skipped: the lead has no owner to notify';
        await this.prisma.notification.create({ data: { organisationId: ctx.orgId, userId: target, type: 'automation', title: fill(s('title') || 'Automation: {{lead.name}}', lead, org), link: `/leads/${lead.id}` } });
        return 'Notification sent';
      }
      case 'send_email': {
        const to = s('to') === 'owner' ? lead.owner?.email ?? '' : s('to') === 'custom' ? s('email') : lead.email ?? '';
        if (!to) return `Skipped: no email address for "${s('to') || 'lead'}"`;
        const subject = fill(s('subject') || 'Message from {{org.name}}', lead, org);
        const text = fill(s('body'), lead, org);
        const r = await this.email.send({ organisationId: ctx.orgId, userId: null, kind: 'automation', to, subject, text, html: layout(subject, text.split(/\n{2,}/)) });
        return r.willSend ? `Email queued to ${to}` : `Email recorded but not sent: no email connection`;
      }
      case 'webhook': {
        const url = s('url');
        if (!/^https?:\/\//i.test(url)) throw new Error('Webhook step needs an http(s) URL');
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'PowerMyCRM-Automation/1.0' }, body: JSON.stringify({ automation: true, lead: { id: lead.id, name: lead.name, phone: lead.phone, email: lead.email, stage: lead.stage.name, owner: lead.owner?.name ?? null }, event: payload }), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`Webhook answered HTTP ${res.status}`);
        return `Webhook answered HTTP ${res.status}`;
      }
      default:
        throw new Error(`Unknown step type "${step.type}"`);
    }
  }
}

@Controller('automations')
export class AutomationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: AutomationsService,
    private readonly leads: LeadsService,
    private readonly plans: PlanService,
  ) {}

  private async find(ctx: Ctx, id: string) {
    const a = await this.prisma.automation.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!a) throw new NotFoundException('Automation not found');
    return a;
  }

  /** Validates every id a step or condition refers to against the workspace. */
  private async checkRefs(ctx: Ctx, d: z.infer<typeof automationSchema>) {
    const o = ctx.orgId;
    const need = async (ok: Promise<unknown>, msg: string) => { if (!(await ok)) throw new BadRequestException(msg); };
    for (const st of d.steps as Step[]) {
      const s = (k: string) => String(st[k] ?? '');
      if (st.type === 'move_stage') await need(this.prisma.stage.findFirst({ where: { id: s('stageId'), organisationId: o } }), 'Choose a stage for the "Move to stage" step');
      if (st.type === 'add_label' || st.type === 'remove_label') await need(this.prisma.label.findFirst({ where: { id: s('labelId'), organisationId: o } }), 'Choose a label');
      if (st.type === 'add_to_list') await need(this.prisma.leadList.findFirst({ where: { id: s('listId'), organisationId: o, kind: 'STATIC' } }), 'Choose a static list');
      if (st.type === 'assign' && !['auto', 'unassigned'].includes(s('ownerId'))) await need(this.prisma.membership.findFirst({ where: { userId: s('ownerId'), organisationId: o, status: 'ACTIVE' } }), 'Choose a user to assign to');
      if ((st.type === 'notify' || st.type === 'create_task') && s(st.type === 'notify' ? 'userId' : 'assignee') && s(st.type === 'notify' ? 'userId' : 'assignee') !== 'owner') await need(this.prisma.membership.findFirst({ where: { userId: s(st.type === 'notify' ? 'userId' : 'assignee'), organisationId: o, status: 'ACTIVE' } }), 'Choose a user');
      if (st.type === 'send_email' && !s('body')) throw new BadRequestException('Write the email body');
      if (st.type === 'webhook' && !/^https?:\/\//i.test(s('url'))) throw new BadRequestException('Enter the webhook URL');
      if (st.type === 'wait' && !(Number(st.seconds ?? 0) + Number(st.minutes ?? 0) + Number(st.hours ?? 0) + Number(st.days ?? 0) > 0)) throw new BadRequestException('Enter how long to wait');
      if (st.type === 'update_field' && !s('field')) throw new BadRequestException('Choose the field to update');
    }
  }

  @Perm('settings.manage') @Get('options')
  async options(@Context() ctx: Ctx) {
    const fields = await this.leads.fieldDefs(ctx);
    return { triggers: TRIGGERS, conditionFields: [...CONDITION_FIELDS, ...fields.map((f) => ({ key: `cf_${f.key}`, label: f.label, kind: 'text' as const }))], ops: OPS, stepTypes: STEP_TYPES, placeholders: ['{{lead.name}}', '{{lead.phone}}', '{{lead.email}}', '{{lead.company}}', '{{lead.city}}', '{{lead.owner}}', '{{lead.stage}}', '{{lead.source}}', '{{lead.url}}', '{{org.name}}'] };
  }

  @Perm('settings.manage') @Get()
  async list(@Context() ctx: Ctx) {
    const rows = await this.prisma.automation.findMany({ where: { organisationId: ctx.orgId }, orderBy: { createdAt: 'asc' } });
    const counts = await this.prisma.automationRun.groupBy({ by: ['automationId', 'status'], where: { organisationId: ctx.orgId, startedAt: { gt: new Date(Date.now() - 30 * 864e5) } }, _count: true });
    return rows.map((a) => ({ ...a, last30Days: Object.fromEntries((['DONE', 'SKIPPED', 'FAILED', 'WAITING', 'RUNNING'] as const).map((s) => [s.toLowerCase(), counts.find((c) => c.automationId === a.id && c.status === s)?._count ?? 0])) }));
  }

  @Perm('settings.manage') @Post()
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(automationSchema, body);
    await this.checkRefs(ctx, d);
    await this.plans.check(ctx.orgId, 'automations');
    const a = await this.prisma.automation.create({ data: { organisationId: ctx.orgId, name: d.name, description: d.description ?? null, trigger: d.trigger, conditions: d.conditions as Prisma.InputJsonValue, steps: d.steps as Prisma.InputJsonValue, active: d.active, createdById: ctx.userId } });
    await audit(this.prisma, ctx, 'automation.created', 'automation', a.id, { name: d.name, trigger: d.trigger });
    return a;
  }

  @Perm('settings.manage') @Patch(':id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const existing = await this.find(ctx, id);
    const d = parse(automationSchema.partial(), body);
    const merged = automationSchema.parse({ name: d.name ?? existing.name, description: d.description === undefined ? existing.description : d.description, trigger: d.trigger ?? existing.trigger, conditions: d.conditions ?? existing.conditions, steps: d.steps ?? existing.steps, active: d.active ?? existing.active });
    await this.checkRefs(ctx, merged);
    const a = await this.prisma.automation.update({ where: { id }, data: { name: merged.name, description: merged.description ?? null, trigger: merged.trigger, conditions: merged.conditions as Prisma.InputJsonValue, steps: merged.steps as Prisma.InputJsonValue, active: merged.active } });
    await audit(this.prisma, ctx, 'automation.updated', 'automation', id, { name: merged.name, active: merged.active });
    return a;
  }

  @Perm('settings.manage') @Delete(':id')
  async remove(@Context() ctx: Ctx, @Param('id') id: string) {
    const a = await this.find(ctx, id);
    await this.prisma.$transaction([this.prisma.automation.delete({ where: { id } }), audit(this.prisma, ctx, 'automation.deleted', 'automation', id, { name: a.name })]);
    return { ok: true };
  }

  /** Runs the automation on one lead right now, ignoring the trigger but honouring conditions, and returns the run with its log. */
  @Perm('settings.manage') @Post(':id/test')
  async test(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const a = await this.find(ctx, id);
    const { leadId } = parse(z.object({ leadId: z.string() }), body);
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, organisationId: ctx.orgId }, include: { stage: true, owner: { select: { id: true, name: true } } } });
    if (!lead) throw new BadRequestException('Lead not found');
    const event = await this.prisma.outboxEvent.create({ data: { organisationId: ctx.orgId, type: a.trigger, dispatchedAt: new Date(), payload: { lead: { id: lead.id, name: lead.name }, via: 'test', manual: true, by: ctx.userId } } });
    const run = await this.service.start(a.id, event.id, true);
    return run;
  }

  @Perm('settings.manage') @Get(':id/runs')
  async runs(@Context() ctx: Ctx, @Param('id') id: string, @Query() query: unknown) {
    await this.find(ctx, id);
    const f = parse(z.object({ ...pageSchema }), query);
    const where = { automationId: id, organisationId: ctx.orgId };
    const [items, total] = await Promise.all([
      this.prisma.automationRun.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      this.prisma.automationRun.count({ where }),
    ]);
    const leadIds = [...new Set(items.map((r) => r.leadId).filter(Boolean) as string[])];
    const leadsRows = leadIds.length ? await this.prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } }) : [];
    return { items: items.map((r) => ({ ...r, lead: leadsRows.find((l) => l.id === r.leadId) ?? null })), total, page: f.page, pageSize: f.pageSize };
  }
}
