import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, PrismaService, pageSchema, parse } from '../common/core';
import { LeadsService } from './leads';

const types = ['FOLLOW_UP', 'CALLBACK', 'MEETING', 'DEMO', 'SITE_VISIT', 'TASK'] as const;
const createSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title').max(200),
  type: z.enum(types).default('FOLLOW_UP'),
  dueAt: z.coerce.date({ errorMap: () => ({ message: 'Choose a due date and time' }) }),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  notes: z.string().trim().max(2000).nullable().optional(),
  leadId: z.string().nullable().optional(),
  assigneeId: z.string().optional(),
});
const updateSchema = createSchema.partial().extend({ status: z.enum(['OPEN', 'DONE', 'CANCELLED']).optional() });
const listSchema = z.object({
  ...pageSchema,
  view: z.enum(['today', 'overdue', 'upcoming', 'done', 'all']).default('today'),
  assignee: z.string().default('me'), // "me", "all" or a user id
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const include = {
  lead: { select: { id: true, name: true, phone: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;

/** Follow-ups, callbacks, meetings and general tasks. Users always see their own; `tasks.manage` opens up colleagues'. */
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
  ) {}

  /** Whose tasks the caller may see: everyone's (ALL scope), their team's, or only their own. */
  private async visibleAssignees(ctx: Ctx): Promise<string[] | null> {
    if (!ctx.perms.has('tasks.manage')) return [ctx.userId];
    if (ctx.scope === 'ALL') return null;
    if (ctx.scope === 'TEAM' && ctx.teamId) {
      const m = await this.prisma.membership.findMany({ where: { organisationId: ctx.orgId, teamId: ctx.teamId }, select: { userId: true } });
      return [...new Set([...m.map((x) => x.userId), ctx.userId])];
    }
    return [ctx.userId];
  }

  private async find(ctx: Ctx, id: string) {
    const visible = await this.visibleAssignees(ctx);
    const task = await this.prisma.task.findFirst({
      where: { id, organisationId: ctx.orgId, ...(visible ? { assigneeId: { in: visible } } : {}) },
    });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  private async checkRefs(ctx: Ctx, d: { leadId?: string | null; assigneeId?: string }) {
    if (d.assigneeId && d.assigneeId !== ctx.userId) {
      const visible = await this.visibleAssignees(ctx);
      if (visible && !visible.includes(d.assigneeId)) throw new ForbiddenException('You cannot assign tasks to this user');
      const m = await this.prisma.membership.findFirst({ where: { userId: d.assigneeId, organisationId: ctx.orgId, status: 'ACTIVE' } });
      if (!m) throw new BadRequestException('Assignee is not an active user in this workspace');
    }
    if (d.leadId) {
      const lead = await this.prisma.lead.findFirst({ where: { id: d.leadId, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] } });
      if (!lead) throw new BadRequestException('Lead not found');
    }
  }

  @Get()
  async list(@Context() ctx: Ctx, @Query() query: unknown) {
    const f = parse(listSchema, query);
    const visible = await this.visibleAssignees(ctx);
    let assignee: Prisma.TaskWhereInput = { assigneeId: ctx.userId };
    if (f.assignee === 'all') assignee = visible ? { assigneeId: { in: visible } } : {};
    else if (f.assignee !== 'me') {
      if (visible && !visible.includes(f.assignee)) throw new ForbiddenException('You cannot view this user’s tasks');
      assignee = { assigneeId: f.assignee };
    }

    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    const views: Record<string, Prisma.TaskWhereInput> = {
      today: { status: 'OPEN', dueAt: { gte: startOfDay, lte: endOfDay } },
      overdue: { status: 'OPEN', dueAt: { lt: now } },
      upcoming: { status: 'OPEN', dueAt: { gt: endOfDay } },
      done: { status: 'DONE' },
      all: f.from || f.to ? { dueAt: { gte: f.from, lte: f.to } } : {},
    };
    const where: Prisma.TaskWhereInput = { organisationId: ctx.orgId, ...assignee, ...views[f.view] };
    const [items, total, counts] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include,
        orderBy: f.view === 'done' ? { completedAt: 'desc' } : { dueAt: 'asc' },
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
      }),
      this.prisma.task.count({ where }),
      Promise.all(
        (['today', 'overdue', 'upcoming'] as const).map((v) => this.prisma.task.count({ where: { organisationId: ctx.orgId, ...assignee, ...views[v] } })),
      ),
    ]);
    return { items, total, page: f.page, pageSize: f.pageSize, counts: { today: counts[0], overdue: counts[1], upcoming: counts[2] } };
  }

  @Post()
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(createSchema, body);
    await this.checkRefs(ctx, d);
    const assigneeId = d.assigneeId ?? ctx.userId;
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          organisationId: ctx.orgId,
          title: d.title,
          type: d.type,
          dueAt: d.dueAt,
          priority: d.priority,
          notes: d.notes ?? null,
          leadId: d.leadId ?? null,
          assigneeId,
          createdById: ctx.userId,
        },
        include,
      });
      if (task.leadId) {
        await tx.leadActivity.create({
          data: { organisationId: ctx.orgId, leadId: task.leadId, actorId: ctx.userId, type: 'task_created', data: { title: task.title, type: task.type, dueAt: task.dueAt } },
        });
        await tx.lead.update({ where: { id: task.leadId }, data: { lastActivityAt: new Date() } });
      }
      if (assigneeId !== ctx.userId) {
        await tx.notification.create({
          data: { organisationId: ctx.orgId, userId: assigneeId, type: 'task.assigned', title: `New task: ${task.title}`, link: task.leadId ? `/leads/${task.leadId}` : '/follow-ups' },
        });
      }
      return task;
    });
  }

  @Patch(':id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(updateSchema, body);
    const task = await this.find(ctx, id);
    await this.checkRefs(ctx, d);
    const data: Prisma.TaskUncheckedUpdateInput = { ...d };
    if (d.status && d.status !== task.status) data.completedAt = d.status === 'DONE' ? new Date() : null;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({ where: { id }, data, include });
      if (updated.leadId && d.status && d.status !== task.status) {
        const type = d.status === 'DONE' ? 'task_completed' : d.status === 'CANCELLED' ? 'task_cancelled' : 'task_reopened';
        await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: updated.leadId, actorId: ctx.userId, type, data: { title: updated.title } } });
        await tx.lead.update({ where: { id: updated.leadId }, data: { lastActivityAt: new Date() } });
      }
      return updated;
    });
  }

  @Delete(':id')
  async remove(@Context() ctx: Ctx, @Param('id') id: string) {
    await this.find(ctx, id);
    await this.prisma.task.delete({ where: { id } });
    return { ok: true };
  }
}
