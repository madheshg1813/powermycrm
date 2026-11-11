import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, normalizePhone, pageSchema, parse, requirePerm } from '../common/core';

const text = (max: number) =>
  z.string().trim().max(max).transform((v) => v || null).nullable().optional();

const leadFields = {
  phone: text(30),
  email: z.string().trim().toLowerCase().max(200).transform((v) => v || null).nullable().optional()
    .refine((v) => !v || z.string().email().safeParse(v).success, 'Enter a valid email address'),
  company: text(160),
  city: text(100),
  sourceId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  stageId: z.string().optional(),
  score: z.coerce.number().int().min(0).max(100).optional(),
  dealValue: z.coerce.number().min(0).max(1e11).nullable().optional(),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  lostReason: text(300),
  labelIds: z.array(z.string()).max(30).optional(),
  customFields: z.record(z.string(), z.any()).optional(),
};

export type FieldDef = { key: string; label: string; type: string; options: string[]; required: boolean };

/** Validates one custom-field value against its definition. Empty input becomes null (meaning "clear"). */
export function cleanCustomValue(f: FieldDef, raw: unknown): { value: unknown } | { error: string } {
  if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && !raw.length)) return { value: null };
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (s === '') return { value: null };
  switch (f.type) {
    case 'TEXT':
    case 'PHONE':
      return typeof s === 'string' || typeof s === 'number' ? { value: String(s).slice(0, 300) } : { error: 'must be text' };
    case 'LONG_TEXT':
      return typeof s === 'string' ? { value: s.slice(0, 5000) } : { error: 'must be text' };
    case 'NUMBER': {
      const n = typeof s === 'number' ? s : Number(String(s).replace(/,/g, ''));
      return Number.isFinite(n) ? { value: n } : { error: 'must be a number' };
    }
    case 'DATE': {
      const d = new Date(String(s));
      return Number.isNaN(d.getTime()) ? { error: 'must be a date' } : { value: d.toISOString().slice(0, 10) };
    }
    case 'DROPDOWN': {
      const hit = f.options.find((o) => o.toLowerCase() === String(s).toLowerCase());
      return hit ? { value: hit } : { error: `must be one of: ${f.options.join(', ')}` };
    }
    case 'MULTI_SELECT': {
      const parts = (Array.isArray(s) ? s : String(s).split(/[;,]/)).map((x) => String(x).trim()).filter(Boolean);
      const hits = parts.map((p) => f.options.find((o) => o.toLowerCase() === p.toLowerCase()));
      return hits.every(Boolean) ? { value: [...new Set(hits as string[])] } : { error: `must be from: ${f.options.join(', ')}` };
    }
    case 'CHECKBOX': {
      if (typeof s === 'boolean') return { value: s };
      const t = String(s).toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(t)) return { value: true };
      if (['false', 'no', 'n', '0'].includes(t)) return { value: false };
      return { error: 'must be yes or no' };
    }
    case 'URL':
      return /^https?:\/\/\S+\.\S+$/i.test(String(s)) ? { value: String(s).slice(0, 500) } : { error: 'must be a web address starting with http:// or https://' };
    case 'EMAIL':
      return z.string().email().safeParse(String(s)).success ? { value: String(s).toLowerCase() } : { error: 'must be an email address' };
    default:
      return { error: 'has an unknown type' };
  }
}
const createSchema = z.object({ name: z.string().trim().min(1, 'Enter a name').max(160), ...leadFields, allowDuplicate: z.boolean().optional() });
const updateSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), ...leadFields });

const listSchema = z.object({
  ...pageSchema,
  q: z.string().trim().max(100).optional(),
  stageId: z.string().optional(),
  pipelineId: z.string().optional(),
  sourceId: z.string().optional(),
  ownerId: z.string().optional(), // user id, "me" or "unassigned"
  labelId: z.string().optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  archived: z.enum(['true', 'false']).default('false'),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'name', 'score', 'dealValue', 'lastActivityAt']).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1).max(1000),
  action: z.enum(['assign', 'stage', 'addLabel', 'removeLabel', 'archive', 'restore']),
  value: z.string().nullable().optional(),
});

const importSchema = z.object({
  rows: z.array(z.record(z.string(), z.any())).min(1).max(2000),
  duplicateStrategy: z.enum(['skip', 'update', 'create']).default('skip'),
  ownerId: z.string().nullable().optional(),
  sourceId: z.string().nullable().optional(),
});

