import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Query, SetMetadata } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, pageSchema, parse } from '../common/core';

export const IS_SUPER = 'isSuperAdmin';
/** Route is for platform super-admins only (User.isSuperAdmin); checked by AuthGuard. */
export const SuperAdmin = () => SetMetadata(IS_SUPER, true);

export type Limits = { users: number; leads: number; automations: number; storageMb: number; webhooks: number };
const limitsSchema = z.object({
  users: z.coerce.number().int().min(1).max(100_000),
  leads: z.coerce.number().int().min(1).max(100_000_000),
  automations: z.coerce.number().int().min(0).max(10_000),
  storageMb: z.coerce.number().int().min(0).max(10_000_000),
  webhooks: z.coerce.number().int().min(0).max(1000),
});
const planSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9_-]{2,30}$/, 'Key: lowercase letters, digits, - or _'),
  name: z.string().trim().min(1).max(60),
  priceMonthly: z.coerce.number().min(0).max(1e7).default(0),
  currency: z.string().trim().length(3).toUpperCase().default('INR'),
  limits: limitsSchema,
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
  position: z.coerce.number().int().min(0).default(0),
});

/** Plans new workspaces can land on. The default plan is what registration assigns; super-admins change it. */
export const DEFAULT_PLANS: z.infer<typeof planSchema>[] = [
  { key: 'free', name: 'Free', priceMonthly: 0, currency: 'INR', limits: { users: 5, leads: 2000, automations: 3, storageMb: 500, webhooks: 2 }, isDefault: true, active: true, position: 0 },
  { key: 'growth', name: 'Growth', priceMonthly: 999, currency: 'INR', limits: { users: 25, leads: 100_000, automations: 50, storageMb: 10_000, webhooks: 10 }, isDefault: false, active: true, position: 1 },
  { key: 'enterprise', name: 'Enterprise', priceMonthly: 0, currency: 'INR', limits: { users: 100_000, leads: 100_000_000, automations: 10_000, storageMb: 10_000_000, webhooks: 1000 }, isDefault: false, active: true, position: 2 },
];

/** Reads an organisation's plan and enforces its limits. Thrown limits carry `code: PLAN_LIMIT` so the UI can explain. */
@Injectable()
export class PlanService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureDefaultPlans() {
    if (await this.prisma.plan.count()) return;
    await this.prisma.plan.createMany({ data: DEFAULT_PLANS.map((p) => ({ ...p, limits: p.limits as Prisma.InputJsonObject })) });
  }

  async forOrganisation(organisationId: string) {
    let sub = await this.prisma.subscription.findUnique({ where: { organisationId }, include: { plan: true } });
    if (!sub) {
      await this.ensureDefaultPlans();
      const plan = (await this.prisma.plan.findFirst({ where: { isDefault: true, active: true } })) ?? (await this.prisma.plan.findFirstOrThrow({ orderBy: { position: 'asc' } }));
      sub = await this.prisma.subscription.create({ data: { organisationId, planId: plan.id, status: 'ACTIVE' }, include: { plan: true } });
    }
    return sub;
  }

  async usage(organisationId: string) {
    const [users, leads, automations, storage, webhooks] = await Promise.all([
      this.prisma.membership.count({ where: { organisationId, status: 'ACTIVE' } }),
      this.prisma.lead.count({ where: { organisationId } }),
      this.prisma.automation.count({ where: { organisationId } }),
      this.prisma.leadAttachment.aggregate({ where: { organisationId }, _sum: { size: true } }),
      this.prisma.webhookEndpoint.count({ where: { organisationId } }),
    ]);
    return { users, leads, automations, storageMb: Math.round((storage._sum.size ?? 0) / 1024 / 1024), webhooks };
  }

  /** Throws when adding `count` more of `what` would exceed the plan. */
  async check(organisationId: string, what: keyof Limits, count = 1) {
    const sub = await this.forOrganisation(organisationId);
    if (sub.status === 'SUSPENDED') throw new ForbiddenException({ message: 'This workspace is suspended. Contact support.', code: 'SUSPENDED' });
    const limits = sub.plan.limits as Limits;
    const current = (await this.usage(organisationId))[what];
    if (current + count > limits[what]) {
      const label = { users: 'users', leads: 'leads', automations: 'automations', storageMb: 'MB of file storage', webhooks: 'webhook endpoints' }[what];
      throw new ForbiddenException({ message: `Your ${sub.plan.name} plan allows ${limits[what].toLocaleString('en-IN')} ${label}. Upgrade the plan to add more.`, code: 'PLAN_LIMIT', limit: limits[what], current, plan: sub.plan.name });
    }
  }
}

