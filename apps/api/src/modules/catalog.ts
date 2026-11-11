import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, parse } from '../common/core';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Choose a colour');
const name = z.string().trim().min(1, 'Enter a name').max(60);
const stageSchema = z.object({ name, color: color.optional(), type: z.enum(['OPEN', 'WON', 'LOST']).optional() });

/** Pipelines, stages, lead sources and labels: the per-organisation vocabularies leads refer to. */
@Controller()
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Pipelines and stages -----------------------------------------------

  @Get('pipelines')
  async pipelines(@Context() ctx: Ctx) {
    const [pipelines, counts] = await Promise.all([
      this.prisma.pipeline.findMany({
        where: { organisationId: ctx.orgId },
        include: { stages: { orderBy: { position: 'asc' } } },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.lead.groupBy({ by: ['stageId'], where: { organisationId: ctx.orgId, archivedAt: null }, _count: true }),
    ]);
    const n = new Map(counts.map((c) => [c.stageId, c._count]));
    return pipelines.map((p) => ({ ...p, stages: p.stages.map((s) => ({ ...s, leads: n.get(s.id) ?? 0 })) }));
  }

  @Perm('pipeline.manage') @Post('pipelines')
  async createPipeline(@Context() ctx: Ctx, @Body() body: unknown) {
    const data = parse(z.object({ name }), body);
    if (await this.prisma.pipeline.findFirst({ where: { organisationId: ctx.orgId, name: { equals: data.name, mode: 'insensitive' } } })) {
      throw new ConflictException('A pipeline with this name already exists');
    }
    const pipeline = await this.prisma.pipeline.create({
      data: {
        organisationId: ctx.orgId,
        name: data.name,
        stages: {
          create: [
            { organisationId: ctx.orgId, name: 'New', color: '#2563EB', position: 0, type: 'OPEN' },
            { organisationId: ctx.orgId, name: 'Won', color: '#168A4C', position: 1, type: 'WON' },
            { organisationId: ctx.orgId, name: 'Lost', color: '#B42318', position: 2, type: 'LOST' },
          ],
        },
      },
      include: { stages: true },
    });
    await audit(this.prisma, ctx, 'pipeline.created', 'pipeline', pipeline.id, data);
    return pipeline;
  }

  @Perm('pipeline.manage') @Patch('pipelines/:id')
  async updatePipeline(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(z.object({ name: name.optional(), isDefault: z.literal(true).optional() }), body);
    const p = await this.prisma.pipeline.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!p) throw new NotFoundException('Pipeline not found');
    await this.prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.pipeline.updateMany({ where: { organisationId: ctx.orgId }, data: { isDefault: false } });
      await tx.pipeline.update({ where: { id }, data });
    });
    return { ok: true };
  }

  @Perm('pipeline.manage') @Delete('pipelines/:id')
  async deletePipeline(@Context() ctx: Ctx, @Param('id') id: string) {
    const p = await this.prisma.pipeline.findFirst({ where: { id, organisationId: ctx.orgId }, include: { _count: { select: { leads: true } } } });
    if (!p) throw new NotFoundException('Pipeline not found');
    if (p.isDefault) throw new BadRequestException('Make another pipeline the default before deleting this one');
    if (p._count.leads) throw new BadRequestException('Move this pipeline’s leads to another pipeline first');
    await this.prisma.pipeline.delete({ where: { id } });
    return { ok: true };
  }

  @Perm('pipeline.manage') @Post('pipelines/:id/stages')
  async createStage(@Context() ctx: Ctx, @Param('id') pipelineId: string, @Body() body: unknown) {
    const data = parse(stageSchema, body);
    const p = await this.prisma.pipeline.findFirst({ where: { id: pipelineId, organisationId: ctx.orgId }, include: { stages: true } });
    if (!p) throw new NotFoundException('Pipeline not found');
    if (p.stages.some((s) => s.name.toLowerCase() === data.name.toLowerCase())) throw new ConflictException('This pipeline already has a stage with that name');
    // New open stages go just before the first closing (won/lost) stage.
    const type = data.type ?? 'OPEN';
    const firstClosed = p.stages.filter((s) => s.type !== 'OPEN').sort((a, b) => a.position - b.position)[0];
    const position = type === 'OPEN' && firstClosed ? firstClosed.position : p.stages.length;
    return this.prisma.$transaction(async (tx) => {
      await tx.stage.updateMany({ where: { pipelineId, position: { gte: position } }, data: { position: { increment: 1 } } });
      return tx.stage.create({ data: { organisationId: ctx.orgId, pipelineId, name: data.name, color: data.color ?? '#78716C', type, position } });
    });
  }

  @Perm('pipeline.manage') @Patch('stages/:id')
  async updateStage(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(stageSchema.partial(), body);
    const s = await this.prisma.stage.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!s) throw new NotFoundException('Stage not found');
    if (data.name) {
      const clash = await this.prisma.stage.findFirst({ where: { pipelineId: s.pipelineId, id: { not: id }, name: { equals: data.name, mode: 'insensitive' } } });
      if (clash) throw new ConflictException('This pipeline already has a stage with that name');
    }
    return this.prisma.stage.update({ where: { id }, data });
  }

  @Perm('pipeline.manage') @Post('pipelines/:id/stages/reorder')
  async reorderStages(@Context() ctx: Ctx, @Param('id') pipelineId: string, @Body() body: unknown) {
    const { stageIds } = parse(z.object({ stageIds: z.array(z.string()).min(1) }), body);
    const stages = await this.prisma.stage.findMany({ where: { pipelineId, organisationId: ctx.orgId } });
    if (stages.length !== stageIds.length || !stages.every((s) => stageIds.includes(s.id))) {
      throw new BadRequestException('Stage list does not match this pipeline');
    }
    await this.prisma.$transaction(stageIds.map((id, position) => this.prisma.stage.update({ where: { id }, data: { position } })));
    return { ok: true };
  }

  @Perm('pipeline.manage') @Delete('stages/:id')
  async deleteStage(@Context() ctx: Ctx, @Param('id') id: string) {
    const s = await this.prisma.stage.findFirst({ where: { id, organisationId: ctx.orgId }, include: { _count: { select: { leads: true } } } });
    if (!s) throw new NotFoundException('Stage not found');
    if (s._count.leads) throw new BadRequestException(`Move the ${s._count.leads} lead(s) in this stage to another stage first`);
    const open = await this.prisma.stage.count({ where: { pipelineId: s.pipelineId, type: 'OPEN', id: { not: id } } });
    if (s.type === 'OPEN' && !open) throw new BadRequestException('A pipeline needs at least one open stage');
    await this.prisma.stage.delete({ where: { id } });
    return { ok: true };
  }

  // ---- Lead sources -------------------------------------------------------

  @Get('sources')
  async sources(@Context() ctx: Ctx) {
    const rows = await this.prisma.leadSource.findMany({
      where: { organisationId: ctx.orgId },
      include: { _count: { select: { leads: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((s) => ({ id: s.id, name: s.name, leads: s._count.leads }));
  }

  @Perm('pipeline.manage') @Post('sources')
  async createSource(@Context() ctx: Ctx, @Body() body: unknown) {
    const data = parse(z.object({ name }), body);
    if (await this.prisma.leadSource.findFirst({ where: { organisationId: ctx.orgId, name: { equals: data.name, mode: 'insensitive' } } })) {
      throw new ConflictException('This lead source already exists');
    }
    return this.prisma.leadSource.create({ data: { organisationId: ctx.orgId, name: data.name } });
  }

  @Perm('pipeline.manage') @Patch('sources/:id')
  async updateSource(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(z.object({ name }), body);
    const r = await this.prisma.leadSource.updateMany({ where: { id, organisationId: ctx.orgId }, data });
    if (!r.count) throw new NotFoundException('Lead source not found');
    return { ok: true };
  }

  @Perm('pipeline.manage') @Delete('sources/:id')
  async deleteSource(@Context() ctx: Ctx, @Param('id') id: string) {
    const r = await this.prisma.leadSource.deleteMany({ where: { id, organisationId: ctx.orgId } });
    if (!r.count) throw new NotFoundException('Lead source not found');
    return { ok: true };
  }

  // ---- Labels -------------------------------------------------------------

  @Get('labels')
  async labels(@Context() ctx: Ctx) {
    const rows = await this.prisma.label.findMany({
      where: { organisationId: ctx.orgId },
      include: { _count: { select: { leads: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((l) => ({ id: l.id, name: l.name, color: l.color, leads: l._count.leads }));
  }

  @Perm('pipeline.manage') @Post('labels')
  async createLabel(@Context() ctx: Ctx, @Body() body: unknown) {
    const data = parse(z.object({ name, color: color.optional() }), body);
    if (await this.prisma.label.findFirst({ where: { organisationId: ctx.orgId, name: { equals: data.name, mode: 'insensitive' } } })) {
      throw new ConflictException('This label already exists');
    }
    return this.prisma.label.create({ data: { organisationId: ctx.orgId, ...data } });
  }

  @Perm('pipeline.manage') @Patch('labels/:id')
  async updateLabel(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(z.object({ name: name.optional(), color: color.optional() }), body);
    const r = await this.prisma.label.updateMany({ where: { id, organisationId: ctx.orgId }, data });
    if (!r.count) throw new NotFoundException('Label not found');
    return { ok: true };
  }

  @Perm('pipeline.manage') @Delete('labels/:id')
  async deleteLabel(@Context() ctx: Ctx, @Param('id') id: string) {
    const r = await this.prisma.label.deleteMany({ where: { id, organisationId: ctx.orgId } });
    if (!r.count) throw new NotFoundException('Label not found');
    return { ok: true };
  }
}
