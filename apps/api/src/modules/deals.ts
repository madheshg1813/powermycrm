import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, pageSchema, parse } from '../common/core';
import { LeadsService, serializeOpp, serializePayment } from './leads';
import { IntegrationsController } from './integrations';
import { createPaymentLink, razorpayCredentials } from './providers/razorpay';
import { OutboxService } from './webhooks';

const text = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const amount = z.coerce.number().min(0, 'Enter an amount').max(1e11);

const oppSchema = z.object({
  leadId: z.string(),
  name: z.string().trim().min(1, 'Name the deal').max(160),
  value: amount.default(0),
  probability: z.coerce.number().int().min(0).max(100).default(50),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  notes: text(2000),
});
const oppUpdateSchema = oppSchema.omit({ leadId: true }).partial().extend({
  status: z.enum(['OPEN', 'WON', 'LOST']).optional(),
  lostReason: text(300),
});
const oppListSchema = z.object({
  ...pageSchema,
  status: z.enum(['OPEN', 'WON', 'LOST']).optional(),
  ownerId: z.string().optional(),
  leadId: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  closeFrom: z.coerce.date().optional(),
  closeTo: z.coerce.date().optional(),
  sort: z.enum(['expectedCloseAt', 'value', 'createdAt', 'updatedAt', 'name']).default('expectedCloseAt'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

const METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'PAYMENT_LINK', 'OTHER'] as const;
const paymentSchema = z.object({
  leadId: z.string(),
  opportunityId: z.string().nullable().optional(),
  amount: amount.refine((v) => v > 0, 'Enter an amount'),
  method: z.enum(METHODS).default('OTHER'),
  status: z.enum(['PENDING', 'PAID']).default('PENDING'),
  reference: text(120),
  notes: text(2000),
  dueAt: z.coerce.date().nullable().optional(),
  paidAt: z.coerce.date().nullable().optional(),
});
const paymentUpdateSchema = paymentSchema.omit({ leadId: true }).partial().extend({ status: z.enum(['PENDING', 'PAID', 'FAILED', 'REFUNDED']).optional() });
const paymentListSchema = z.object({
  ...pageSchema,
  status: z.enum(['PENDING', 'PAID', 'FAILED', 'REFUNDED', 'OVERDUE']).optional(),
  method: z.enum(METHODS).optional(),
  leadId: z.string().optional(),
  ownerId: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(), // paidAt or dueAt window, see where()
  to: z.coerce.date().optional(),
  sort: z.enum(['dueAt', 'paidAt', 'amount', 'createdAt']).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

const oppInclude = { lead: { select: { id: true, name: true, phone: true } }, owner: { select: { id: true, name: true } } } satisfies Prisma.OpportunityInclude;
const payInclude = { lead: { select: { id: true, name: true, phone: true, ownerId: true } }, opportunity: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } } satisfies Prisma.PaymentInclude;
const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));

/** Deals (opportunities) and payments. Both hang off a lead, so visibility follows the lead's record scope. */
@Controller('opportunities')
export class OpportunitiesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly outbox: OutboxService,
  ) {}

  private async visibleLead(ctx: Ctx, leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] }, select: { id: true, name: true, ownerId: true, archivedAt: true } });
    if (!lead) throw new BadRequestException('Lead not found');
    return lead;
  }

  private async find(ctx: Ctx, id: string) {
    const o = await this.prisma.opportunity.findFirst({ where: { id, organisationId: ctx.orgId, lead: { AND: [await this.leads.scope(ctx)] } }, include: oppInclude });
    if (!o) throw new NotFoundException('Deal not found');
    return o;
  }

  private async checkOwner(ctx: Ctx, ownerId: string | null | undefined) {
    if (ownerId && !(await this.prisma.membership.findFirst({ where: { userId: ownerId, organisationId: ctx.orgId, status: 'ACTIVE' } }))) {
      throw new BadRequestException('Owner is not an active user in this workspace');
    }
  }

  @Perm('leads.view') @Get()
  async list(@Context() ctx: Ctx, @Query() query: unknown) {
    const f = parse(oppListSchema, query);
    const where: Prisma.OpportunityWhereInput = {
      organisationId: ctx.orgId,
      lead: { archivedAt: null, AND: [await this.leads.scope(ctx)] },
      status: f.status,
      leadId: f.leadId,
      ...(f.ownerId === 'me' ? { ownerId: ctx.userId } : f.ownerId === 'unassigned' ? { ownerId: null } : f.ownerId ? { ownerId: f.ownerId } : {}),
      ...(f.q ? { OR: [{ name: { contains: f.q, mode: 'insensitive' } }, { lead: { name: { contains: f.q, mode: 'insensitive' } } }] } : {}),
      ...(f.closeFrom || f.closeTo ? { expectedCloseAt: { gte: f.closeFrom, lte: f.closeTo } } : {}),
    };
    const [rows, total, sums] = await Promise.all([
      this.prisma.opportunity.findMany({
        where, include: oppInclude,
        orderBy: [f.sort === 'expectedCloseAt' ? { expectedCloseAt: { sort: f.dir, nulls: 'last' } } : { [f.sort]: f.dir }, { id: 'desc' }],
        skip: (f.page - 1) * f.pageSize, take: f.pageSize,
      }),
      this.prisma.opportunity.count({ where }),
      this.prisma.opportunity.groupBy({ by: ['status'], where, _count: true, _sum: { value: true } }),
    ]);
    const by = (s: string) => sums.find((x) => x.status === s);
    return {
      items: rows.map(serializeOpp), total, page: f.page, pageSize: f.pageSize,
      totals: { open: { count: by('OPEN')?._count ?? 0, value: num(by('OPEN')?._sum.value) ?? 0 }, won: { count: by('WON')?._count ?? 0, value: num(by('WON')?._sum.value) ?? 0 }, lost: { count: by('LOST')?._count ?? 0, value: num(by('LOST')?._sum.value) ?? 0 } },
    };
  }

  /**
   * Open deals by expected-close month: plain value, probability-weighted value and count, plus deals with no date.
   * Months follow the organisation's timezone. `months` ahead from the current month (past-due open deals go in "overdue").
   */
  @Perm('leads.view') @Get('forecast')
  async forecast(@Context() ctx: Ctx, @Query() query: unknown) {
    const { months } = parse(z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }), query);
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { timezone: true } });
    const open = await this.prisma.opportunity.findMany({
      where: { organisationId: ctx.orgId, status: 'OPEN', lead: { archivedAt: null, AND: [await this.leads.scope(ctx)] } },
      select: { value: true, probability: true, expectedCloseAt: true },
      take: 50_000,
    });
    const monthOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone || 'UTC', year: 'numeric', month: '2-digit' }).format(d);
    const now = new Date();
    const thisMonth = monthOf(now);
    const keys: string[] = [];
    for (let i = 0; i < months; i++) keys.push(monthOf(new Date(now.getFullYear(), now.getMonth() + i, 15)));
    const bucket = () => ({ count: 0, value: 0, weighted: 0 });
    const out: Record<string, ReturnType<typeof bucket>> = { overdue: bucket(), unscheduled: bucket(), later: bucket() };
    for (const k of keys) out[k] = bucket();
    for (const o of open) {
      const v = Number(o.value), w = (v * o.probability) / 100;
      let k: string;
      if (!o.expectedCloseAt) k = 'unscheduled';
      else {
        const m = monthOf(o.expectedCloseAt);
        k = m < thisMonth ? 'overdue' : out[m] ? m : 'later';
      }
      out[k].count++; out[k].value += v; out[k].weighted += w;
    }
    const total = open.reduce((a, o) => ({ count: a.count + 1, value: a.value + Number(o.value), weighted: a.weighted + (Number(o.value) * o.probability) / 100 }), bucket());
    return { timezone: org.timezone, months: keys.map((k) => ({ month: k, ...out[k] })), overdue: out.overdue, unscheduled: out.unscheduled, later: out.later, total };
  }

  @Perm('leads.edit') @Post()
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(oppSchema, body);
    const lead = await this.visibleLead(ctx, d.leadId);
    if (lead.archivedAt) throw new BadRequestException('Restore the lead before adding a deal');
    await this.checkOwner(ctx, d.ownerId);
    const o = await this.prisma.$transaction(async (tx) => {
      const o = await tx.opportunity.create({
        data: { organisationId: ctx.orgId, leadId: d.leadId, name: d.name, value: d.value, probability: d.probability, expectedCloseAt: d.expectedCloseAt ?? null, ownerId: d.ownerId === undefined ? lead.ownerId : d.ownerId, notes: d.notes ?? null, createdById: ctx.userId },
        include: oppInclude,
      });
      await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: d.leadId, actorId: ctx.userId, type: 'opportunity_created', data: { id: o.id, name: o.name, value: d.value } } });
      await tx.lead.update({ where: { id: d.leadId }, data: { lastActivityAt: new Date() } });
      return o;
    });
    return serializeOpp(o);
  }

  @Perm('leads.view') @Get(':id')
  async get(@Context() ctx: Ctx, @Param('id') id: string) {
    const o = await this.find(ctx, id);
    const payments = await this.prisma.payment.findMany({ where: { opportunityId: id, organisationId: ctx.orgId }, include: payInclude, orderBy: { createdAt: 'desc' } });
    return { ...serializeOpp(o), payments: payments.map(serializePayment) };
  }

  @Perm('leads.edit') @Patch(':id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(oppUpdateSchema, body);
    const o = await this.find(ctx, id);
    if (d.ownerId !== undefined && d.ownerId !== o.ownerId) await this.checkOwner(ctx, d.ownerId);
    const data: Prisma.OpportunityUncheckedUpdateInput = { name: d.name, value: d.value, probability: d.probability, expectedCloseAt: d.expectedCloseAt, ownerId: d.ownerId, notes: d.notes, lostReason: d.lostReason };
    const activities: Prisma.LeadActivityCreateManyInput[] = [];
    const base = { organisationId: ctx.orgId, leadId: o.leadId, actorId: ctx.userId };
    if (d.status && d.status !== o.status) {
      data.status = d.status;
      data.closedAt = d.status === 'OPEN' ? null : new Date();
      if (d.status === 'WON') data.probability = 100;
      if (d.status === 'LOST' && d.lostReason === undefined) data.lostReason = o.lostReason;
      if (d.status === 'OPEN') data.lostReason = null;
      activities.push({ ...base, type: d.status === 'WON' ? 'opportunity_won' : d.status === 'LOST' ? 'opportunity_lost' : 'opportunity_reopened', data: { id, name: d.name ?? o.name, value: d.value ?? Number(o.value), lostReason: d.status === 'LOST' ? d.lostReason ?? null : undefined } });
    } else if (Object.values(d).some((v) => v !== undefined)) {
      activities.push({ ...base, type: 'opportunity_updated', data: { id, name: d.name ?? o.name } });
    }
    const events: string[] = [];
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.opportunity.update({ where: { id }, data, include: oppInclude });
      if (activities.length) {
        await tx.leadActivity.createMany({ data: activities });
        await tx.lead.update({ where: { id: o.leadId }, data: { lastActivityAt: new Date() } });
      }
      if (d.status === 'WON' && o.status !== 'WON') events.push(await this.outbox.emit(tx, ctx.orgId, 'opportunity.won', { opportunity: serializeOpp(u) }));
      if (d.status === 'LOST' && o.status !== 'LOST') events.push(await this.outbox.emit(tx, ctx.orgId, 'opportunity.lost', { opportunity: serializeOpp(u) }));
      return u;
    });
    this.outbox.kick(ctx.orgId, events);
    return serializeOpp(updated);
  }

  @Perm('leads.delete') @Delete(':id')
  async remove(@Context() ctx: Ctx, @Param('id') id: string) {
    const o = await this.find(ctx, id);
    const paid = await this.prisma.payment.count({ where: { opportunityId: id, status: 'PAID' } });
    if (paid) throw new BadRequestException('This deal has paid payments; mark it lost instead of deleting it');
    await this.prisma.$transaction([
      this.prisma.opportunity.delete({ where: { id } }),
      this.prisma.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: o.leadId, actorId: ctx.userId, type: 'opportunity_deleted', data: { name: o.name } } }),
      audit(this.prisma, ctx, 'opportunity.deleted', 'opportunity', id, { name: o.name, value: Number(o.value) }),
    ]);
    return { ok: true };
  }
}

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly outbox: OutboxService,
  ) {}

  private async find(ctx: Ctx, id: string) {
    const p = await this.prisma.payment.findFirst({ where: { id, organisationId: ctx.orgId, lead: { AND: [await this.leads.scope(ctx)] } }, include: payInclude });
    if (!p) throw new NotFoundException('Payment not found');
    return p;
  }

  private async where(ctx: Ctx, f: z.infer<typeof paymentListSchema>): Promise<Prisma.PaymentWhereInput> {
    const now = new Date();
    return {
      organisationId: ctx.orgId,
      lead: { AND: [await this.leads.scope(ctx)], ...(f.ownerId === 'me' ? { ownerId: ctx.userId } : f.ownerId ? { ownerId: f.ownerId } : {}) },
      leadId: f.leadId,
      method: f.method,
      ...(f.status === 'OVERDUE' ? { status: 'PENDING', dueAt: { lt: now } } : f.status ? { status: f.status } : {}),
      ...(f.q ? { OR: [{ reference: { contains: f.q, mode: 'insensitive' } }, { lead: { name: { contains: f.q, mode: 'insensitive' } } }, { notes: { contains: f.q, mode: 'insensitive' } }] } : {}),
      // A date window applies to when money was received for paid rows and when it is due for the rest.
      ...(f.from || f.to ? { OR: [{ status: 'PAID', paidAt: { gte: f.from, lte: f.to } }, { status: { not: 'PAID' }, dueAt: { gte: f.from, lte: f.to } }] } : {}),
    };
  }

  @Perm('payments.view') @Get()
  async list(@Context() ctx: Ctx, @Query() query: unknown) {
    const f = parse(paymentListSchema, query);
    const where = await this.where(ctx, f);
    const nullable = f.sort === 'dueAt' || f.sort === 'paidAt';
    const [rows, total, byStatus, overdue] = await Promise.all([
      this.prisma.payment.findMany({ where, include: payInclude, orderBy: [nullable ? { [f.sort]: { sort: f.dir, nulls: 'last' } } : { [f.sort]: f.dir }, { id: 'desc' }], skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.groupBy({ by: ['status'], where, _count: true, _sum: { amount: true } }),
      this.prisma.payment.aggregate({ where: { ...where, status: 'PENDING', dueAt: { lt: new Date() } }, _count: true, _sum: { amount: true } }),
    ]);
    const by = (s: string) => ({ count: byStatus.find((x) => x.status === s)?._count ?? 0, amount: num(byStatus.find((x) => x.status === s)?._sum.amount) ?? 0 });
    return {
      items: rows.map(serializePayment), total, page: f.page, pageSize: f.pageSize,
      totals: { paid: by('PAID'), pending: by('PENDING'), failed: by('FAILED'), refunded: by('REFUNDED'), overdue: { count: overdue._count, amount: num(overdue._sum.amount) ?? 0 } },
    };
  }

  private async checkRefs(ctx: Ctx, leadId: string, opportunityId: string | null | undefined) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] }, select: { id: true, archivedAt: true } });
    if (!lead) throw new BadRequestException('Lead not found');
    if (opportunityId && !(await this.prisma.opportunity.findFirst({ where: { id: opportunityId, leadId, organisationId: ctx.orgId } }))) throw new BadRequestException('Deal not found on this lead');
  }

  @Perm('payments.manage') @Post()
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(paymentSchema, body);
    await this.checkRefs(ctx, d.leadId, d.opportunityId);
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { currency: true } });
    const paidAt = d.status === 'PAID' ? d.paidAt ?? new Date() : null;
    const events: string[] = [];
    const p = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: { organisationId: ctx.orgId, leadId: d.leadId, opportunityId: d.opportunityId ?? null, amount: d.amount, currency: org.currency, status: d.status, method: d.method, reference: d.reference ?? null, notes: d.notes ?? null, dueAt: d.dueAt ?? null, paidAt, createdById: ctx.userId },
        include: payInclude,
      });
      await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: d.leadId, actorId: ctx.userId, type: d.status === 'PAID' ? 'payment_received' : 'payment_recorded', data: { id: p.id, amount: d.amount, currency: org.currency, method: d.method, reference: d.reference ?? null } } });
      await tx.lead.update({ where: { id: d.leadId }, data: { lastActivityAt: new Date() } });
      await audit(tx, ctx, 'payment.created', 'payment', p.id, { amount: d.amount, status: d.status });
      if (d.status === 'PAID') events.push(await this.outbox.emit(tx, ctx.orgId, 'payment.received', { payment: serializePayment(p) }));
      return p;
    });
    this.outbox.kick(ctx.orgId, events);
    return serializePayment(p);
  }

  @Perm('payments.manage') @Patch(':id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(paymentUpdateSchema, body);
    const p = await this.find(ctx, id);
    if (d.opportunityId !== undefined) await this.checkRefs(ctx, p.leadId, d.opportunityId);
    if (p.status === 'REFUNDED' && d.status && d.status !== 'REFUNDED') throw new BadRequestException('A refunded payment cannot be reopened');
    if (d.status === 'REFUNDED' && p.status !== 'PAID' && p.status !== 'REFUNDED') throw new BadRequestException('Only a paid payment can be refunded');
    const data: Prisma.PaymentUncheckedUpdateInput = { opportunityId: d.opportunityId, amount: d.amount, method: d.method, reference: d.reference, notes: d.notes, dueAt: d.dueAt, paidAt: d.paidAt };
    const activities: Prisma.LeadActivityCreateManyInput[] = [];
    const base = { organisationId: ctx.orgId, leadId: p.leadId, actorId: ctx.userId };
    const amt = d.amount ?? Number(p.amount);
    if (d.status && d.status !== p.status) {
      data.status = d.status;
      if (d.status === 'PAID') { data.paidAt = d.paidAt ?? new Date(); activities.push({ ...base, type: 'payment_received', data: { id, amount: amt, currency: p.currency, method: d.method ?? p.method } }); }
      if (d.status === 'REFUNDED') { data.refundedAt = new Date(); activities.push({ ...base, type: 'payment_refunded', data: { id, amount: amt, currency: p.currency } }); }
      if (d.status === 'FAILED') activities.push({ ...base, type: 'payment_failed', data: { id, amount: amt, currency: p.currency } });
      if (d.status === 'PENDING') { data.paidAt = null; activities.push({ ...base, type: 'payment_updated', data: { id, amount: amt, status: 'PENDING' } }); }
    } else if (Object.values(d).some((v) => v !== undefined)) {
      activities.push({ ...base, type: 'payment_updated', data: { id, amount: amt } });
    }
    const events: string[] = [];
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.payment.update({ where: { id }, data, include: payInclude });
      if (activities.length) {
        await tx.leadActivity.createMany({ data: activities });
        await tx.lead.update({ where: { id: p.leadId }, data: { lastActivityAt: new Date() } });
      }
      await audit(tx, ctx, 'payment.updated', 'payment', id, d);
      if (d.status === 'PAID' && p.status !== 'PAID') events.push(await this.outbox.emit(tx, ctx.orgId, 'payment.received', { payment: serializePayment(u) }));
      if (d.status === 'REFUNDED' && p.status !== 'REFUNDED') events.push(await this.outbox.emit(tx, ctx.orgId, 'payment.refunded', { payment: serializePayment(u) }));
      return u;
    });
    this.outbox.kick(ctx.orgId, events);
    return serializePayment(updated);
  }

  /** Creates a Razorpay payment link for an expected payment and stores it on the record. The webhook marks it received. */
  @Perm('payments.manage') @Post(':id/link') @HttpCode(200)
  async link(@Context() ctx: Ctx, @Param('id') id: string) {
    const p = await this.find(ctx, id);
    if (p.status !== 'PENDING') throw new BadRequestException('Only an expected payment can have a payment link');
    const rz = await IntegrationsController.connected(this.prisma, ctx.orgId, 'razorpay');
    if (!rz) throw new BadRequestException('Connect Razorpay under Settings → Integrations first');
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });
    const link = await createPaymentLink(razorpayCredentials.parse(rz.credentials), {
      amount: Number(p.amount), currency: p.currency, description: p.opportunity ? `${p.opportunity.name} — ${org.name}` : `Payment to ${org.name}`, reference: p.id,
      customer: { name: p.lead.name, contact: p.lead.phone, email: await this.prisma.lead.findUnique({ where: { id: p.leadId }, select: { email: true } }).then((l) => l?.email ?? null) },
      notes: { paymentId: p.id, organisationId: ctx.orgId, leadId: p.leadId },
    }).catch((e) => { throw new BadRequestException((e as Error).message); });
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.payment.update({ where: { id }, data: { provider: 'razorpay', providerRef: link.id, linkUrl: link.url, method: 'PAYMENT_LINK' }, include: payInclude });
      await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: p.leadId, actorId: ctx.userId, type: 'payment_link_created', data: { id, amount: Number(p.amount), currency: p.currency, url: link.url } } });
      await audit(tx, ctx, 'payment.link_created', 'payment', id, { provider: 'razorpay', providerRef: link.id });
      return u;
    });
    return serializePayment(updated);
  }

  /** Paid money is never deleted: refund it so the record stays. */
  @Perm('payments.manage') @Delete(':id')
  async remove(@Context() ctx: Ctx, @Param('id') id: string) {
    const p = await this.find(ctx, id);
    if (p.status === 'PAID' || p.status === 'REFUNDED') throw new BadRequestException('Paid or refunded payments cannot be deleted; refund or keep them');
    await this.prisma.$transaction([
      this.prisma.payment.delete({ where: { id } }),
      audit(this.prisma, ctx, 'payment.deleted', 'payment', id, { amount: Number(p.amount), status: p.status }),
    ]);
    return { ok: true };
  }
}
