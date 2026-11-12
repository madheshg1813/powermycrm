import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, pageSchema, parse } from '../common/core';
import { LeadsService } from './leads';
import { OutboxService } from './webhooks';

export const DEFAULT_DISPOSITIONS = ['Interested', 'Not interested', 'Call back later', 'No answer', 'Wrong number', 'Already purchased'];
const STATUSES = ['COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'MISSED'] as const;
const text = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const callSchema = z.object({
  leadId: z.string().nullable().optional(),
  phone: text(30),
  direction: z.enum(['OUTBOUND', 'INBOUND']).default('OUTBOUND'),
  status: z.enum(STATUSES).default('COMPLETED'),
  startedAt: z.coerce.date().optional(),
  durationSec: z.coerce.number().int().min(0).max(86_400).nullable().optional(),
  dispositionId: z.string().nullable().optional(),
  notes: text(2000),
  // Optional follow-up created in the same step, the common "call back on Monday" outcome.
  followUp: z.object({ title: z.string().trim().min(1).max(200), dueAt: z.coerce.date(), type: z.enum(['FOLLOW_UP', 'CALLBACK', 'MEETING', 'DEMO', 'SITE_VISIT', 'TASK']).default('CALLBACK') }).optional(),
});
const listSchema = z.object({
  ...pageSchema,
  leadId: z.string().optional(),
  userId: z.string().optional(), // user id or "me"
  status: z.enum(STATUSES).optional(),
  direction: z.enum(['OUTBOUND', 'INBOUND']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const include = { lead: { select: { id: true, name: true, phone: true } }, user: { select: { id: true, name: true } }, disposition: { select: { id: true, name: true } } } satisfies Prisma.CallInclude;

/** Call log: outbound and inbound calls with outcome, duration, notes and an optional follow-up. Telephony providers will create these automatically; agents log them by hand today. */
@Controller()
export class CallsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly outbox: OutboxService,
  ) {}

  /** Calls the caller may see: everyone's (ALL scope), or their own plus calls on leads they can see. */
  private async where(ctx: Ctx): Promise<Prisma.CallWhereInput> {
    const owners = await this.leads.ownerIds(ctx);
    if (!owners) return { organisationId: ctx.orgId };
    return { organisationId: ctx.orgId, OR: [{ userId: { in: owners } }, { lead: { ownerId: { in: owners } } }] };
  }

  private async find(ctx: Ctx, id: string) {
    const c = await this.prisma.call.findFirst({ where: { id, AND: [await this.where(ctx)] }, include });
    if (!c) throw new NotFoundException('Call not found');
    return c;
  }

  @Perm('leads.view') @Get('calls')
  async list(@Context() ctx: Ctx, @Query() query: unknown) {
    const f = parse(listSchema, query);
    const where: Prisma.CallWhereInput = {
      AND: [await this.where(ctx)],
      leadId: f.leadId,
      userId: f.userId === 'me' ? ctx.userId : f.userId,
      status: f.status,
      direction: f.direction,
      ...(f.from || f.to ? { startedAt: { gte: f.from, lte: f.to } } : {}),
    };
    const [items, total, agg] = await Promise.all([
      this.prisma.call.findMany({ where, include, orderBy: { startedAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      this.prisma.call.count({ where }),
      this.prisma.call.aggregate({ where, _sum: { durationSec: true }, _count: true }),
    ]);
    return { items, total, page: f.page, pageSize: f.pageSize, totals: { calls: agg._count, talkTimeSec: agg._sum.durationSec ?? 0 } };
  }

  @Perm('leads.view') @Post('calls')
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(callSchema, body);
    let lead: { id: string; name: string; phone: string | null; ownerId: string | null } | null = null;
    if (d.leadId) {
      lead = await this.prisma.lead.findFirst({ where: { id: d.leadId, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] }, select: { id: true, name: true, phone: true, ownerId: true } });
      if (!lead) throw new BadRequestException('Lead not found');
    }
    const phone = d.phone ?? lead?.phone ?? null;
    if (!phone && !lead) throw new BadRequestException('Enter the phone number that was called');
    let disposition: { id: string; name: string } | null = null;
    if (d.dispositionId) {
      disposition = await this.prisma.callDisposition.findFirst({ where: { id: d.dispositionId, organisationId: ctx.orgId }, select: { id: true, name: true } });
      if (!disposition) throw new BadRequestException('Call outcome not found');
    }
    const startedAt = d.startedAt ?? new Date();
    const events: string[] = [];
    const call = await this.prisma.$transaction(async (tx) => {
      const call = await tx.call.create({
        data: { organisationId: ctx.orgId, leadId: lead?.id ?? null, userId: ctx.userId, phone, direction: d.direction, status: d.status, startedAt, durationSec: d.status === 'COMPLETED' ? d.durationSec ?? 0 : d.durationSec ?? null, dispositionId: disposition?.id ?? null, notes: d.notes ?? null, provider: 'manual' },
        include,
      });
      if (lead) {
        await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: lead.id, actorId: ctx.userId, type: 'call_logged', data: { id: call.id, direction: d.direction, status: d.status, durationSec: call.durationSec, disposition: disposition?.name ?? null, notes: d.notes ?? null } } });
        await tx.lead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date() } });
        if (d.followUp) {
          const task = await tx.task.create({ data: { organisationId: ctx.orgId, title: d.followUp.title, type: d.followUp.type, dueAt: d.followUp.dueAt, leadId: lead.id, assigneeId: ctx.userId, createdById: ctx.userId } });
          await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: lead.id, actorId: ctx.userId, type: 'task_created', data: { title: task.title, type: task.type, dueAt: task.dueAt } } });
        }
        events.push(await this.outbox.emit(tx, ctx.orgId, 'call.logged', { call: { id: call.id, direction: d.direction, status: d.status, durationSec: call.durationSec, disposition: disposition?.name ?? null, notes: d.notes ?? null, userId: ctx.userId }, lead: { id: lead.id, name: lead.name, ownerId: lead.ownerId } }));
      }
      return call;
    });
    this.outbox.kick(ctx.orgId, events);
    return call;
  }

  @Perm('leads.view') @Patch('calls/:id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(callSchema.omit({ leadId: true, followUp: true }).partial(), body);
    const call = await this.find(ctx, id);
    if (call.userId !== ctx.userId && !ctx.perms.has('tasks.manage')) throw new BadRequestException('Only the agent who logged a call can edit it');
    if (d.dispositionId && !(await this.prisma.callDisposition.findFirst({ where: { id: d.dispositionId, organisationId: ctx.orgId } }))) throw new BadRequestException('Call outcome not found');
    return this.prisma.call.update({ where: { id }, data: { phone: d.phone, direction: d.direction, status: d.status, startedAt: d.startedAt, durationSec: d.durationSec, dispositionId: d.dispositionId, notes: d.notes }, include });
  }

  @Perm('leads.view') @Delete('calls/:id')
  async remove(@Context() ctx: Ctx, @Param('id') id: string) {
    const call = await this.find(ctx, id);
    if (call.userId !== ctx.userId && !ctx.perms.has('tasks.manage')) throw new BadRequestException('Only the agent who logged a call can delete it');
    await this.prisma.$transaction([this.prisma.call.delete({ where: { id } }), audit(this.prisma, ctx, 'call.deleted', 'call', id, { leadId: call.leadId })]);
    return { ok: true };
  }

  // ---- Call outcomes (dispositions) ----------------------------------------------------------

  @Get('call-dispositions')
  dispositions(@Context() ctx: Ctx) {
    return this.prisma.callDisposition.findMany({ where: { organisationId: ctx.orgId }, orderBy: [{ position: 'asc' }, { name: 'asc' }], select: { id: true, name: true, position: true } });
  }

  @Perm('pipeline.manage') @Post('call-dispositions')
  async createDisposition(@Context() ctx: Ctx, @Body() body: unknown) {
    const { name } = parse(z.object({ name: z.string().trim().min(1, 'Enter a name').max(60) }), body);
    if (await this.prisma.callDisposition.findFirst({ where: { organisationId: ctx.orgId, name: { equals: name, mode: 'insensitive' } } })) throw new ConflictException('This outcome already exists');
    const position = await this.prisma.callDisposition.count({ where: { organisationId: ctx.orgId } });
    return this.prisma.callDisposition.create({ data: { organisationId: ctx.orgId, name, position }, select: { id: true, name: true, position: true } });
  }

  @Perm('pipeline.manage') @Patch('call-dispositions/:id')
  async updateDisposition(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(60) }), body);
    const r = await this.prisma.callDisposition.updateMany({ where: { id, organisationId: ctx.orgId }, data: { name } });
    if (!r.count) throw new NotFoundException('Call outcome not found');
    return { ok: true };
  }

  @Perm('pipeline.manage') @Delete('call-dispositions/:id')
  async deleteDisposition(@Context() ctx: Ctx, @Param('id') id: string) {
    const r = await this.prisma.callDisposition.deleteMany({ where: { id, organisationId: ctx.orgId } });
    if (!r.count) throw new NotFoundException('Call outcome not found');
    return { ok: true };
  }
}