const include = {
  stage: { select: { id: true, name: true, color: true, type: true } },
  source: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  labels: { include: { label: true } },
} satisfies Prisma.LeadInclude;
type LeadRow = Prisma.LeadGetPayload<{ include: typeof include }>;

const serialize = (l: LeadRow) => ({
  ...l,
  dealValue: l.dealValue === null ? null : Number(l.dealValue),
  labels: l.labels.map((x) => ({ id: x.label.id, name: x.label.name, color: x.label.color })),
});

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Record-level visibility inside the organisation, from the caller's role. */
  async scope(ctx: Ctx): Promise<Prisma.LeadWhereInput> {
    if (ctx.scope === 'ALL') return {};
    if (ctx.scope === 'TEAM' && ctx.teamId) {
      const members = await this.prisma.membership.findMany({
        where: { organisationId: ctx.orgId, teamId: ctx.teamId },
        select: { userId: true },
      });
      return { ownerId: { in: [...new Set([...members.map((m) => m.userId), ctx.userId])] } };
    }
    return { ownerId: ctx.userId };
  }

  private async where(ctx: Ctx, f: z.infer<typeof listSchema>): Promise<Prisma.LeadWhereInput> {
    const and: Prisma.LeadWhereInput[] = [await this.scope(ctx)];
    if (f.q) {
      const digits = f.q.replace(/\D/g, '');
      and.push({
        OR: [
          { name: { contains: f.q, mode: 'insensitive' } },
          { email: { contains: f.q, mode: 'insensitive' } },
          { company: { contains: f.q, mode: 'insensitive' } },
          { phone: { contains: f.q } },
          ...(digits.length >= 3 ? [{ phoneNormalized: { contains: digits } }] : []),
        ],
      });
    }
    if (f.stageId) and.push({ stageId: f.stageId });
    if (f.pipelineId) and.push({ pipelineId: f.pipelineId });
    if (f.sourceId) and.push({ sourceId: f.sourceId });
    if (f.ownerId === 'me') and.push({ ownerId: ctx.userId });
    else if (f.ownerId === 'unassigned') and.push({ ownerId: null });
    else if (f.ownerId) and.push({ ownerId: f.ownerId });
    if (f.labelId) and.push({ labels: { some: { labelId: f.labelId } } });
    if (f.status) and.push({ stage: { type: f.status.toUpperCase() as 'OPEN' | 'WON' | 'LOST' } });
    if (f.createdFrom || f.createdTo) and.push({ createdAt: { gte: f.createdFrom, lte: f.createdTo } });
    return { organisationId: ctx.orgId, archivedAt: f.archived === 'true' ? { not: null } : null, AND: and };
  }

  async list(ctx: Ctx, query: unknown) {
    const f = parse(listSchema, query);
    const where = await this.where(ctx, f);
    const [rows, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        include,
        // Only nullable columns accept a nulls position; empty deal values always sort last.
        orderBy: [f.sort === 'dealValue' ? { dealValue: { sort: f.dir, nulls: 'last' } } : { [f.sort]: f.dir }, { id: 'desc' }],
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
      }),
      this.prisma.lead.count({ where }),
    ]);
    return { items: rows.map(serialize), total, page: f.page, pageSize: f.pageSize };
  }

  fieldDefs(ctx: Ctx) {
    return this.prisma.customField.findMany({ where: { organisationId: ctx.orgId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  }

  /**
   * Applies submitted custom-field values on top of `existing`. Unknown keys are ignored.
   * With `requireAll` (create) every required field must end up with a value; otherwise only the submitted ones are checked.
   */
  private async customValues(ctx: Ctx, input: Record<string, unknown> | undefined, existing: Record<string, unknown>, requireAll: boolean) {
    const defs = await this.fieldDefs(ctx);
    const out: Record<string, unknown> = { ...existing };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const f of defs) {
      const submitted = input && f.key in input;
      if (submitted) {
        const r = cleanCustomValue(f, input![f.key]);
        if ('error' in r) throw new BadRequestException({ message: `${f.label} ${r.error}`, errors: [{ path: `customFields.${f.key}`, message: `${f.label} ${r.error}` }] });
        if (JSON.stringify(r.value) !== JSON.stringify(existing[f.key] ?? null)) changes[f.label] = { from: existing[f.key] ?? null, to: r.value };
        if (r.value === null) delete out[f.key];
        else out[f.key] = r.value;
      }
      if (f.required && (requireAll || submitted) && out[f.key] === undefined) {
        throw new BadRequestException({ message: `${f.label} is required`, errors: [{ path: `customFields.${f.key}`, message: `${f.label} is required` }] });
      }
    }
    return { values: out as Prisma.InputJsonObject, changes };
  }

  /**
   * Round-robin owner picker driven by the organisation's assignment rules. A rule for the lead's
   * source wins over a general rule; deactivated users are skipped. Call `flush` in the same
   * transaction as the leads so each rule's position advances.
   */
  async distributor(ctx: Ctx) {
    const [rules, members] = await Promise.all([
      this.prisma.assignmentRule.findMany({ where: { organisationId: ctx.orgId, active: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.membership.findMany({ where: { organisationId: ctx.orgId, status: 'ACTIVE' }, select: { userId: true } }),
    ]);
    const active = new Set(members.map((m) => m.userId));
    const state = rules.map((r) => ({ id: r.id, sourceId: r.sourceId, users: r.userIds.filter((u) => active.has(u)), cursor: r.cursor, used: 0 }));
    return {
      next: (sourceId: string | null): string | null => {
        const r = state.find((x) => x.users.length && x.sourceId && x.sourceId === sourceId) ?? state.find((x) => x.users.length && !x.sourceId);
        if (!r) return null;
        return r.users[(r.cursor + r.used++) % r.users.length];
      },
      flush: async (tx: Prisma.TransactionClient) => {
        for (const r of state) if (r.used) await tx.assignmentRule.update({ where: { id: r.id }, data: { cursor: { increment: r.used } } });
      },
    };
  }

  async exportCsv(ctx: Ctx, query: unknown) {
    const f = parse(listSchema, query);
    const [rows, defs] = await Promise.all([
      this.prisma.lead.findMany({ where: await this.where(ctx, f), include, orderBy: { createdAt: 'desc' }, take: 50_000 }),
      this.fieldDefs(ctx),
    ]);
    const head = ['Name', 'Phone', 'Email', 'Company', 'City', 'Source', 'Stage', 'Owner', 'Labels', 'Score', 'Deal value', 'Expected close', 'Created', ...defs.map((d) => d.label)].map(csvCell);
    const show = (v: unknown) => (Array.isArray(v) ? v.join('; ') : v === true ? 'Yes' : v === false ? 'No' : v);
    const lines = rows.map((l) =>
      [
        l.name, l.phone, l.email, l.company, l.city, l.source?.name, l.stage.name, l.owner?.name,
        l.labels.map((x) => x.label.name).join('; '), l.score, l.dealValue === null ? '' : Number(l.dealValue),
        l.expectedCloseAt?.toISOString().slice(0, 10), l.createdAt.toISOString(),
        ...defs.map((d) => show((l.customFields as Record<string, unknown>)?.[d.key])),
      ].map(csvCell).join(','),
    );
    await audit(this.prisma, ctx, 'leads.exported', 'lead', null, { count: rows.length });
    return '﻿' + [head.join(','), ...lines].join('\r\n');
  }

  private async find(ctx: Ctx, id: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id, organisationId: ctx.orgId, AND: [await this.scope(ctx)] }, include });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  private duplicatesOf(ctx: Ctx, phoneNormalized: string | null, email: string | null, excludeId?: string) {
    const or: Prisma.LeadWhereInput[] = [];
    if (phoneNormalized) or.push({ phoneNormalized });
    if (email) or.push({ email: { equals: email, mode: 'insensitive' } });
    if (!or.length) return Promise.resolve([]);
    return this.prisma.lead.findMany({
      where: { organisationId: ctx.orgId, archivedAt: null, id: excludeId ? { not: excludeId } : undefined, OR: or },
      select: { id: true, name: true, phone: true, email: true, createdAt: true, owner: { select: { id: true, name: true } } },
      take: 10,
    });
  }

  /** Validates that referenced records belong to the caller's organisation. */
  private async checkRefs(ctx: Ctx, d: { sourceId?: string | null; ownerId?: string | null; stageId?: string; labelIds?: string[] }) {
    const o = ctx.orgId;
    if (d.sourceId && !(await this.prisma.leadSource.findFirst({ where: { id: d.sourceId, organisationId: o } }))) {
      throw new BadRequestException('Lead source not found');
    }
    if (d.ownerId && !(await this.prisma.membership.findFirst({ where: { userId: d.ownerId, organisationId: o, status: 'ACTIVE' } }))) {
      throw new BadRequestException('Owner is not an active user in this workspace');
    }
    if (d.labelIds?.length) {
      const n = await this.prisma.label.count({ where: { id: { in: d.labelIds }, organisationId: o } });
      if (n !== new Set(d.labelIds).size) throw new BadRequestException('Label not found');
    }
    if (d.stageId) {
      const stage = await this.prisma.stage.findFirst({ where: { id: d.stageId, organisationId: o } });
      if (!stage) throw new BadRequestException('Stage not found');
      return stage;
    }
    return null;
  }

  private async defaultStage(ctx: Ctx) {
    const stage = await this.prisma.stage.findFirst({
      where: { organisationId: ctx.orgId, pipeline: { isDefault: true } },
      orderBy: { position: 'asc' },
    });
    if (!stage) throw new BadRequestException('No pipeline is configured');
    return stage;
  }

  private notifyAssigned(tx: Prisma.TransactionClient, ctx: Ctx, leads: { id: string; name: string }[], ownerId: string) {
    if (ownerId === ctx.userId || !leads.length) return Promise.resolve();
    const one = leads.length === 1;
    return tx.notification.create({
      data: {
        organisationId: ctx.orgId,
        userId: ownerId,
        type: 'lead.assigned',
        title: one ? `New lead assigned: ${leads[0].name}` : `${leads.length} leads assigned to you`,
        link: one ? `/leads/${leads[0].id}` : '/leads?ownerId=me',
      },
    });
  }

  async create(ctx: Ctx, body: unknown) {
    const { labelIds, allowDuplicate, customFields, ...d } = parse(createSchema, body);
    // "auto" hands the lead to the assignment rules; it stays unassigned when no rule applies.
    const auto = d.ownerId === 'auto' ? await this.distributor(ctx) : null;
    if (!auto && d.ownerId !== undefined && d.ownerId !== ctx.userId) requirePerm(ctx, 'leads.assign');
    const ownerId = auto ? auto.next(d.sourceId ?? null) : d.ownerId === undefined ? ctx.userId : d.ownerId;
    const stage = (await this.checkRefs(ctx, { ...d, ownerId, labelIds })) ?? (await this.defaultStage(ctx));
    const custom = await this.customValues(ctx, customFields, {}, true);

    const phoneNormalized = normalizePhone(d.phone);
    if (!allowDuplicate) {
      const duplicates = await this.duplicatesOf(ctx, phoneNormalized, d.email ?? null);
      if (duplicates.length) throw new ConflictException({ message: 'A lead with this phone or email already exists', code: 'DUPLICATE', duplicates });
    }

    const lead = await this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          organisationId: ctx.orgId,
          name: d.name,
          phone: d.phone ?? null,
          phoneNormalized,
          email: d.email ?? null,
          company: d.company ?? null,
          city: d.city ?? null,
          sourceId: d.sourceId ?? null,
          ownerId,
          pipelineId: stage.pipelineId,
          stageId: stage.id,
          score: d.score ?? 0,
          dealValue: d.dealValue ?? null,
          expectedCloseAt: d.expectedCloseAt ?? null,
          customFields: custom.values,
          createdById: ctx.userId,
          labels: labelIds?.length ? { create: [...new Set(labelIds)].map((labelId) => ({ labelId })) } : undefined,
        },
        include,
      });
      await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: lead.id, actorId: ctx.userId, type: 'created', data: { stage: stage.name } } });
      if (ownerId) await this.notifyAssigned(tx, ctx, [lead], ownerId);
      await auto?.flush(tx);
      return lead;
    });
    return serialize(lead);
  }

  async get(ctx: Ctx, id: string) {
    const lead = await this.find(ctx, id);
    const [duplicates, tasks] = await Promise.all([
      this.duplicatesOf(ctx, lead.phoneNormalized, lead.email, lead.id),
      this.prisma.task.findMany({
        where: { leadId: id, organisationId: ctx.orgId },
        include: { assignee: { select: { id: true, name: true } } },
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
        take: 50,
      }),
    ]);
    return { ...serialize(lead), duplicates, tasks };
  }

  async update(ctx: Ctx, id: string, body: unknown) {
    const { labelIds, customFields, ...d } = parse(updateSchema, body);
    const lead = await this.find(ctx, id);
    if (d.ownerId !== undefined && d.ownerId !== lead.ownerId) requirePerm(ctx, 'leads.assign');
    const stage = await this.checkRefs(ctx, { ...d, labelIds });

    const data: Prisma.LeadUncheckedUpdateInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (customFields) {
      const custom = await this.customValues(ctx, customFields, (lead.customFields ?? {}) as Record<string, unknown>, false);
      if (Object.keys(custom.changes).length) {
        data.customFields = custom.values;
        Object.assign(changes, custom.changes);
      }
    }
    const plain = ['name', 'phone', 'email', 'company', 'city', 'score', 'lostReason'] as const;
    for (const k of plain) {
      if (d[k] !== undefined && d[k] !== lead[k]) {
        (data as any)[k] = d[k];
        changes[k] = { from: lead[k], to: d[k] };
      }
    }
    if (d.phone !== undefined) data.phoneNormalized = normalizePhone(d.phone);
    if (d.dealValue !== undefined && d.dealValue !== (lead.dealValue === null ? null : Number(lead.dealValue))) {
      data.dealValue = d.dealValue;
      changes.dealValue = { from: lead.dealValue === null ? null : Number(lead.dealValue), to: d.dealValue };
    }
    if (d.expectedCloseAt !== undefined && d.expectedCloseAt?.getTime() !== lead.expectedCloseAt?.getTime()) {
      data.expectedCloseAt = d.expectedCloseAt;
      changes.expectedCloseAt = { from: lead.expectedCloseAt, to: d.expectedCloseAt };
    }
    if (d.sourceId !== undefined && d.sourceId !== lead.sourceId) {
      data.sourceId = d.sourceId;
      changes.source = { from: lead.source?.name ?? null, to: d.sourceId };
    }

    const activities: Prisma.LeadActivityCreateManyInput[] = [];
    const base = { organisationId: ctx.orgId, leadId: id, actorId: ctx.userId };
    if (stage && stage.id !== lead.stageId) {
      data.stageId = stage.id;
      data.pipelineId = stage.pipelineId;
      data.stageEnteredAt = new Date();
      activities.push({ ...base, type: 'stage_changed', data: { from: lead.stage.name, to: stage.name } });
    }
    let newOwner: { id: string; name: string } | null = null;
    if (d.ownerId !== undefined && d.ownerId !== lead.ownerId) {
      data.ownerId = d.ownerId;
      if (d.ownerId) newOwner = await this.prisma.user.findUnique({ where: { id: d.ownerId }, select: { id: true, name: true } });
      activities.push({ ...base, type: 'assigned', data: { from: lead.owner?.name ?? null, to: newOwner?.name ?? null } });
    }
    if (Object.keys(changes).length) activities.push({ ...base, type: 'updated', data: { changes } as Prisma.InputJsonValue });

    const updated = await this.prisma.$transaction(async (tx) => {
      if (labelIds) {
        await tx.leadLabel.deleteMany({ where: { leadId: id } });
        if (labelIds.length) await tx.leadLabel.createMany({ data: [...new Set(labelIds)].map((labelId) => ({ leadId: id, labelId })) });
      }
      if (activities.length) {
        await tx.leadActivity.createMany({ data: activities });
        data.lastActivityAt = new Date();
      }
      if (newOwner) await this.notifyAssigned(tx, ctx, [lead], newOwner.id);
      return tx.lead.update({ where: { id }, data, include });
    });
    return serialize(updated);
  }

  async addNote(ctx: Ctx, id: string, body: unknown) {
    const { body: note } = parse(z.object({ body: z.string().trim().min(1, 'Write a note first').max(5000) }), body);
    await this.find(ctx, id);
    const [activity] = await this.prisma.$transaction([
      this.prisma.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: id, actorId: ctx.userId, type: 'note', data: { body: note } } }),
      this.prisma.lead.update({ where: { id }, data: { lastActivityAt: new Date() } }),
    ]);
    return activity;
  }

  async activities(ctx: Ctx, id: string) {
    await this.find(ctx, id);
    return this.prisma.leadActivity.findMany({
      where: { leadId: id, organisationId: ctx.orgId },
      include: { actor: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async bulk(ctx: Ctx, body: unknown) {
    const { ids, action, value } = parse(bulkSchema, body);
    const need = { assign: 'leads.assign', stage: 'leads.edit', addLabel: 'leads.edit', removeLabel: 'leads.edit', archive: 'leads.delete', restore: 'leads.delete' }[action];
    requirePerm(ctx, need);

    const leads = await this.prisma.lead.findMany({
      where: { id: { in: ids }, organisationId: ctx.orgId, AND: [await this.scope(ctx)] },
      select: { id: true, name: true },
    });
    const found = leads.map((l) => l.id);
    if (!found.length) throw new NotFoundException('No matching leads');
    const base = { organisationId: ctx.orgId, actorId: ctx.userId };

    await this.prisma.$transaction(async (tx) => {
      if (action === 'assign') {
        const ownerId = value || null;
        await this.checkRefs(ctx, { ownerId });
        const owner = ownerId ? await tx.user.findUnique({ where: { id: ownerId }, select: { name: true } }) : null;
        await tx.lead.updateMany({ where: { id: { in: found } }, data: { ownerId, lastActivityAt: new Date() } });
        await tx.leadActivity.createMany({ data: found.map((leadId) => ({ ...base, leadId, type: 'assigned', data: { to: owner?.name ?? null } })) });
        if (ownerId) await this.notifyAssigned(tx, ctx, leads, ownerId);
      } else if (action === 'stage') {
        const stage = await this.checkRefs(ctx, { stageId: value ?? '' });
        if (!stage) throw new BadRequestException('Stage not found');
        await tx.lead.updateMany({
          where: { id: { in: found }, stageId: { not: stage.id } },
          data: { stageId: stage.id, pipelineId: stage.pipelineId, stageEnteredAt: new Date(), lastActivityAt: new Date() },
        });
        await tx.leadActivity.createMany({ data: found.map((leadId) => ({ ...base, leadId, type: 'stage_changed', data: { to: stage.name } })) });
      } else if (action === 'addLabel' || action === 'removeLabel') {
        await this.checkRefs(ctx, { labelIds: value ? [value] : [] });
        if (!value) throw new BadRequestException('Label not found');
        if (action === 'addLabel') {
          await tx.leadLabel.createMany({ data: found.map((leadId) => ({ leadId, labelId: value })), skipDuplicates: true });
        } else {
          await tx.leadLabel.deleteMany({ where: { leadId: { in: found }, labelId: value } });
        }
      } else {
        await tx.lead.updateMany({ where: { id: { in: found } }, data: { archivedAt: action === 'archive' ? new Date() : null } });
        await tx.leadActivity.createMany({ data: found.map((leadId) => ({ ...base, leadId, type: action === 'archive' ? 'archived' : 'restored' })) });
      }
      await audit(tx, ctx, `leads.bulk.${action}`, 'lead', null, { count: found.length, value });
    });
    return { updated: found.length, skipped: ids.length - found.length };
  }

  /** Permanently deletes a lead. Only archived leads can be deleted, so it is always a two-step action. */
  async remove(ctx: Ctx, id: string) {
    const lead = await this.find(ctx, id);
    if (!lead.archivedAt) throw new BadRequestException('Archive the lead before deleting it permanently');
    await this.prisma.$transaction([
      this.prisma.lead.delete({ where: { id } }),
      audit(this.prisma, ctx, 'lead.deleted', 'lead', id, { name: lead.name, phone: lead.phone, email: lead.email }),
    ]);
    return { ok: true };
  }

  /** Folds `duplicateId` into `id`: history, tasks and labels move across, empty fields are filled, the duplicate is removed. */
  async merge(ctx: Ctx, id: string, body: unknown) {
    const { duplicateId } = parse(z.object({ duplicateId: z.string() }), body);
    if (duplicateId === id) throw new BadRequestException('Choose a different lead to merge');
    const [primary, dup] = await Promise.all([this.find(ctx, id), this.find(ctx, duplicateId)]);

    const fill: Prisma.LeadUncheckedUpdateInput = { lastActivityAt: new Date() };
    for (const k of ['phone', 'phoneNormalized', 'email', 'company', 'city', 'sourceId', 'ownerId', 'dealValue', 'expectedCloseAt'] as const) {
      if (primary[k] === null && dup[k] !== null) (fill as any)[k] = dup[k];
    }
    if (dup.score > primary.score) fill.score = dup.score;
    fill.customFields = { ...(dup.customFields as object), ...(primary.customFields as object) };

    await this.prisma.$transaction(async (tx) => {
      await tx.leadActivity.updateMany({ where: { leadId: dup.id }, data: { leadId: id } });
      await tx.task.updateMany({ where: { leadId: dup.id }, data: { leadId: id } });
      await tx.leadLabel.createMany({ data: dup.labels.map((l) => ({ leadId: id, labelId: l.labelId })), skipDuplicates: true });
      await tx.lead.delete({ where: { id: dup.id } });
      await tx.lead.update({ where: { id }, data: fill });
      await tx.leadActivity.create({
        data: { organisationId: ctx.orgId, leadId: id, actorId: ctx.userId, type: 'merged', data: { name: dup.name, phone: dup.phone, email: dup.email } },
      });
      await audit(tx, ctx, 'lead.merged', 'lead', id, { duplicateId });
    });
    return this.get(ctx, id);
  }

  async import(ctx: Ctx, body: unknown) {
    const { rows, duplicateStrategy, ownerId: requestedOwner, sourceId } = parse(importSchema, body);
    const auto = requestedOwner === 'auto' ? await this.distributor(ctx) : null;
    if (!auto && requestedOwner !== undefined && requestedOwner !== ctx.userId) requirePerm(ctx, 'leads.assign');
    const ownerId = auto ? null : requestedOwner === undefined ? ctx.userId : requestedOwner;
    await this.checkRefs(ctx, { ownerId, sourceId });
    const stage = await this.defaultStage(ctx);
    const defs = await this.fieldDefs(ctx);

    const str = (v: unknown, max: number) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
    const errors: { row: number; message: string }[] = [];
    type Clean = { row: number; name: string; phone: string | null; phoneNormalized: string | null; email: string | null; company: string | null; city: string | null; source: string | null; dealValue: number | null; note: string | null; custom: Record<string, unknown> };
    const clean: Clean[] = [];
    rows.forEach((r, i) => {
      const name = str(r.name, 160);
      const phone = str(r.phone, 30) || null;
      const email = str(r.email, 200).toLowerCase() || null;
      if (!name && !phone && !email) return errors.push({ row: i + 1, message: 'Row has no name, phone or email' });
      if (email && !z.string().email().safeParse(email).success) return errors.push({ row: i + 1, message: `Invalid email "${email}"` });
      // Custom fields arrive as "cf_<key>" columns.
      const custom: Record<string, unknown> = {};
      for (const f of defs) {
        const res = cleanCustomValue(f, r[`cf_${f.key}`]);
        if ('error' in res) return errors.push({ row: i + 1, message: `${f.label} ${res.error}` });
        if (res.value !== null) custom[f.key] = res.value;
      }
      const dv = str(r.dealValue, 30).replace(/[^\d.]/g, '');
      clean.push({
        row: i + 1,
        name: name || phone || email!,
        phone,
        phoneNormalized: normalizePhone(phone),
        email,
        company: str(r.company, 160) || null,
        city: str(r.city, 100) || null,
        source: str(r.source, 80) || null,
        dealValue: dv && !Number.isNaN(Number(dv)) ? Number(dv) : null,
        note: str(r.note, 2000) || null,
        custom,
      });
    });

    // Resolve lead sources by name, creating any that are new.
    const sourceMap = new Map((await this.prisma.leadSource.findMany({ where: { organisationId: ctx.orgId } })).map((s) => [s.name.toLowerCase(), s.id]));
    for (const name of new Set(clean.map((c) => c.source).filter(Boolean) as string[])) {
      if (!sourceMap.has(name.toLowerCase())) {
        const s = await this.prisma.leadSource.create({ data: { organisationId: ctx.orgId, name } });
        sourceMap.set(name.toLowerCase(), s.id);
      }
    }

    // Existing leads that match on phone or email, across the whole organisation.
    const phones = clean.map((c) => c.phoneNormalized).filter(Boolean) as string[];
    const emails = clean.map((c) => c.email).filter(Boolean) as string[];
    const existing = phones.length || emails.length
      ? await this.prisma.lead.findMany({
          where: { organisationId: ctx.orgId, archivedAt: null, OR: [{ phoneNormalized: { in: phones } }, { email: { in: emails } }] },
          select: { id: true, phoneNormalized: true, email: true },
        })
      : [];
    const byPhone = new Map(existing.filter((e) => e.phoneNormalized).map((e) => [e.phoneNormalized!, e.id]));
    const byEmail = new Map(existing.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e.id]));

    let created = 0, updated = 0, skipped = 0;
    const toCreate: Clean[] = [];
    const seen = new Set<string>();
    const updates: { id: string; c: Clean }[] = [];
    for (const c of clean) {
      const keys = [c.phoneNormalized && `p:${c.phoneNormalized}`, c.email && `e:${c.email}`].filter(Boolean) as string[];
      const existingId = (c.phoneNormalized && byPhone.get(c.phoneNormalized)) || (c.email && byEmail.get(c.email)) || null;
      const inFile = keys.some((k) => seen.has(k));
      if (duplicateStrategy !== 'create' && (existingId || inFile)) {
        if (duplicateStrategy === 'update' && existingId) updates.push({ id: existingId, c });
        else skipped++;
        continue;
      }
      keys.forEach((k) => seen.add(k));
      toCreate.push(c);
    }

    await this.prisma.$transaction(async (tx) => {
      if (toCreate.length) {
        const rowsCreated = await tx.lead.createManyAndReturn({
          data: toCreate.map((c) => {
            const rowSource = (c.source && sourceMap.get(c.source.toLowerCase())) || sourceId || null;
            return {
              organisationId: ctx.orgId,
              name: c.name,
              phone: c.phone,
              phoneNormalized: c.phoneNormalized,
              email: c.email,
              company: c.company,
              city: c.city,
              sourceId: rowSource,
              ownerId: auto ? auto.next(rowSource) : ownerId,
              pipelineId: stage.pipelineId,
              stageId: stage.id,
              dealValue: c.dealValue,
              customFields: c.custom as Prisma.InputJsonObject,
              createdById: ctx.userId,
            };
          }),
          select: { id: true, name: true, ownerId: true },
        });
        await auto?.flush(tx);
        const acts: Prisma.LeadActivityCreateManyInput[] = [];
        rowsCreated.forEach((l, i) => {
          acts.push({ organisationId: ctx.orgId, leadId: l.id, actorId: ctx.userId, type: 'created', data: { via: 'import', stage: stage.name } });
          if (toCreate[i].note) acts.push({ organisationId: ctx.orgId, leadId: l.id, actorId: ctx.userId, type: 'note', data: { body: toCreate[i].note } });
        });
        await tx.leadActivity.createMany({ data: acts });
        created = rowsCreated.length;
        for (const owner of new Set(rowsCreated.map((l) => l.ownerId))) {
          if (owner) await this.notifyAssigned(tx, ctx, rowsCreated.filter((l) => l.ownerId === owner), owner);
        }
      }
      for (const { id, c } of updates) {
        const data: Prisma.LeadUncheckedUpdateInput = { lastActivityAt: new Date() };
        if (c.company) data.company = c.company;
        if (c.city) data.city = c.city;
        if (c.email) data.email = c.email;
        if (c.phone) { data.phone = c.phone; data.phoneNormalized = c.phoneNormalized; }
        if (c.dealValue !== null) data.dealValue = c.dealValue;
        if (Object.keys(c.custom).length) {
          const current = await tx.lead.findUniqueOrThrow({ where: { id }, select: { customFields: true } });
          data.customFields = { ...(current.customFields as object), ...c.custom } as Prisma.InputJsonObject;
        }
        await tx.lead.update({ where: { id }, data });
        await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: id, actorId: ctx.userId, type: 'updated', data: { via: 'import' } } });
        updated++;
      }
      await audit(tx, ctx, 'leads.imported', 'lead', null, { created, updated, skipped, errors: errors.length });
    }, { timeout: 60_000 });

    return { created, updated, skipped, errors };
  }
}

