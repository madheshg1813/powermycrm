import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleInit, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac } from 'crypto';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, pageSchema, parse, randomToken } from '../common/core';
import { QueueService, decrypt, encrypt } from '../common/queue';

/** Event types the outbox can carry. Webhook endpoints subscribe to any of these, or to `*`. */
export const EVENT_TYPES = [
  'lead.created', 'lead.stage_changed', 'lead.assigned', 'lead.archived',
  'opportunity.won', 'opportunity.lost', 'payment.received', 'payment.refunded', 'task.completed', 'call.logged',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const RETRY_LIMIT = 5;
type Db = PrismaService | Prisma.TransactionClient;

/**
 * Outbox: domain events are written inside the same transaction as the change (`emit`), then dispatched
 * by the worker (`kick` after commit, plus a sweep every minute for anything missed) to webhook endpoints.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnApplicationBootstrap {
  private readonly log = new Logger('Outbox');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit() {
    this.queue.work<{ eventId: string }>('outbox.dispatch', async ({ eventId }) => this.dispatch(eventId), { retryLimit: 3, retryDelay: 10 });
    this.queue.work<object>('outbox.sweep', async () => this.sweep(), { retryLimit: 0 });
  }

  async onApplicationBootstrap() {
    // QueueService boots first (it is a dependency), so the schedule can be registered here.
    await this.queue.schedule('outbox.sweep', '* * * * *');
  }

  async emit(db: Db, organisationId: string, type: EventType | 'webhook.test', data: unknown): Promise<string> {
    const row = await db.outboxEvent.create({ data: { organisationId, type, payload: data as Prisma.InputJsonValue } });
    return row.id;
  }

  /**
   * Call after the transaction that emitted the events has committed. Never throws. Workspaces with no active
   * webhook endpoint have nothing to deliver, so their events are marked dispatched at once instead of queued.
   */
  kick(organisationId: string, eventIds: string[]) {
    if (!eventIds.length) return;
    void (async () => {
      try {
        const [endpoints, automations] = await Promise.all([
          this.prisma.webhookEndpoint.count({ where: { organisationId, active: true } }),
          this.prisma.automation.count({ where: { organisationId, active: true } }),
        ]);
        if (!endpoints && !automations) {
          await this.prisma.outboxEvent.updateMany({ where: { id: { in: eventIds }, dispatchedAt: null }, data: { dispatchedAt: new Date() } });
          return;
        }
        for (const eventId of eventIds) await this.queue.send('outbox.dispatch', { eventId }, { singletonKey: eventId });
      } catch (e) {
        this.log.error('Could not queue outbox events: ' + (e as Error).message);
      }
    })();
  }

  /** Creates one delivery per subscribed, active endpoint and queues them. Idempotent. */
  async dispatch(eventId: string) {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: eventId } });
    if (!event || event.dispatchedAt) return;
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { organisationId: event.organisationId, active: true, OR: [{ events: { has: event.type } }, { events: { has: '*' } }] },
    });
    const deliveries = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.webhookDelivery.findMany({ where: { eventId }, select: { endpointId: true } });
      const done = new Set(existing.map((d) => d.endpointId));
      const created = [];
      for (const ep of endpoints) {
        if (done.has(ep.id)) continue;
        created.push(await tx.webhookDelivery.create({ data: { organisationId: event.organisationId, endpointId: ep.id, eventId, eventType: event.type } }));
      }
      await tx.outboxEvent.update({ where: { id: eventId }, data: { dispatchedAt: new Date(), attempts: { increment: 1 } } });
      return created;
    });
    for (const d of deliveries) void this.queue.send('webhook.deliver', { deliveryId: d.id }, { singletonKey: d.id });
    // Automations listening for this event type run through their own queue.
    const automations = await this.prisma.automation.findMany({ where: { organisationId: event.organisationId, active: true, trigger: event.type }, select: { id: true } });
    for (const a of automations) void this.queue.send('automation.run', { automationId: a.id, eventId }, { singletonKey: `${a.id}:${eventId}` });
  }

  async sweep() {
    const stale = await this.prisma.outboxEvent.findMany({ where: { dispatchedAt: null, createdAt: { lt: new Date(Date.now() - 30_000) } }, select: { id: true }, take: 200, orderBy: { createdAt: 'asc' } });
    for (const e of stale) {
      try { await this.dispatch(e.id); } catch (err) { this.log.error(`Sweep could not dispatch ${e.id}: ${(err as Error).message}`); }
    }
  }
}

