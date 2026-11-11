import { Controller, Get, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, parse } from '../common/core';
import { LeadsService } from './leads';

/** Every figure here is computed from stored records, within the caller's record scope. */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
  ) {}

  @Perm('reports.view') @Get()
  async summary(@Context() ctx: Ctx, @Query() query: unknown) {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), query);
    const since = new Date(Date.now() - days * 864e5);
    const scope = await this.leads.scope(ctx);
    const base: Prisma.LeadWhereInput = { organisationId: ctx.orgId, archivedAt: null, AND: [scope] };
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    const myTasks: Prisma.TaskWhereInput = { organisationId: ctx.orgId, assigneeId: ctx.userId, status: 'OPEN' };

    const [total, fresh, unassigned, byStage, bySource, byOwner, stages, sources, tasksToday, tasksOverdue, created] = await Promise.all([
      this.prisma.lead.count({ where: base }),
      this.prisma.lead.count({ where: { ...base, createdAt: { gte: since } } }),
      this.prisma.lead.count({ where: { ...base, ownerId: null } }),
      this.prisma.lead.groupBy({ by: ['stageId'], where: base, _count: true, _sum: { dealValue: true } }),
      this.prisma.lead.groupBy({ by: ['sourceId'], where: { ...base, createdAt: { gte: since } }, _count: true }),
      this.prisma.lead.groupBy({ by: ['ownerId'], where: base, _count: true }),
      this.prisma.stage.findMany({ where: { organisationId: ctx.orgId }, orderBy: [{ pipeline: { isDefault: 'desc' } }, { position: 'asc' }] }),
      this.prisma.leadSource.findMany({ where: { organisationId: ctx.orgId } }),
      this.prisma.task.count({ where: { ...myTasks, dueAt: { gte: startOfDay, lte: endOfDay } } }),
      this.prisma.task.count({ where: { ...myTasks, dueAt: { lt: now } } }),
      this.prisma.lead.findMany({ where: { ...base, createdAt: { gte: new Date(startOfDay.getTime() - 13 * 864e5) } }, select: { createdAt: true } }),
    ]);

    const stageMap = new Map(stages.map((s) => [s.id, s]));
    const sum = (type: 'OPEN' | 'WON' | 'LOST', field: 'count' | 'value') =>
      byStage
        .filter((r) => stageMap.get(r.stageId)?.type === type)
        .reduce((a, r) => a + (field === 'count' ? r._count : Number(r._sum.dealValue ?? 0)), 0);
    const won = sum('WON', 'count');
    const lost = sum('LOST', 'count');

    const owners = await this.prisma.user.findMany({
      where: { id: { in: byOwner.map((o) => o.ownerId).filter(Boolean) as string[] } },
      select: { id: true, name: true },
    });
    const wonByOwner = await this.prisma.lead.groupBy({ by: ['ownerId'], where: { ...base, stage: { type: 'WON' } }, _count: true, _sum: { dealValue: true } });
    const wonMap = new Map(wonByOwner.map((w) => [w.ownerId, w]));

    const trend: { date: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(startOfDay.getTime() - i * 864e5);
      const next = d.getTime() + 864e5;
      trend.push({ date: d.toISOString(), count: created.filter((c) => c.createdAt.getTime() >= d.getTime() && c.createdAt.getTime() < next).length });
    }

    return {
      days,
      leads: { total, new: fresh, open: sum('OPEN', 'count'), won, lost, unassigned },
      conversionRate: won + lost ? won / (won + lost) : null,
      value: { pipeline: sum('OPEN', 'value'), won: sum('WON', 'value') },
      tasks: { today: tasksToday, overdue: tasksOverdue },
      byStage: stages
        .filter((s) => byStage.some((r) => r.stageId === s.id) || stages.length <= 12)
        .map((s) => {
          const r = byStage.find((x) => x.stageId === s.id);
          return { id: s.id, name: s.name, color: s.color, type: s.type, count: r?._count ?? 0, value: Number(r?._sum.dealValue ?? 0) };
        }),
      bySource: bySource
        .map((r) => ({ id: r.sourceId, name: sources.find((s) => s.id === r.sourceId)?.name ?? 'No source', count: r._count }))
        .sort((a, b) => b.count - a.count),
      byOwner: byOwner
        .map((r) => ({
          id: r.ownerId,
          name: owners.find((o) => o.id === r.ownerId)?.name ?? 'Unassigned',
          leads: r._count,
          won: wonMap.get(r.ownerId)?._count ?? 0,
          wonValue: Number(wonMap.get(r.ownerId)?._sum.dealValue ?? 0),
        }))
        .sort((a, b) => b.won - a.won || b.leads - a.leads),
      trend,
    };
  }
}