@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Perm('leads.view') @Get()
  list(@Context() ctx: Ctx, @Query() query: unknown) {
    return this.leads.list(ctx, query);
  }

  @Perm('leads.export') @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="leads.csv"')
  export(@Context() ctx: Ctx, @Query() query: unknown) {
    return this.leads.exportCsv(ctx, query);
  }

  @Perm('leads.import') @Post('import') @HttpCode(200)
  import(@Context() ctx: Ctx, @Body() body: unknown) {
    return this.leads.import(ctx, body);
  }

  @Perm('leads.view') @Post('bulk') @HttpCode(200)
  bulk(@Context() ctx: Ctx, @Body() body: unknown) {
    return this.leads.bulk(ctx, body);
  }

  @Perm('leads.create') @Post()
  create(@Context() ctx: Ctx, @Body() body: unknown) {
    return this.leads.create(ctx, body);
  }

  @Perm('leads.view') @Get(':id')
  get(@Context() ctx: Ctx, @Param('id') id: string) {
    return this.leads.get(ctx, id);
  }

  @Perm('leads.edit') @Patch(':id')
  update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    return this.leads.update(ctx, id, body);
  }

  @Perm('leads.delete') @Delete(':id')
  remove(@Context() ctx: Ctx, @Param('id') id: string) {
    return this.leads.remove(ctx, id);
  }

  @Perm('leads.view') @Get(':id/activities')
  activities(@Context() ctx: Ctx, @Param('id') id: string) {
    return this.leads.activities(ctx, id);
  }

  @Perm('leads.edit') @Post(':id/notes')
  note(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    return this.leads.addNote(ctx, id, body);
  }

  @Perm('leads.edit', 'leads.delete') @Post(':id/merge') @HttpCode(200)
  merge(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    return this.leads.merge(ctx, id, body);
  }
}