export function sign(secret: string, timestamp: number, body: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

const endpointSchema = z.object({
  name: z.string().trim().min(1, 'Name the endpoint').max(80),
  url: z.string().trim().url('Enter a valid URL').max(500).refine((u) => /^https?:\/\//i.test(u), 'The URL must start with http:// or https://'),
  events: z.array(z.string()).min(1, 'Choose at least one event').max(50).refine((e) => e.every((x) => x === '*' || (EVENT_TYPES as readonly string[]).includes(x)), 'Unknown event type'),
  active: z.boolean().default(true),
});

/** Outbound webhooks: customer URLs that receive signed JSON for subscribed events, with retries and a delivery log. */
@Controller()
export class WebhooksController implements OnModuleInit {
  private readonly log = new Logger('Webhooks');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit() {
    this.queue.work<{ deliveryId: string }>('webhook.deliver', (d, job) => this.deliver(d.deliveryId, job.retryCount), { retryLimit: RETRY_LIMIT, retryDelay: 60, retryBackoff: true, retryDelayMax: 12 * 3600 });
  }

  /** One HTTP attempt. Throws on failure so the queue retries with backoff; the final failure is parked as FAILED. */
  async deliver(deliveryId: string, retryCount: number) {
    const d = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true, event: true } });
    if (!d || d.status === 'DELIVERED' || !d.endpoint.active) return;
    const body = JSON.stringify({ id: d.event.id, type: d.event.type, createdAt: d.event.createdAt.toISOString(), organisationId: d.organisationId, data: d.event.payload });
    const ts = Date.now();
    let code: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(d.endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'PowerMyCRM-Webhooks/1.0',
          'X-PowerMyCRM-Event': d.event.type,
          'X-PowerMyCRM-Delivery': d.id,
          'X-PowerMyCRM-Signature': `t=${ts},v1=${sign(decrypt(d.endpoint.secret), ts, body)}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
      code = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).name === 'TimeoutError' ? 'Timed out after 10 seconds' : (e as Error).message;
    }
    const final = error !== null && retryCount >= RETRY_LIMIT;
    await this.prisma.$transaction([
      this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { attempts: { increment: 1 }, responseCode: code, error, status: error === null ? 'DELIVERED' : final ? 'FAILED' : 'PENDING', deliveredAt: error === null ? new Date() : null },
      }),
      this.prisma.webhookEndpoint.update({ where: { id: d.endpointId }, data: { lastDeliveryAt: new Date(), lastStatus: code } }),
    ]);
    if (error !== null && !final) throw new Error(`Delivery ${deliveryId} to ${d.endpoint.url} failed: ${error}`);
    if (final) this.log.warn(`Delivery ${deliveryId} parked as failed after ${retryCount + 1} attempts: ${error}`);
  }

  private async find(ctx: Ctx, id: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!ep) throw new NotFoundException('Webhook endpoint not found');
    return ep;
  }

  private present(ep: { id: string; name: string; url: string; events: string[]; active: boolean; lastDeliveryAt: Date | null; lastStatus: number | null; createdAt: Date }) {
    return { id: ep.id, name: ep.name, url: ep.url, events: ep.events, active: ep.active, lastDeliveryAt: ep.lastDeliveryAt, lastStatus: ep.lastStatus, createdAt: ep.createdAt };
  }

  @Get('webhook-events')
  eventTypes() {
    return EVENT_TYPES;
  }

  @Perm('settings.manage') @Get('webhook-endpoints')
  async list(@Context() ctx: Ctx) {
    const [rows, counts] = await Promise.all([
      this.prisma.webhookEndpoint.findMany({ where: { organisationId: ctx.orgId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.webhookDelivery.groupBy({ by: ['endpointId', 'status'], where: { organisationId: ctx.orgId }, _count: true }),
    ]);
    return rows.map((ep) => ({
      ...this.present(ep),
      deliveries: Object.fromEntries((['PENDING', 'DELIVERED', 'FAILED'] as const).map((s) => [s.toLowerCase(), counts.find((c) => c.endpointId === ep.id && c.status === s)?._count ?? 0])),
    }));
  }

  @Perm('settings.manage') @Post('webhook-endpoints')
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(endpointSchema, body);
    if ((await this.prisma.webhookEndpoint.count({ where: { organisationId: ctx.orgId } })) >= 20) throw new BadRequestException('A workspace can have up to 20 webhook endpoints');
    const secret = `whsec_${randomToken()}`;
    const ep = await this.prisma.webhookEndpoint.create({ data: { organisationId: ctx.orgId, name: d.name, url: d.url, events: [...new Set(d.events)], active: d.active, secret: encrypt(secret), createdById: ctx.userId } });
    await audit(this.prisma, ctx, 'webhook.created', 'webhook_endpoint', ep.id, { name: d.name, url: d.url });
    // The secret is returned once; afterwards it can only be rotated.
    return { ...this.present(ep), secret };
  }

  @Perm('settings.manage') @Patch('webhook-endpoints/:id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(endpointSchema.partial(), body);
    await this.find(ctx, id);
    const ep = await this.prisma.webhookEndpoint.update({ where: { id }, data: { name: d.name, url: d.url, events: d.events ? [...new Set(d.events)] : undefined, active: d.active } });
    await audit(this.prisma, ctx, 'webhook.updated', 'webhook_endpoint', id, d);
    return this.present(ep);
  }

  @Perm('settings.manage') @Post('webhook-endpoints/:id/rotate-secret') @HttpCode(200)
  async rotate(@Context() ctx: Ctx, @Param('id') id: string) {
    await this.find(ctx, id);
    const secret = `whsec_${randomToken()}`;
    await this.prisma.webhookEndpoint.update({ where: { id }, data: { secret: encrypt(secret) } });
    await audit(this.prisma, ctx, 'webhook.secret_rotated', 'webhook_endpoint', id);
    return { secret };
  }

  @Perm('settings.manage') @Delete('webhook-endpoints/:id')
  async remove(@Context() ctx: Ctx, @Param('id') id: string) {
    const ep = await this.find(ctx, id);
    await this.prisma.$transaction([this.prisma.webhookEndpoint.delete({ where: { id } }), audit(this.prisma, ctx, 'webhook.deleted', 'webhook_endpoint', id, { name: ep.name })]);
    return { ok: true };
  }

  /** Sends a `webhook.test` event to this endpoint only, bypassing its subscriptions. */
  @Perm('settings.manage') @Post('webhook-endpoints/:id/test') @HttpCode(200)
  async test(@Context() ctx: Ctx, @Param('id') id: string) {
    const ep = await this.find(ctx, id);
    const delivery = await this.prisma.$transaction(async (tx) => {
      const eventId = await this.outbox.emit(tx, ctx.orgId, 'webhook.test', { message: 'This is a test event from PowerMyCRM', endpoint: ep.name, sentBy: ctx.userId });
      await tx.outboxEvent.update({ where: { id: eventId }, data: { dispatchedAt: new Date() } });
      return tx.webhookDelivery.create({ data: { organisationId: ctx.orgId, endpointId: ep.id, eventId, eventType: 'webhook.test' } });
    });
    await this.queue.send('webhook.deliver', { deliveryId: delivery.id }, { singletonKey: delivery.id });
    return { deliveryId: delivery.id };
  }

  @Perm('settings.manage') @Get('webhook-endpoints/:id/deliveries')
  async deliveries(@Context() ctx: Ctx, @Param('id') id: string, @Query() query: unknown) {
    await this.find(ctx, id);
    const f = parse(z.object({ ...pageSchema, status: z.enum(['PENDING', 'DELIVERED', 'FAILED']).optional() }), query);
    const where = { endpointId: id, organisationId: ctx.orgId, status: f.status };
    const [items, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return { items, total, page: f.page, pageSize: f.pageSize };
  }

  /** Re-queues a failed or stuck delivery as a fresh attempt. */
  @Perm('settings.manage') @Post('webhook-deliveries/:id/retry') @HttpCode(200)
  async retry(@Context() ctx: Ctx, @Param('id') id: string) {
    const d = await this.prisma.webhookDelivery.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!d) throw new NotFoundException('Delivery not found');
    if (d.status === 'DELIVERED') throw new BadRequestException('This delivery already succeeded');
    await this.prisma.webhookDelivery.update({ where: { id }, data: { status: 'PENDING', error: null } });
    await this.queue.send('webhook.deliver', { deliveryId: id }, { singletonKey: `${id}:${Date.now()}` });
    return { ok: true };
  }
}