/** What a workspace admin sees about their own plan. */
@Controller('organisation')
export class PlanController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  @Perm('settings.manage') @Get('plan')
  async plan(@Context() ctx: Ctx) {
    const sub = await this.plans.forOrganisation(ctx.orgId);
    const usage = await this.plans.usage(ctx.orgId);
    const available = await this.prisma.plan.findMany({ where: { active: true }, orderBy: { position: 'asc' } });
    return {
      plan: { id: sub.plan.id, key: sub.plan.key, name: sub.plan.name, priceMonthly: Number(sub.plan.priceMonthly), currency: sub.plan.currency, limits: sub.plan.limits },
      status: sub.status, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd,
      usage,
      available: available.map((p) => ({ id: p.id, key: p.key, name: p.name, priceMonthly: Number(p.priceMonthly), currency: p.currency, limits: p.limits })),
      // Self-service upgrades need a billing provider; until one is connected, plan changes are made by the platform team.
      selfServiceBilling: false,
    };
  }
}

const orgQuery = z.object({ ...pageSchema, q: z.string().trim().max(100).optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional() });

/** Platform operations: every workspace, its plan and usage, suspension, plan catalogue and system health. */
@Controller('admin')
@SuperAdmin()
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  @Get('overview')
  async overview() {
    const dayAgo = new Date(Date.now() - 864e5);
    const [organisations, suspended, users, leads, activeUsers, newOrgs, failedWebhooks, failedEvents, failedEmails, failedRuns, pendingJobs] = await Promise.all([
      this.prisma.organisation.count(), this.prisma.organisation.count({ where: { status: 'SUSPENDED' } }), this.prisma.user.count(), this.prisma.lead.count(),
      this.prisma.session.count({ where: { lastUsedAt: { gt: dayAgo }, revokedAt: null } }), this.prisma.organisation.count({ where: { createdAt: { gt: dayAgo } } }),
      this.prisma.webhookDelivery.count({ where: { status: 'FAILED', createdAt: { gt: dayAgo } } }), this.prisma.integrationEvent.count({ where: { status: 'FAILED', createdAt: { gt: dayAgo } } }),
      this.prisma.emailMessage.count({ where: { status: 'FAILED', createdAt: { gt: dayAgo } } }), this.prisma.automationRun.count({ where: { status: 'FAILED', startedAt: { gt: dayAgo } } }),
      this.prisma.outboxEvent.count({ where: { dispatchedAt: null } }),
    ]);
    const byPlan = await this.prisma.subscription.groupBy({ by: ['planId'], _count: true });
    const plans = await this.prisma.plan.findMany();
    return {
      organisations, suspended, users, leads, activeUsers24h: activeUsers, newOrganisations24h: newOrgs,
      last24h: { failedWebhooks, failedIntegrationEvents: failedEvents, failedEmails, failedAutomationRuns: failedRuns },
      undispatchedEvents: pendingJobs,
      byPlan: plans.map((p) => ({ plan: p.name, organisations: byPlan.find((b) => b.planId === p.id)?._count ?? 0 })),
    };
  }

  @Get('organisations')
  async organisations(@Query() query: unknown) {
    const f = parse(orgQuery, query);
    const where: Prisma.OrganisationWhereInput = { status: f.status, ...(f.q ? { OR: [{ name: { contains: f.q, mode: 'insensitive' } }, { slug: { contains: f.q, mode: 'insensitive' } }, { memberships: { some: { user: { email: { contains: f.q, mode: 'insensitive' } } } } }] } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.organisation.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize,
        include: { _count: { select: { memberships: true, leads: true } }, memberships: { where: { role: { systemKey: 'owner' } }, take: 1, include: { user: { select: { name: true, email: true } } } } },
      }),
      this.prisma.organisation.count({ where }),
    ]);
    const subs = await this.prisma.subscription.findMany({ where: { organisationId: { in: rows.map((r) => r.id) } }, include: { plan: true } });
    const lastActive = await this.prisma.session.groupBy({ by: ['organisationId'], where: { organisationId: { in: rows.map((r) => r.id) } }, _max: { lastUsedAt: true } });
    return {
      items: rows.map((o) => ({
        id: o.id, name: o.name, slug: o.slug, status: o.status, createdAt: o.createdAt, timezone: o.timezone,
        owner: o.memberships[0]?.user ?? null, members: o._count.memberships, leads: o._count.leads,
        plan: subs.find((s) => s.organisationId === o.id)?.plan.name ?? null, subscription: subs.find((s) => s.organisationId === o.id)?.status ?? null,
        lastActiveAt: lastActive.find((l) => l.organisationId === o.id)?._max.lastUsedAt ?? null,
      })),
      total, page: f.page, pageSize: f.pageSize,
    };
  }

  @Get('organisations/:id')
  async organisation(@Param('id') id: string) {
    const o = await this.prisma.organisation.findUnique({ where: { id }, include: { memberships: { include: { user: { select: { id: true, name: true, email: true } }, role: { select: { name: true, systemKey: true } } } } } });
    if (!o) throw new NotFoundException('Organisation not found');
    const sub = await this.plans.forOrganisation(id);
    return { ...o, memberships: o.memberships.map((m) => ({ id: m.id, status: m.status, user: m.user, role: m.role, createdAt: m.createdAt })), plan: sub.plan, subscription: { status: sub.status, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd }, usage: await this.plans.usage(id) };
  }

  /** Suspend or reactivate a workspace, or move it to another plan. Suspension signs everyone out at once. */
  @Patch('organisations/:id')
  async updateOrganisation(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), planId: z.string().optional(), subscriptionStatus: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'SUSPENDED']).optional(), note: z.string().trim().max(500).optional() }), body);
    const o = await this.prisma.organisation.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Organisation not found');
    if (d.planId && !(await this.prisma.plan.findUnique({ where: { id: d.planId } }))) throw new BadRequestException('Plan not found');
    await this.plans.forOrganisation(id);
    await this.prisma.$transaction(async (tx) => {
      if (d.status) await tx.organisation.update({ where: { id }, data: { status: d.status } });
      if (d.planId || d.subscriptionStatus) await tx.subscription.update({ where: { organisationId: id }, data: { planId: d.planId, status: d.subscriptionStatus } });
      await tx.auditLog.create({ data: { organisationId: id, actorId: ctx.userId, action: 'admin.organisation.updated', entity: 'organisation', entityId: id, meta: { ...d, bySuperAdmin: true } as Prisma.InputJsonObject, ip: ctx.ip } });
    });
    return this.organisation(id);
  }

  @Get('plans')
  async plansList() {
    await this.plans.ensureDefaultPlans();
    const rows = await this.prisma.plan.findMany({ orderBy: { position: 'asc' } });
    const counts = await this.prisma.subscription.groupBy({ by: ['planId'], _count: true });
    return rows.map((p) => ({ ...p, priceMonthly: Number(p.priceMonthly), organisations: counts.find((c) => c.planId === p.id)?._count ?? 0 }));
  }

  @Post('plans')
  async createPlan(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(planSchema, body);
    if (await this.prisma.plan.findUnique({ where: { key: d.key } })) throw new BadRequestException('A plan with this key already exists');
    const p = await this.prisma.$transaction(async (tx) => {
      if (d.isDefault) await tx.plan.updateMany({ data: { isDefault: false } });
      return tx.plan.create({ data: { ...d, limits: d.limits as Prisma.InputJsonObject } });
    });
    await audit(this.prisma, ctx, 'admin.plan.created', 'plan', p.id, { key: d.key });
    return { ...p, priceMonthly: Number(p.priceMonthly) };
  }

  @Patch('plans/:id')
  async updatePlan(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(planSchema.partial(), body);
    if (!(await this.prisma.plan.findUnique({ where: { id } }))) throw new NotFoundException('Plan not found');
    const p = await this.prisma.$transaction(async (tx) => {
      if (d.isDefault) await tx.plan.updateMany({ data: { isDefault: false } });
      return tx.plan.update({ where: { id }, data: { ...d, limits: d.limits as Prisma.InputJsonObject | undefined } });
    });
    await audit(this.prisma, ctx, 'admin.plan.updated', 'plan', id, d);
    return { ...p, priceMonthly: Number(p.priceMonthly) };
  }
}
