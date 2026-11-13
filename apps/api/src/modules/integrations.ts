import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Logger, NotFoundException, OnApplicationBootstrap, OnModuleInit, Param, Patch, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, Public, audit, normalizePhone, pageSchema, parse, randomToken, sha256 } from '../common/core';
import { mapExotelStatus } from './providers/exotel';
import { fetchMetaLead, indiamartCredentials, metaLeadsCredentials, normalizeJustdial, pullIndiamart } from './providers/leadsources';
import { verifyMetaSignature } from './providers/whatsapp';
import { razorpayCredentials, verifyRazorpayWebhook } from './providers/razorpay';
import { OutboxService } from './webhooks';
import { ConflictException } from '@nestjs/common';
import { QueueService, decrypt, encrypt, safeEqual } from '../common/queue';
import { EmailService, layout } from './email';
import { PROVIDER_KEYS, PROVIDERS as REGISTRY, providerByKey } from './providers/registry';
import { IngestOptions, LeadsService } from './leads';

// ---- Provider registry lives in ./providers; secrets are masked on the way out, tests run against the real service. ----
export { PROVIDERS } from './providers/registry';
export type { CredentialField } from './providers/index';

/** CRM fields a website form can fill. `cf_<key>` entries are added per workspace from its custom fields. */
export const MAPPABLE_FIELDS = ['name', 'phone', 'email', 'company', 'city', 'message', 'source'] as const;
const DEFAULT_MAPPING: Record<string, string> = { name: 'name', phone: 'phone', email: 'email', company: 'company', city: 'city', message: 'message', source: 'source' };

