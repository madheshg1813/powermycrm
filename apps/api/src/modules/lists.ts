import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, parse, requirePerm } from '../common/core';
import { LeadsService } from './leads';

const listSchema = z.object({
  name: z.string().trim().min(1, 'Name the list').max(80),
  description: z.string().trim().max(300).transform((v) => v || null).nullable().optional(),
  kind: z.enum(['STATIC', 'DYNAMIC']).default('STATIC'),
  // Lead-list query parameters (status, stageId, sourceId, ownerId, labelId, q, cf_<key>…) for a dynamic list.
  filters: z.record(z.string(), z.string().max(200)).refine((f) => Object.keys(f).length <= 20, 'Too many filters').optional(),
});
const idsSchema = z.object({ ids: z.array(z.string()).min(1, 'Choose at least one lead').max(1000) });

/**
 * Static lead lists: a user picks leads and puts them in a named list (a calling list, a campaign batch).
 * Membership changes only when a user adds or removes leads. Counts honour the caller's record scope,
 * so an agent sees how many of *their* leads are in a list.
 */
@Controller('lists')
export class ListsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
  ) {}

  private async find(ctx: Ctx, id: string) {
    const list = await this.prisma.leadList.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!list) throw new NotFoundException('List not found');
    return list;
  }

  /** Only the creator or a pipeline manager may rename or delete a list. */
  private canManage(ctx: Ctx, list: { createdById: string | null }) {
    if (list.createdById !== ctx.userId) requirePerm(ctx, 'pipeline.manage');
  }

  @Perm('leads.view') @Get()
  async all(@Context() ctx: Ctx) {
    const scope = await this.leads.scope(ctx);
    const [lists, counts, defs] = await Promise.all([
      this.prisma.leadList.findMany({ where: { organisationId: ctx.orgId }, orderBy: { name: 'asc' } }),
      this.prisma.leadListMember.groupBy({
        by: ['listId'],
        where: { list: { organisationId: ctx.orgId }, lead: { organisationId: ctx.orgId, archivedAt: null, AND: [scope] } },
        _count: true,
      }),
      this.leads.fieldDefs(ctx),
    ]);
    const n = new Map(counts.map((c) => [c.listId, c._count]));
    // Dynamic lists are counted live against their filters.
    for (const l of lists) {
      if (l.kind !== 'DYNAMIC') continue;
      const where = await this.leads.listWhere(ctx, l.id, defs);
      n.set(l.id, await this.prisma.lead.count({ where: { organisationId: ctx.orgId, archivedAt: null, AND: [scope, where] } }));
    }
    return lists.map((l) => ({ id: l.id, name: l.name, description: l.description, kind: l.kind, filters: l.filters, leads: n.get(l.id) ?? 0, mine: l.createdById === ctx.userId, createdAt: l.createdAt, updatedAt: l.updatedAt }));
  }

  @Perm('leads.edit') @Post()
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(listSchema, body);
    if (await this.prisma.leadList.findFirst({ where: { organisationId: ctx.orgId, name: { equals: d.name, mode: 'insensitive' } } })) {
      throw new ConflictException('A list with this name already exists');
    }
    if ((await this.prisma.leadList.count({ where: { organisationId: ctx.orgId } })) >= 200) throw new BadRequestException('A workspace can have up to 200 lists');
    if (d.kind === 'DYNAMIC' && !Object.values(d.filters ?? {}).some(Boolean)) throw new BadRequestException('A dynamic list needs at least one filter');
    const list = await this.prisma.leadList.create({ data: { organisationId: ctx.orgId, name: d.name, description: d.description ?? null, kind: d.kind, filters: d.kind === 'DYNAMIC' ? (d.filters as Prisma.InputJsonObject) : undefined, createdById: ctx.userId } });
    await audit(this.prisma, ctx, 'list.created', 'lead_list', list.id, { name: d.name, kind: d.kind });
    const leads = d.kind === 'DYNAMIC' ? await this.prisma.lead.count({ where: { organisationId: ctx.orgId, archivedAt: null, AND: [await this.leads.scope(ctx), await this.leads.listWhere(ctx, list.id, await this.leads.fieldDefs(ctx))] } }) : 0;
    return { id: list.id, name: list.name, description: list.description, kind: list.kind, filters: list.filters, leads, mine: true, createdAt: list.createdAt, updatedAt: list.updatedAt };
  }

  @Perm('leads.edit') @Patch(':id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(listSchema.omit({ kind: true }).partial(), body);
    const list = await this.find(ctx, id);
    this.canManage(ctx, list);
    if (d.name) {
      const clash = await this.prisma.leadList.findFirst({ where: { organisationId: ctx.orgId, id: { not: id }, name: { equals: d.name, mode: 'insensitive' } } });
      if (clash) throw new ConflictException('A list with this name already exists');
    }
    if (d.filters && list.kind !== 'DYNAMIC') throw new BadRequestException('Only a dynamic list has filters');
    if (d.filters && !Object.values(d.filters).some(Boolean)) throw new BadRequestException('A dynamic list needs at least one filter');
    const updated = await this.prisma.leadList.update({ where: { id }, data: { name: d.name, description: d.description, filters: d.filters as Prisma.InputJsonObject | undefined } });
    await audit(this.prisma, ctx, 'list.updated', 'lead_list', id, d);
    return { id: updated.id, name: updated.name, description: updated.description, kind: updated.kind, filters: updated.filters };
  }

  /** Deleting a list never touches the leads in it. */
  @Perm('leads.edit') @Delete(':id')
  async remove(@Context() ctx: Ctx, @Param('id') id: string) {
    const list = await this.find(ctx, id);
    this.canManage(ctx, list);
    await this.prisma.$transaction([
      this.prisma.leadList.delete({ where: { id } }),
      audit(this.prisma, ctx, 'list.deleted', 'lead_list', id, { name: list.name }),
    ]);
    return { ok: true };
  }

  /** Adds leads the caller can see. Leads already in the list are ignored, as are ids outside the caller's scope. */
  @Perm('leads.edit') @Post(':id/leads') @HttpCode(200)
  async add(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const ids = [...new Set(parse(idsSchema, body).ids)];
    const list = await this.find(ctx, id);
    if (list.kind === 'DYNAMIC') throw new BadRequestException('A dynamic list fills itself from its filters; leads cannot be added by hand');
    const visible = await this.prisma.lead.findMany({ where: { id: { in: ids }, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] }, select: { id: true } });
    if (!visible.length) throw new NotFoundException('No matching leads');
    const r = await this.prisma.leadListMember.createMany({ data: visible.map((l) => ({ listId: id, leadId: l.id, addedById: ctx.userId })), skipDuplicates: true });
    await this.prisma.leadList.update({ where: { id }, data: { updatedAt: new Date() } });
    return { added: r.count, alreadyIn: visible.length - r.count, skipped: ids.length - visible.length };
  }

  @Perm('leads.edit') @Post(':id/leads/remove') @HttpCode(200)
  async removeLeads(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const ids = [...new Set(parse(idsSchema, body).ids)];
    const list = await this.find(ctx, id);
    if (list.kind === 'DYNAMIC') throw new BadRequestException('A dynamic list fills itself from its filters; leads cannot be removed by hand');
    const visible = await this.prisma.lead.findMany({ where: { id: { in: ids }, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] }, select: { id: true } });
    const r = await this.prisma.leadListMember.deleteMany({ where: { listId: id, leadId: { in: visible.map((l) => l.id) } } });
    return { removed: r.count, skipped: ids.length - r.count };
  }
}
