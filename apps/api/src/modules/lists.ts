import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, parse, requirePerm } from '../common/core';
import { LeadsService } from './leads';

const listSchema = z.object({
  name: z.string().trim().min(1, 'Name the list').max(80),
  description: z.string().trim().max(300).transform((v) => v || null).nullable().optional(),
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
    const [lists, counts] = await Promise.all([
      this.prisma.leadList.findMany({ where: { organisationId: ctx.orgId }, orderBy: { name: 'asc' } }),
      this.prisma.leadListMember.groupBy({
        by: ['listId'],
        where: { list: { organisationId: ctx.orgId }, lead: { organisationId: ctx.orgId, archivedAt: null, AND: [scope] } },
        _count: true,
      }),
    ]);
    const n = new Map(counts.map((c) => [c.listId, c._count]));
    return lists.map((l) => ({ id: l.id, name: l.name, description: l.description, leads: n.get(l.id) ?? 0, mine: l.createdById === ctx.userId, createdAt: l.createdAt, updatedAt: l.updatedAt }));
  }

  @Perm('leads.edit') @Post()
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(listSchema, body);
    if (await this.prisma.leadList.findFirst({ where: { organisationId: ctx.orgId, name: { equals: d.name, mode: 'insensitive' } } })) {
      throw new ConflictException('A list with this name already exists');
    }
    if ((await this.prisma.leadList.count({ where: { organisationId: ctx.orgId } })) >= 200) throw new BadRequestException('A workspace can have up to 200 lists');
    const list = await this.prisma.leadList.create({ data: { organisationId: ctx.orgId, name: d.name, description: d.description ?? null, createdById: ctx.userId } });
    await audit(this.prisma, ctx, 'list.created', 'lead_list', list.id, { name: d.name });
    return { id: list.id, name: list.name, description: list.description, leads: 0, mine: true, createdAt: list.createdAt, updatedAt: list.updatedAt };
  }

  @Perm('leads.edit') @Patch(':id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(listSchema.partial(), body);
    const list = await this.find(ctx, id);
    this.canManage(ctx, list);
    if (d.name) {
      const clash = await this.prisma.leadList.findFirst({ where: { organisationId: ctx.orgId, id: { not: id }, name: { equals: d.name, mode: 'insensitive' } } });
      if (clash) throw new ConflictException('A list with this name already exists');
    }
    const updated = await this.prisma.leadList.update({ where: { id }, data: { name: d.name, description: d.description } });
    await audit(this.prisma, ctx, 'list.updated', 'lead_list', id, d);
    return { id: updated.id, name: updated.name, description: updated.description };
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
    await this.find(ctx, id);
    const visible = await this.prisma.lead.findMany({ where: { id: { in: ids }, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] }, select: { id: true } });
    if (!visible.length) throw new NotFoundException('No matching leads');
    const r = await this.prisma.leadListMember.createMany({ data: visible.map((l) => ({ listId: id, leadId: l.id, addedById: ctx.userId })), skipDuplicates: true });
    await this.prisma.leadList.update({ where: { id }, data: { updatedAt: new Date() } });
    return { added: r.count, alreadyIn: visible.length - r.count, skipped: ids.length - visible.length };
  }

  @Perm('leads.edit') @Post(':id/leads/remove') @HttpCode(200)
  async removeLeads(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const ids = [...new Set(parse(idsSchema, body).ids)];
    await this.find(ctx, id);
    const visible = await this.prisma.lead.findMany({ where: { id: { in: ids }, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] }, select: { id: true } });
    const r = await this.prisma.leadListMember.deleteMany({ where: { listId: id, leadId: { in: visible.map((l) => l.id) } } });
    return { removed: r.count, skipped: ids.length - r.count };
  }
}