const settingsSchema = z.object({
  sourceId: z.string().nullable().default(null),
  ownerId: z.string().nullable().default('auto'), // 'auto' = assignment rules, null = unassigned, or a user id
  duplicateStrategy: z.enum(['skip', 'update', 'create']).default('skip'),
  redirectUrl: z.string().trim().url().max(500).nullable().default(null),
});
const integrationSchema = z.object({
  provider: z.enum(PROVIDER_KEYS),
  name: z.string().trim().min(1, 'Name the integration').max(80),
  settings: settingsSchema.default({}),
  fieldMapping: z.record(z.string(), z.string().trim().max(80)).default({}),
  credentials: z.record(z.string(), z.any()).optional(),
});
/** Validates provider credentials with the provider's schema and returns what is stored (encrypted). Blank secrets on edit keep the stored value. */
function cleanCredentials(provider: string, raw: unknown, existing?: Record<string, unknown>): Record<string, unknown> {
  const def = providerByKey(provider);
  if (!def || def.auth !== 'credentials') return {};
  const merged: Record<string, unknown> = { ...(existing ?? {}), ...((raw ?? {}) as Record<string, unknown>) };
  for (const k of def.secretKeys) if (existing && !(raw as Record<string, unknown>)?.[k]) merged[k] = existing[k];
  const r = def.credentials.safeParse(merged);
  if (!r.success) throw new BadRequestException({ message: r.error.issues[0]?.message ?? `Check the ${def.name} details`, errors: r.error.issues.map((i) => ({ path: `credentials.${i.path.join('.')}`, message: i.message })) });
  return r.data as Record<string, unknown>;
}
const publicUrl = () => (process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Maps a raw submission to lead fields using the integration's mapping (CRM field -> form field name). */
export function applyMapping(payload: Record<string, unknown>, mapping: Record<string, string>) {
  const m = { ...DEFAULT_MAPPING, ...mapping };
  const pick = (crmField: string) => {
    const from = m[crmField];
    if (!from) return undefined;
    const v = payload[from];
    return v === undefined || v === null ? undefined : Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  const customFields: Record<string, unknown> = {};
  for (const k of Object.keys(m)) if (k.startsWith('cf_') && pick(k) !== undefined) customFields[k.slice(3)] = pick(k);
  return { name: pick('name'), phone: pick('phone'), email: pick('email'), company: pick('company'), city: pick('city'), message: pick('message'), sourceName: pick('source'), customFields };
}

@Controller()
export class IntegrationsController implements OnModuleInit, OnApplicationBootstrap {
  private readonly log = new Logger('Integrations');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly leads: LeadsService,
    private readonly email: EmailService,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit() {
    this.queue.work<{ eventId: string }>('integration.inbound', ({ eventId }) => this.processInbound(eventId), { retryLimit: 5, retryDelay: 60 });
    this.queue.work<object>('indiamart.poll', async () => { await this.pollAllIndiamart(); }, { retryLimit: 0 });
  }

  async onApplicationBootstrap() {
    // IndiaMART allows one pull every five minutes per key.
    await this.queue.schedule('indiamart.poll', '*/5 * * * *');
  }

  /** Stores an inbound lead once (de-duplicated on externalId) and queues it for processing. Returns null for a repeat. */
  private async recordInbound(integration: { id: string; organisationId: string }, externalId: string | null, type: string, payload: Record<string, unknown>) {
    try {
      const ev = await this.prisma.integrationEvent.create({ data: { organisationId: integration.organisationId, integrationId: integration.id, direction: 'IN', externalId, type, payload: payload as Prisma.InputJsonObject, status: 'PENDING' } });
      await this.queue.send('integration.inbound', { eventId: ev.id }, { singletonKey: ev.id });
      return ev;
    } catch (e) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') return null;
      throw e;
    }
  }

  /** Pulls new IndiaMART enquiries for one integration, from where the previous pull stopped (at most 7 days back). */
  async pullIndiamart(integrationId: string) {
    const i = await this.prisma.integration.findUnique({ where: { id: integrationId } });
    if (!i || i.provider !== 'indiamart' || i.status !== 'CONNECTED' || !i.credentials) return { pulled: 0, created: 0 };
    const creds = indiamartCredentials.parse(JSON.parse(decrypt(i.credentials)));
    const settings = (i.settings ?? {}) as Record<string, unknown>;
    const now = new Date();
    const last = typeof settings.lastPulledAt === 'string' ? new Date(settings.lastPulledAt) : new Date(now.getTime() - 24 * 3600e3);
    const from = new Date(Math.max(last.getTime() - 60_000, now.getTime() - 7 * 864e5));
    try {
      const r = await pullIndiamart(creds.crmKey, from, now);
      if (r.code === 429) return { pulled: 0, created: 0, throttled: true };
      let created = 0;
      for (const l of r.leads) if (await this.recordInbound(i, l.externalId, 'enquiry', l.lead)) created++;
      await this.prisma.integration.update({ where: { id: i.id }, data: { settings: { ...settings, lastPulledAt: now.toISOString() } as Prisma.InputJsonObject, lastError: null, ...(r.leads.length ? { lastEventAt: now } : {}) } });
      return { pulled: r.leads.length, created };
    } catch (e) {
      await this.prisma.integration.update({ where: { id: i.id }, data: { lastError: (e as Error).message.slice(0, 300) } });
      throw new BadRequestException((e as Error).message);
    }
  }

  async pollAllIndiamart() {
    const rows = await this.prisma.integration.findMany({ where: { provider: 'indiamart', status: 'CONNECTED' }, select: { id: true } });
    for (const r of rows) await this.pullIndiamart(r.id).catch((e) => this.log.warn(`IndiaMART pull ${r.id} failed: ${(e as Error).message}`));
  }

  /** Pull now, from Settings. */
  @Perm('settings.manage') @Post('integrations/:id/pull') @HttpCode(200)
  async pullNow(@Context() ctx: Ctx, @Param('id') id: string) {
    const i = await this.find(ctx, id);
    if (i.provider !== 'indiamart') throw new BadRequestException('Only IndiaMART is pulled; other sources push leads to their webhook');
    if (i.status !== 'CONNECTED') throw new BadRequestException('Connect IndiaMART first');
    return this.pullIndiamart(id);
  }

  /** Justdial pushes each enquiry (GET query or POST body) to this URL with the integration token. */
  @Public() @Post('hooks/justdial/:id') @HttpCode(200)
  async justdialPost(@Param('id') id: string, @Body() body: Record<string, unknown>, @Query() query: Record<string, unknown>) {
    return this.justdialHook(id, { ...(query ?? {}), ...(body ?? {}) });
  }
  @Public() @Get('hooks/justdial/:id')
  async justdialGet(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.justdialHook(id, query ?? {});
  }
  private async justdialHook(id: string, p: Record<string, unknown>) {
    const i = await this.prisma.integration.findFirst({ where: { id, provider: 'justdial' } });
    if (!i || i.status !== 'CONNECTED' || !i.credentials) throw new NotFoundException('This endpoint is not active');
    const { token: expected } = JSON.parse(decrypt(i.credentials)) as { token: string };
    if (typeof p.token !== 'string' || !safeEqual(p.token, expected)) throw new UnauthorizedException('Invalid token');
    const { token: _t, ...fields } = p;
    const n = normalizeJustdial(fields);
    const ev = await this.recordInbound(i, n.externalId, 'enquiry', n.lead);
    // Justdial expects a plain RECEIVED acknowledgement.
    return ev ? 'RECEIVED' : 'RECEIVED (duplicate)';
  }

  /** Meta lead ads: verification handshake, then signed leadgen notifications whose details are fetched by the worker. */
  @Public() @Get('hooks/meta_leads/:id')
  async metaVerify(@Param('id') id: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const i = await this.prisma.integration.findFirst({ where: { id, provider: 'meta_leads' } });
    if (!i?.credentials) throw new NotFoundException('Unknown integration');
    const creds = metaLeadsCredentials.parse(JSON.parse(decrypt(i.credentials)));
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && safeEqual(q['hub.verify_token'], creds.verifyToken)) return res.status(200).type('text/plain').send(q['hub.challenge'] ?? '');
    throw new UnauthorizedException('Verify token does not match');
  }

  @Public() @Post('hooks/meta_leads/:id') @HttpCode(200)
  async metaLeadgen(@Param('id') id: string, @Body() body: any, @Headers('x-hub-signature-256') sig: string | undefined, @Req() req: Request & { rawBody?: Buffer }) {
    const i = await this.prisma.integration.findFirst({ where: { id, provider: 'meta_leads' } });
    if (!i?.credentials || i.status !== 'CONNECTED') throw new NotFoundException('Unknown integration');
    const creds = metaLeadsCredentials.parse(JSON.parse(decrypt(i.credentials)));
    if (!req.rawBody || !verifyMetaSignature(req.rawBody, sig, creds.appSecret)) throw new UnauthorizedException('Invalid signature');
    let queued = 0;
    for (const entry of body?.entry ?? []) for (const ch of entry.changes ?? []) {
      if (ch.field !== 'leadgen' || !ch.value?.leadgen_id) continue;
      const v = ch.value;
      if (await this.recordInbound(i, `fb:${v.leadgen_id}`, 'leadgen', { leadgenId: String(v.leadgen_id), formId: v.form_id ? String(v.form_id) : undefined, adId: v.ad_id ? String(v.ad_id) : undefined, pageId: v.page_id ? String(v.page_id) : undefined })) queued++;
    }
    return { ok: true, queued };
  }

  // ---- Worker ------------------------------------------------------------------------

  /** Turns a stored inbound event into a lead. Validation problems park the event as FAILED; infrastructure errors retry. */
  async processInbound(eventId: string) {
    const ev = await this.prisma.integrationEvent.findUnique({ where: { id: eventId }, include: { integration: true } });
    if (!ev || ev.status !== 'PENDING') return;
    const settings = settingsSchema.parse(ev.integration.settings ?? {});
    try {
      let payload = ev.payload as Record<string, unknown>;
      if (ev.integration.provider === 'meta_leads' && payload.leadgenId && !payload.fetched) {
        if (!ev.integration.credentials) throw new BadRequestException('Meta credentials are missing');
        const lead = await fetchMetaLead(metaLeadsCredentials.parse(JSON.parse(decrypt(ev.integration.credentials))), String(payload.leadgenId));
        payload = { ...payload, ...lead, fetched: true };
        await this.prisma.integrationEvent.update({ where: { id: eventId }, data: { payload: payload as Prisma.InputJsonObject } });
      }
      const mapped = applyMapping(payload, (ev.integration.fieldMapping ?? {}) as Record<string, string>);
      const opts: IngestOptions = { ownerId: settings.ownerId, duplicateStrategy: settings.duplicateStrategy, sourceId: settings.sourceId, via: ev.integration.provider, integrationId: ev.integrationId };
      const r = await this.leads.ingest(ev.organisationId, mapped, opts);
      await this.prisma.$transaction([
        this.prisma.integrationEvent.update({ where: { id: eventId }, data: { status: r.outcome === 'skipped' ? 'SKIPPED' : 'PROCESSED', leadId: r.leadId, processedAt: new Date(), attempts: { increment: 1 }, error: null } }),
        this.prisma.integration.update({ where: { id: ev.integrationId }, data: { lastEventAt: new Date(), lastError: null, status: ev.integration.status === 'ERROR' ? 'CONNECTED' : undefined } }),
      ]);
    } catch (e) {
      const message = (e as { response?: { message?: string } }).response?.message ?? (e as Error).message;
      const permanent = e instanceof BadRequestException;
      await this.prisma.$transaction([
        this.prisma.integrationEvent.update({ where: { id: eventId }, data: { status: permanent ? 'FAILED' : 'PENDING', error: message, attempts: { increment: 1 }, processedAt: permanent ? new Date() : null } }),
        this.prisma.integration.update({ where: { id: ev.integrationId }, data: { lastError: message } }),
      ]);
      if (!permanent) throw e;
    }
  }

  // ---- Public inbound endpoint ---------------------------------------------------------

  /**
   * Website form target. Accepts JSON or form-encoded bodies, authenticated by the integration's token
   * (query `token`, header `X-Form-Token` or field `_token`). Stores the submission and queues it; replies at once.
   */
  @Public() @Post('hooks/website_form/:id')
  async websiteForm(@Param('id') id: string, @Body() body: unknown, @Query('token') qToken: string | undefined, @Headers('x-form-token') hToken: string | undefined, @Req() req: Request, @Res() res: Response) {
    const integration = await this.prisma.integration.findFirst({ where: { id, provider: 'website_form' } });
    if (!integration || integration.status !== 'CONNECTED' || !integration.credentials) throw new NotFoundException('This form endpoint is not active');
    const payload = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const token = qToken ?? hToken ?? (typeof payload._token === 'string' ? payload._token : '');
    const { token: expected } = JSON.parse(decrypt(integration.credentials)) as { token: string };
    if (!token || !safeEqual(token, expected)) throw new UnauthorizedException('Invalid form token');

    const settings = settingsSchema.parse(integration.settings ?? {});
    const { _token: _t, _hp, _id, ...fields } = payload;
    const externalId = typeof _id === 'string' && _id ? _id.slice(0, 120) : req.get('x-request-id')?.slice(0, 120) ?? null;
    const honeypot = typeof _hp === 'string' && _hp.trim() !== '';
    let event;
    try {
      event = await this.prisma.integrationEvent.create({
        data: { organisationId: integration.organisationId, integrationId: integration.id, direction: 'IN', externalId, type: 'form.submitted', payload: fields as Prisma.InputJsonObject, status: honeypot ? 'SKIPPED' : 'PENDING', error: honeypot ? 'Honeypot field was filled in' : null, processedAt: honeypot ? new Date() : null },
      });
    } catch (e) {
      // Same externalId seen before: acknowledge without creating a second lead.
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002' && externalId) {
        const existing = await this.prisma.integrationEvent.findUnique({ where: { integrationId_externalId: { integrationId: integration.id, externalId } } });
        return res.status(200).json({ ok: true, id: existing?.id, duplicate: true });
      }
      throw e;
    }
    if (!honeypot) await this.queue.send('integration.inbound', { eventId: event.id }, { singletonKey: event.id });
    const wantsHtml = (req.get('content-type') ?? '').includes('application/x-www-form-urlencoded') && !(req.get('accept') ?? '').includes('application/json');
    if (settings.redirectUrl && wantsHtml) return res.redirect(303, settings.redirectUrl);
    return res.status(202).json({ ok: true, id: event.id });
  }

  /**
   * Razorpay webhook: signed with HMAC-SHA256 of the raw body under the integration's webhook secret.
   * payment_link.paid marks the matching payment received; payment.failed is recorded on the event log.
   */
  @Public() @Post('hooks/razorpay/:id') @HttpCode(200)
  async razorpayHook(@Param('id') id: string, @Body() body: any, @Headers('x-razorpay-signature') signature: string | undefined, @Headers('x-razorpay-event-id') eventId: string | undefined, @Req() req: Request & { rawBody?: Buffer }) {
    const integration = await this.prisma.integration.findFirst({ where: { id, provider: 'razorpay' } });
    if (!integration || integration.status !== 'CONNECTED' || !integration.credentials) throw new NotFoundException('Unknown integration');
    const creds = razorpayCredentials.parse(JSON.parse(decrypt(integration.credentials)));
    if (!req.rawBody || !verifyRazorpayWebhook(req.rawBody, signature, creds.webhookSecret)) throw new UnauthorizedException('Invalid webhook signature');
    const type = String(body?.event ?? 'unknown');
    const externalId = eventId ? `rzp:${eventId}` : null;
    let event;
    try {
      event = await this.prisma.integrationEvent.create({ data: { organisationId: integration.organisationId, integrationId: integration.id, direction: 'IN', externalId, type, payload: body as Prisma.InputJsonObject, status: 'PENDING' } });
    } catch (e) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') return { ok: true, duplicate: true };
      throw e;
    }
    let result = 'Ignored event type';
    let leadId: string | null = null;
    try {
      if (type === 'payment_link.paid' || type === 'payment.captured') {
        const linkId = body?.payload?.payment_link?.entity?.id ?? body?.payload?.payment?.entity?.notes?.paymentLinkId;
        const paymentRef = body?.payload?.payment?.entity?.id ?? null;
        const payment = linkId ? await this.prisma.payment.findFirst({ where: { organisationId: integration.organisationId, provider: 'razorpay', providerRef: String(linkId) } }) : null;
        if (!payment) result = 'No payment matches this link';
        else if (payment.status === 'PAID') result = 'Payment was already marked received';
        else {
          const events: string[] = [];
          const updated = await this.prisma.$transaction(async (tx) => {
            const u = await tx.payment.update({ where: { id: payment.id }, data: { status: 'PAID', paidAt: new Date(), method: 'PAYMENT_LINK', reference: paymentRef ? String(paymentRef) : payment.reference } });
            await tx.leadActivity.create({ data: { organisationId: integration.organisationId, leadId: payment.leadId, actorId: null, type: 'payment_received', data: { id: payment.id, amount: Number(payment.amount), currency: payment.currency, method: 'PAYMENT_LINK', reference: paymentRef ?? null, via: 'razorpay' } } });
            await tx.lead.update({ where: { id: payment.leadId }, data: { lastActivityAt: new Date() } });
            events.push(await this.outbox.emit(tx, integration.organisationId, 'payment.received', { payment: { ...u, amount: Number(u.amount) }, via: 'razorpay' }));
            return u;
          });
          this.outbox.kick(integration.organisationId, events);
          leadId = updated.leadId;
          result = 'Payment marked received';
        }
      } else if (type === 'payment.failed') {
        result = `Payment attempt failed: ${body?.payload?.payment?.entity?.error_description ?? 'no reason given'}`;
      }
      await this.prisma.integrationEvent.update({ where: { id: event.id }, data: { status: type === 'payment_link.paid' || type === 'payment.captured' ? (leadId ? 'PROCESSED' : 'SKIPPED') : 'SKIPPED', leadId, error: leadId ? null : result, processedAt: new Date(), attempts: 1 } });
      await this.prisma.integration.update({ where: { id: integration.id }, data: { lastEventAt: new Date() } });
    } catch (e) {
      await this.prisma.integrationEvent.update({ where: { id: event.id }, data: { status: 'FAILED', error: (e as Error).message.slice(0, 300), attempts: 1 } });
      throw e;
    }
    return { ok: true, result };
  }

  /**
   * Exotel callbacks: the terminal StatusCallback of a click-to-call (identified by CustomField = our call id)
   * and the passthru of an incoming call. Exotel does not sign callbacks; the integration id in the path is the shared secret.
   */
  @Public() @Post('hooks/exotel/:id') @HttpCode(200)
  async exotelHook(@Param('id') id: string, @Body() body: Record<string, any>, @Query() query: Record<string, any>) {
    const integration = await this.prisma.integration.findFirst({ where: { id, provider: 'exotel' } });
    if (!integration || integration.status !== 'CONNECTED') throw new NotFoundException('Unknown integration');
    const p = { ...(query ?? {}), ...(body ?? {}) };
    const sid = String(p.CallSid ?? p.Sid ?? '');
    const customField = String(p.CustomField ?? '');
    const org = integration.organisationId;
    const existing = (customField && (await this.prisma.call.findFirst({ where: { id: customField, organisationId: org } }))) || (sid && (await this.prisma.call.findFirst({ where: { organisationId: org, provider: 'exotel', providerRef: sid } }))) || null;
    const terminal = p.Status !== undefined && !['in-progress', 'ringing', 'queued'].includes(String(p.Status).toLowerCase());
    const duration = p.ConversationDuration ?? p.Duration;
    const events: string[] = [];
    if (existing) {
      const data: Prisma.CallUncheckedUpdateInput = { providerRef: existing.providerRef ?? (sid || null), recordingUrl: p.RecordingUrl ? String(p.RecordingUrl) : existing.recordingUrl };
      if (terminal) { data.status = mapExotelStatus(String(p.Status)); data.durationSec = duration !== undefined && duration !== '' ? Number(duration) : existing.durationSec; }
      else if (existing.status === 'INITIATED') data.status = 'IN_PROGRESS';
      const call = await this.prisma.$transaction(async (tx) => {
        const c = await tx.call.update({ where: { id: existing.id }, data });
        if (terminal && c.leadId) {
          await tx.leadActivity.create({ data: { organisationId: org, leadId: c.leadId, actorId: c.userId, type: 'call_logged', data: { id: c.id, direction: c.direction, status: c.status, durationSec: c.durationSec, recordingUrl: c.recordingUrl, via: 'exotel' } } });
          await tx.lead.update({ where: { id: c.leadId }, data: { lastActivityAt: new Date() } });
          events.push(await this.outbox.emit(tx, org, 'call.logged', { call: { id: c.id, direction: c.direction, status: c.status, durationSec: c.durationSec, userId: c.userId, recordingUrl: c.recordingUrl }, lead: { id: c.leadId } }));
        }
        return c;
      });
      this.outbox.kick(org, events);
      return { ok: true, callId: call.id, status: call.status };
    }
    // Unknown sid: an incoming call on the ExoPhone.
    const from = String(p.CallFrom ?? p.From ?? '');
    const normalized = normalizePhone(from);
    const lead = normalized ? await this.prisma.lead.findFirst({ where: { organisationId: org, phoneNormalized: normalized, archivedAt: null }, orderBy: { createdAt: 'desc' } }) : null;
    const owner = lead?.ownerId ?? (await this.prisma.membership.findFirst({ where: { organisationId: org, status: 'ACTIVE', role: { systemKey: 'owner' } } }))?.userId;
    if (!owner) return { ok: true, ignored: true };
    const call = await this.prisma.$transaction(async (tx) => {
      const c = await tx.call.create({ data: { organisationId: org, leadId: lead?.id ?? null, userId: owner, direction: 'INBOUND', status: terminal ? mapExotelStatus(String(p.Status)) : 'IN_PROGRESS', phone: from || null, durationSec: terminal && duration !== undefined ? Number(duration) : null, provider: 'exotel', providerRef: sid || null, recordingUrl: p.RecordingUrl ? String(p.RecordingUrl) : null } });
      await tx.notification.create({ data: { organisationId: org, userId: owner, type: 'call.incoming', title: `Incoming call from ${lead?.name ?? (from || 'unknown number')}`, link: lead ? `/leads/${lead.id}?tab=calls` : '/leads' } });
      if (lead) {
        await tx.leadActivity.create({ data: { organisationId: org, leadId: lead.id, actorId: null, type: 'call_logged', data: { id: c.id, direction: 'INBOUND', status: c.status, durationSec: c.durationSec, via: 'exotel' } } });
        await tx.lead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date() } });
      }
      return c;
    });
    return { ok: true, callId: call.id, lead: lead?.id ?? null };
  }

  // ---- Admin ----------------------------------------------------------------------------

  private async find(ctx: Ctx, id: string) {
    const i = await this.prisma.integration.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!i) throw new NotFoundException('Integration not found');
    return i;
  }

  private present(i: { id: string; provider: string; name: string; status: string; settings: unknown; fieldMapping: unknown; credentials: string | null; lastError: string | null; lastEventAt: Date | null; createdAt: Date }) {
    const def = providerByKey(i.provider);
    const creds = i.credentials ? (JSON.parse(decrypt(i.credentials)) as Record<string, unknown>) : null;
    // Secrets never leave the server. A form token is embedded in public HTML anyway, so forms get theirs back.
    const token = def?.auth === 'webhook_only' && creds ? String(creds.token) : null;
    const credentials = def?.auth === 'credentials' && creds
      ? Object.fromEntries(Object.entries(creds).filter(([k]) => !def.secretKeys.includes(k)).concat(def.secretKeys.map((k) => [`has_${k}`, !!creds[k]])))
      : null;
    return {
      id: i.id, provider: i.provider, name: i.name, status: i.status, settings: i.settings, fieldMapping: i.fieldMapping, lastError: i.lastError, lastEventAt: i.lastEventAt, createdAt: i.createdAt,
      token, credentials,
      endpointUrl: i.provider === 'website_form' ? `${publicUrl()}/api/v1/hooks/website_form/${i.id}` : def?.webhook ? `${publicUrl()}/api/v1/hooks/${def.webhook.path}/${i.id}${def.auth === 'webhook_only' && token ? `?token=${token}` : ''}` : null,
    };
  }

  /** Runs the provider's connection test against the real service and records the outcome. Returns the row plus the test summary. */
  private async testConnection(i: { id: string; provider: string; credentials: string | null }) {
    const def = providerByKey(i.provider);
    try {
      if (!def?.test) throw new Error('This provider has no connection test');
      if (!i.credentials) throw new Error('No credentials saved yet');
      const summary = await def.test(JSON.parse(decrypt(i.credentials)), { verifySmtp: (cfg) => this.email.verify(cfg as any) });
      return { row: await this.prisma.integration.update({ where: { id: i.id }, data: { status: 'CONNECTED', lastError: null } }), summary };
    } catch (e) {
      const message = ((e as Error).message || 'Connection failed').slice(0, 300);
      return { row: await this.prisma.integration.update({ where: { id: i.id }, data: { status: 'ERROR', lastError: message } }), summary: null };
    }
  }

  /** Decrypted credentials of a connected provider, or null. Used by payments, calls and messaging. */
  static async connected(prisma: PrismaService, organisationId: string, provider: string) {
    const i = await prisma.integration.findFirst({ where: { organisationId, provider, status: 'CONNECTED', credentials: { not: null } } });
    return i ? { id: i.id, settings: i.settings as Record<string, unknown>, credentials: JSON.parse(decrypt(i.credentials!)) as Record<string, unknown> } : null;
  }

  private async checkSettings(ctx: Ctx, s: z.infer<typeof settingsSchema>) {
    if (s.sourceId && !(await this.prisma.leadSource.findFirst({ where: { id: s.sourceId, organisationId: ctx.orgId } }))) throw new BadRequestException('Lead source not found');
    if (s.ownerId && s.ownerId !== 'auto' && !(await this.prisma.membership.findFirst({ where: { userId: s.ownerId, organisationId: ctx.orgId, status: 'ACTIVE' } }))) throw new BadRequestException('Owner is not an active user in this workspace');
  }

  @Perm('settings.manage') @Get('integrations/providers')
  async providers(@Context() ctx: Ctx) {
    const fields = await this.prisma.customField.findMany({ where: { organisationId: ctx.orgId }, orderBy: { position: 'asc' } });
    const providers = REGISTRY.map(({ credentials: _c, test: _t, ...p }) => p);
    return { providers, mappableFields: [...MAPPABLE_FIELDS, ...fields.map((f) => `cf_${f.key}`)], fieldLabels: Object.fromEntries(fields.map((f) => [`cf_${f.key}`, f.label])) };
  }

  /** Which providers are connected right now; any signed-in user may ask so screens can offer the right buttons. */
  @Get('integrations/connected')
  async connectedProviders(@Context() ctx: Ctx) {
    const rows = await this.prisma.integration.findMany({ where: { organisationId: ctx.orgId, status: 'CONNECTED' }, select: { provider: true } });
    return Object.fromEntries(REGISTRY.map((p) => [p.key, rows.some((r) => r.provider === p.key)]));
  }

  /** Whether email can be sent for this workspace, and through what. */
  @Perm('settings.manage') @Get('integrations/email-status')
  async emailStatus(@Context() ctx: Ctx) {
    const transport = await this.email.transportFor(ctx.orgId);
    const own = await this.prisma.integration.findFirst({ where: { organisationId: ctx.orgId, provider: 'smtp' } });
    return { canSend: !!transport, via: transport?.provider ?? null, platformConfigured: !!process.env.SMTP_HOST, integration: own ? this.present(own) : null };
  }

  @Perm('settings.manage') @Get('integrations')
  async list(@Context() ctx: Ctx) {
    const [rows, counts] = await Promise.all([
      this.prisma.integration.findMany({ where: { organisationId: ctx.orgId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.integrationEvent.groupBy({ by: ['integrationId', 'status'], where: { organisationId: ctx.orgId }, _count: true }),
    ]);
    return rows.map((i) => ({
      ...this.present(i),
      events: Object.fromEntries((['PENDING', 'PROCESSED', 'SKIPPED', 'FAILED'] as const).map((s) => [s.toLowerCase(), counts.find((c) => c.integrationId === i.id && c.status === s)?._count ?? 0])),
    }));
  }

  @Perm('settings.manage') @Post('integrations')
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const d = parse(integrationSchema, body);
    await this.checkSettings(ctx, d.settings);
    if ((await this.prisma.integration.count({ where: { organisationId: ctx.orgId } })) >= 50) throw new BadRequestException('A workspace can have up to 50 integrations');
    const def = providerByKey(d.provider)!;
    if (def.auth === 'credentials' && (await this.prisma.integration.findFirst({ where: { organisationId: ctx.orgId, provider: d.provider } }))) throw new ConflictException(`This workspace already has a ${def.name} connection; edit it instead`);
    // A website form has nothing external to test against: its endpoint exists as soon as it is saved.
    // Credential-based providers start as "awaiting credentials" and become connected only after a successful test.
    const pushOnly = def.auth === 'webhook_only';
    const stored = pushOnly ? { token: `pmf_${randomToken()}` } : cleanCredentials(d.provider, d.credentials);
    const i = await this.prisma.integration.create({
      data: { organisationId: ctx.orgId, provider: d.provider, name: d.name, status: pushOnly ? 'CONNECTED' : 'AWAITING_CREDENTIALS', credentials: encrypt(JSON.stringify(stored)), settings: d.settings as Prisma.InputJsonObject, fieldMapping: d.fieldMapping as Prisma.InputJsonObject, createdById: ctx.userId },
    });
    await audit(this.prisma, ctx, 'integration.created', 'integration', i.id, { provider: d.provider, name: d.name });
    if (pushOnly) return this.present(i);
    const t = await this.testConnection(i);
    return { ...this.present(t.row), summary: t.summary };
  }

  @Perm('settings.manage') @Patch('integrations/:id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(integrationSchema.omit({ provider: true }).partial().extend({ status: z.enum(['CONNECTED', 'DISABLED']).optional() }), body);
    const existing = await this.find(ctx, id);
    if (d.settings) await this.checkSettings(ctx, d.settings);
    let credentials: string | undefined;
    if (d.credentials && providerByKey(existing.provider)?.auth === 'credentials') {
      const current = existing.credentials ? (JSON.parse(decrypt(existing.credentials)) as Record<string, unknown>) : undefined;
      credentials = encrypt(JSON.stringify(cleanCredentials(existing.provider, d.credentials, current)));
    }
    // Re-enabling a credential-based provider, or changing its credentials, re-runs the connection test.
    if (d.status === 'CONNECTED' && providerByKey(existing.provider)?.auth === 'credentials') d.status = undefined;
    const i = await this.prisma.integration.update({ where: { id }, data: { name: d.name, settings: d.settings as Prisma.InputJsonObject | undefined, fieldMapping: d.fieldMapping as Prisma.InputJsonObject | undefined, credentials, status: d.status, lastError: d.status === 'CONNECTED' ? null : undefined } });
    await audit(this.prisma, ctx, 'integration.updated', 'integration', id, { status: d.status, name: d.name, credentialsChanged: !!credentials });
    const retest = providerByKey(existing.provider)?.auth === 'credentials' && (!!credentials || (body as { status?: string })?.status === 'CONNECTED');
    if (!retest) return this.present(i);
    const t = await this.testConnection(i);
    return { ...this.present(t.row), summary: t.summary };
  }

  /** Connection test on demand. */
  @Perm('settings.manage') @Post('integrations/:id/test') @HttpCode(200)
  async test(@Context() ctx: Ctx, @Param('id') id: string) {
    const i = await this.find(ctx, id);
    if (i.provider === 'website_form') return this.present(i);
    const t = await this.testConnection(i);
    await audit(this.prisma, ctx, 'integration.tested', 'integration', id, { status: t.row.status });
    return { ...this.present(t.row), summary: t.summary };
  }

  /** Sends a real test email to the signed-in user through the connected SMTP integration. */
  @Perm('settings.manage') @Post('integrations/:id/send-test') @HttpCode(200)
  async sendTest(@Context() ctx: Ctx, @Param('id') id: string) {
    const i = await this.find(ctx, id);
    if (i.provider !== 'smtp') throw new BadRequestException('Only an email connection can send a test message');
    if (i.status !== 'CONNECTED') throw new BadRequestException('Test the connection first');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const r = await this.email.send({ organisationId: ctx.orgId, userId: ctx.userId, kind: 'test', to: user.email, subject: 'PowerMyCRM test email', text: 'This is a test email from PowerMyCRM. Your email connection works.', html: layout('Your email connection works', ['This is a test email from PowerMyCRM.', 'Invitations, password resets and verification emails will be sent through this connection.']) });
    return { emailId: r.id };
  }

  @Perm('settings.manage') @Post('integrations/:id/rotate-token') @HttpCode(200)
  async rotate(@Context() ctx: Ctx, @Param('id') id: string) {
    await this.find(ctx, id);
    const token = `pmf_${randomToken()}`;
    const i = await this.prisma.integration.update({ where: { id }, data: { credentials: encrypt(JSON.stringify({ token })) } });
    await audit(this.prisma, ctx, 'integration.token_rotated', 'integration', id);
    return this.present(i);
  }

  @Perm('settings.manage') @Delete('integrations/:id')
  async remove(@Context() ctx: Ctx, @Param('id') id: string) {
    const i = await this.find(ctx, id);
    await this.prisma.$transaction([this.prisma.integration.delete({ where: { id } }), audit(this.prisma, ctx, 'integration.deleted', 'integration', id, { name: i.name })]);
    return { ok: true };
  }

  @Perm('settings.manage') @Get('integrations/:id/events')
  async events(@Context() ctx: Ctx, @Param('id') id: string, @Query() query: unknown) {
    await this.find(ctx, id);
    const f = parse(z.object({ ...pageSchema, status: z.enum(['PENDING', 'PROCESSED', 'SKIPPED', 'FAILED']).optional() }), query);
    const where = { integrationId: id, organisationId: ctx.orgId, status: f.status };
    const [items, total] = await Promise.all([
      this.prisma.integrationEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      this.prisma.integrationEvent.count({ where }),
    ]);
    const leadIds = items.map((e) => e.leadId).filter(Boolean) as string[];
    const leads = leadIds.length ? await this.prisma.lead.findMany({ where: { id: { in: leadIds }, organisationId: ctx.orgId }, select: { id: true, name: true } }) : [];
    return { items: items.map((e) => ({ ...e, lead: leads.find((l) => l.id === e.leadId) ?? null })), total, page: f.page, pageSize: f.pageSize };
  }

  @Perm('settings.manage') @Post('integrations/:id/events/:eventId/retry') @HttpCode(200)
  async retry(@Context() ctx: Ctx, @Param('id') id: string, @Param('eventId') eventId: string) {
    await this.find(ctx, id);
    const ev = await this.prisma.integrationEvent.findFirst({ where: { id: eventId, integrationId: id, organisationId: ctx.orgId } });
    if (!ev) throw new NotFoundException('Event not found');
    if (ev.status === 'PROCESSED') throw new BadRequestException('This event already created a lead');
    await this.prisma.integrationEvent.update({ where: { id: eventId }, data: { status: 'PENDING', error: null, processedAt: null } });
    await this.queue.send('integration.inbound', { eventId }, { singletonKey: `${eventId}:${Date.now()}` });
    return { ok: true };
  }
}

// ---- API keys and the public lead-capture API ----------------------------------------------

const captureSchema = z.object({
  name: z.string().trim().max(160).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().max(200).optional(),
  company: z.string().trim().max(160).optional(),
  city: z.string().trim().max(100).optional(),
  source: z.string().trim().max(80).optional(),
  message: z.string().trim().max(5000).optional(),
  customFields: z.record(z.string(), z.any()).optional(),
  externalId: z.string().trim().max(120).optional(),
  duplicateStrategy: z.enum(['skip', 'update', 'create']).default('skip'),
  ownerId: z.string().nullable().default('auto'),
});

@Controller()
export class ApiKeysController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
  ) {}

  private present(k: { id: string; name: string; prefix: string; lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date }) {
    return { id: k.id, name: k.name, prefix: k.prefix, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, createdAt: k.createdAt };
  }

  @Perm('settings.manage') @Get('api-keys')
  async list(@Context() ctx: Ctx) {
    const rows = await this.prisma.apiKey.findMany({ where: { organisationId: ctx.orgId }, orderBy: { createdAt: 'asc' } });
    return rows.map((k) => this.present(k));
  }

  @Perm('settings.manage') @Post('api-keys')
  async create(@Context() ctx: Ctx, @Body() body: unknown) {
    const { name } = parse(z.object({ name: z.string().trim().min(1, 'Name the key').max(80) }), body);
    if ((await this.prisma.apiKey.count({ where: { organisationId: ctx.orgId, revokedAt: null } })) >= 20) throw new BadRequestException('A workspace can have up to 20 active API keys');
    const key = `pmc_live_${randomToken()}`;
    const row = await this.prisma.apiKey.create({ data: { organisationId: ctx.orgId, name, prefix: key.slice(0, 16), keyHash: sha256(key), createdById: ctx.userId } });
    await audit(this.prisma, ctx, 'api_key.created', 'api_key', row.id, { name });
    // The full key is shown once and never stored.
    return { ...this.present(row), key };
  }

  @Perm('settings.manage') @Delete('api-keys/:id')
  async revoke(@Context() ctx: Ctx, @Param('id') id: string) {
    const r = await this.prisma.apiKey.updateMany({ where: { id, organisationId: ctx.orgId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw new NotFoundException('API key not found');
    await audit(this.prisma, ctx, 'api_key.revoked', 'api_key', id);
    return { ok: true };
  }

  private async keyFromHeader(authorization?: string) {
    const raw = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!raw.startsWith('pmc_live_')) throw new UnauthorizedException('Send your API key as "Authorization: Bearer pmc_live_…"');
    const key = await this.prisma.apiKey.findUnique({ where: { keyHash: sha256(raw) }, include: { organisation: { select: { id: true, name: true, status: true } } } });
    if (!key || key.revokedAt || key.organisation.status !== 'ACTIVE') throw new UnauthorizedException('This API key is not valid');
    await this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return key;
  }

  /** Lets an integrator confirm their key works. */
  @Public() @Get('public/me')
  async me(@Headers('authorization') authorization?: string) {
    const key = await this.keyFromHeader(authorization);
    return { organisation: key.organisation.name, key: key.name };
  }

  /** Creates (or de-duplicates into) a lead. Owner is chosen by the workspace's assignment rules unless `ownerId` is given. */
  @Public() @Post('public/leads')
  async capture(@Body() body: unknown, @Headers('authorization') authorization?: string) {
    const key = await this.keyFromHeader(authorization);
    const d = parse(captureSchema, body);
    const r = await this.leads.ingest(key.organisationId, { name: d.name, phone: d.phone, email: d.email, company: d.company, city: d.city, message: d.message, sourceName: d.source, customFields: d.customFields ?? {}, externalId: d.externalId }, { ownerId: d.ownerId, duplicateStrategy: d.duplicateStrategy, sourceId: null, via: 'api', apiKeyId: key.id });
    return { id: r.leadId, outcome: r.outcome };
  }
}
