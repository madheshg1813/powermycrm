import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, parse } from '../common/core';

const FIELD_TYPES = ['TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'DROPDOWN', 'MULTI_SELECT', 'CHECKBOX', 'URL', 'EMAIL', 'PHONE'] as const;
const needsOptions = (t: string) => t === 'DROPDOWN' || t === 'MULTI_SELECT';
const options = z.array(z.string().trim().min(1).max(80)).max(100).transform((a) => [...new Set(a)]);

const fieldSchema = z.object({
  label: z.string().trim().min(1, 'Enter a field name').max(60),
  type: z.enum(FIELD_TYPES),
  options: options.default([]),
  required: z.boolean().default(false),
});

const ruleSchema = z.object({
  name: z.string().trim().min(1, 'Enter a rule name').max(80),
  sourceId: z.string().nullable().default(null),
  userIds: z.array(z.string()).min(1, 'Choose at least one user').max(200),
  active: z.boolean().default(true),
});

/** Admin-defined lead fields, personal/shared saved views of the lead list, and round-robin assignment rules. */
@Controller()
export class CustomiseController {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Custom lead fields -------------------------------------------------

  @Get('custom-fields')
  fields(@Context() ctx: Ctx) {
    return this.prisma.customField.findMany({ where: { organisationId: ctx.orgId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  }

  @Perm('pipeline.manage') @Post('custom-fields')
  async createField(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(fieldSchema, body);
    if (needsOptions(d.type) && !d.options.length) throw new BadRequestException('Add at least one option');
    const existing = await this.prisma.customField.findMany({ where: { organisationId: ctx.orgId } });
    if (existing.length >= 100) throw new BadRequestException('A workspace can have up to 100 custom fields');
    if (existing.some((f) => f.label.toLowerCase() === d.label.toLowerCase())) throw new ConflictException('A field with this name already exists');
    // The key is permanent so renaming a field never orphans stored values.
    const base = d.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';
    let key = base;
    for (let i = 2; existing.some((f) => f.key === key); i++) key = `${base}_${i}`;
    const field = await this.prisma.customField.create({
      data: { organisationId: ctx.orgId, key, label: d.label, type: d.type, options: needsOptions(d.type) ? d.options : [], required: d.required, position: existing.length },
    });
    await audit(this.prisma, ctx, 'custom_field.created', 'custom_field', field.id, { label: d.label, type: d.type });
    return field;
  }

  @Perm('pipeline.manage') @Patch('custom-fields/:id')
  async updateField(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    // The type is fixed after creation: changing it would invalidate stored values.
    const d = parse(z.object({ label: fieldSchema.shape.label.optional(), options: options.optional(), required: z.boolean().optional() }), body);
    const field = await this.prisma.customField.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!field) throw new NotFoundException('Field not found');
    if (d.label) {
      const clash = await this.prisma.customField.findFirst({ where: { organisationId: ctx.orgId, id: { not: id }, label: { equals: d.label, mode: 'insensitive' } } });
      if (clash) throw new ConflictException('A field with this name already exists');
    }
    if (d.options && needsOptions(field.type) && !d.options.length) throw new BadRequestException('Add at least one option');
    return this.prisma.customField.update({ where: { id }, data: { label: d.label, required: d.required, options: needsOptions(field.type) ? d.options : undefined } });
  }

  @Perm('pipeline.manage') @Post('custom-fields/reorder')
  async reorderFields(@Context() ctx: Ctx, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: z.array(z.string()).min(1) }), body);
    const fields = await this.prisma.customField.findMany({ where: { organisationId: ctx.orgId } });
    if (fields.length !== ids.length || !fields.every((f) => ids.includes(f.id))) throw new BadRequestException('Field list does not match');
    await this.prisma.$transaction(ids.map((id, position) => this.prisma.customField.update({ where: { id }, data: { position } })));
    return { ok: true };
  }

  @Perm('pipeline.manage') @Delete('custom-fields/:id')
  async deleteField(@Context() ctx: Ctx, @Param('id') id: string) {
    const field = await this.prisma.customField.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!field) throw new NotFoundException('Field not found');
    await this.prisma.$transaction([
      this.prisma.customField.delete({ where: { id } }),
      // Remove the stored values too, so a later field with the same name starts clean.
      this.prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - ${field.key} WHERE "organisationId" = ${ctx.orgId} AND "customFields" ? ${field.key}`,
      audit(this.prisma, ctx, 'custom_field.deleted', 'custom_field', id, { label: field.label }),
    ]);
    return { ok: true };
  }

  // ---- Saved views --------------------------------------------------------

  @Get('saved-filters')
  async savedFilters(@Context() ctx: Ctx) {
    const rows = await this.prisma.savedFilter.findMany({
      where: { organisationId: ctx.orgId, OR: [{ userId: ctx.userId }, { shared: true }] },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, filters: r.filters, shared: r.shared, mine: r.userId === ctx.userId }));
  }

  @Perm('leads.view') @Post('saved-filters')
  async createSavedFilter(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(
      z.object({
        name: z.string().trim().min(1, 'Name this view').max(60),
        shared: z.boolean().default(false),
        filters: z.record(z.string(), z.string().max(200)).refine((f) => Object.keys(f).length <= 20, 'Too many filters'),
      }),
      body,
    );
    const count = await this.prisma.savedFilter.count({ where: { organisationId: ctx.orgId, userId: ctx.userId } });
    if (count >= 50) throw new BadRequestException('You can save up to 50 views');
    const row = await this.prisma.savedFilter.create({ data: { organisationId: ctx.orgId, userId: ctx.userId, name: d.name, shared: d.shared, filters: d.filters as Prisma.InputJsonObject } });
    return { id: row.id, name: row.name, filters: row.filters, shared: row.shared, mine: true };
  }

  @Delete('saved-filters/:id')
  async deleteSavedFilter(@Context() ctx: Ctx, @Param('id') id: string) {
    const r = await this.prisma.savedFilter.deleteMany({ where: { id, organisationId: ctx.orgId, userId: ctx.userId } });
    if (!r.count) throw new NotFoundException('View not found');
    return { ok: true };
  }

  // ---- Assignment rules ---------------------------------------------------

  private async checkRule(ctx: Ctx, d: { sourceId?: string | null; userIds?: string[] }) {
    if (d.sourceId && !(await this.prisma.leadSource.findFirst({ where: { id: d.sourceId, organisationId: ctx.orgId } }))) {
      throw new BadRequestException('Lead source not found');
    }
    if (d.userIds) {
      const unique = [...new Set(d.userIds)];
      const n = await this.prisma.membership.count({ where: { organisationId: ctx.orgId, userId: { in: unique }, status: 'ACTIVE' } });
      if (n !== unique.length) throw new BadRequestException('Every user in a rule must be an active member of this workspace');
      return unique;
    }
    return undefined;
  }

  @Perm('leads.assign') @Get('assignment-rules')
  rules(@Context() ctx: Ctx) {
    return this.prisma.assignmentRule.findMany({ where: { organisationId: ctx.orgId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  }

  @Perm('settings.manage') @Post('assignment-rules')
  async createRule(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(ruleSchema, body);
    const userIds = await this.checkRule(ctx, d);
    const position = await this.prisma.assignmentRule.count({ where: { organisationId: ctx.orgId } });
    const rule = await this.prisma.assignmentRule.create({ data: { organisationId: ctx.orgId, name: d.name, sourceId: d.sourceId, userIds: userIds!, active: d.active, position } });
    await audit(this.prisma, ctx, 'assignment_rule.created', 'assignment_rule', rule.id, { name: d.name });
    return rule;
  }

  @Perm('settings.manage') @Patch('assignment-rules/:id')
  async updateRule(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(ruleSchema.partial(), body);
    const rule = await this.prisma.assignmentRule.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!rule) throw new NotFoundException('Rule not found');
    const userIds = await this.checkRule(ctx, d);
    const updated = await this.prisma.assignmentRule.update({ where: { id }, data: { name: d.name, sourceId: d.sourceId, active: d.active, userIds } });
    await audit(this.prisma, ctx, 'assignment_rule.updated', 'assignment_rule', id, d);
    return updated;
  }

  @Perm('settings.manage') @Delete('assignment-rules/:id')
  async deleteRule(@Context() ctx: Ctx, @Param('id') id: string) {
    const r = await this.prisma.assignmentRule.deleteMany({ where: { id, organisationId: ctx.orgId } });
    if (!r.count) throw new NotFoundException('Rule not found');
    return { ok: true };
  }
}
