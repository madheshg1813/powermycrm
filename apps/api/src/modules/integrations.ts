import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Logger, NotFoundException, OnModuleInit, Param, Patch, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, Public, audit, pageSchema, parse, randomToken, sha256 } from '../common/core';
import { ConflictException } from '@nestjs/common';
import { QueueService, decrypt, encrypt, safeEqual } from '../common/queue';
import { EmailService, layout, smtpSchema } from './email';
import { IngestOptions, LeadsService } from './leads';

// ---- Provider registry ---------------------------------------------------------
// Only providers that work end to end without third-party credentials are listed. Every other provider in
// docs/INTEGRATION_ARCHITECTURE.md is "awaiting credentials" and is not shown as connectable.

export const PROVIDERS = [
  {
    key: 'website_form',
    name: 'Website form',
    category: 'lead_source',
    auth: 'webhook_only',
    description: 'Post your website or landing-page form to a PowerMyCRM endpoint. Each submission becomes a lead, de-duplicated and auto-assigned by your rules.',
    credentialSchema: [] as CredentialField[],
  },
  {
    key: 'smtp',
    name: 'Email (SMTP)',
    category: 'messaging',
    auth: 'credentials',
    description: 'Send invitations, password resets and verification emails from your own mail account or transactional email service (Gmail with an app password, Microsoft 365, Amazon SES, SendGrid, Zoho…).',
    credentialSchema: [
      { key: 'host', label: 'SMTP host', type: 'text', placeholder: 'smtp.gmail.com' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '587' },
      { key: 'secure', label: 'Use implicit TLS (port 465)', type: 'boolean' },
      { key: 'user', label: 'Username', type: 'text', placeholder: 'you@yourcompany.com' },
      { key: 'pass', label: 'Password or app password', type: 'password' },
      { key: 'from', label: 'From address', type: 'text', placeholder: 'Sales Team <sales@yourcompany.com>' },
    ] as CredentialField[],
  },
] as const;
export type CredentialField = { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'password'; placeholder?: string };
type ProviderKey = (typeof PROVIDERS)[number]['key'];

/** CRM fields a website form can fill. `cf_<key>` entries are added per workspace from its custom fields. */
export const MAPPABLE_FIELDS = ['name', 'phone', 'email', 'company', 'city', 'message', 'source'] as const;
const DEFAULT_MAPPING: Record<string, string> = { name: 'name', phone: 'phone', email: 'email', company: 'company', city: 'city', message: 'message' };

const settingsSchema = z.object({
  sourceId: z.string().nullable().default(null),
  ownerId: z.string().nullable().default('auto'), // 'auto' = assignment rules, null = unassigned, or a user id
  duplicateStrategy: z.enum(['skip', 'update', 'create']).default('skip'),
  redirectUrl: z.string().trim().url().max(500).nullable().default(null),
});
const integrationSchema = z.object({
  provider: z.enum(['website_form', 'smtp']),
  name: z.string().trim().min(1, 'Name the integration').max(80),
  settings: settingsSchema.default({}),
  fieldMapping: z.record(z.string(), z.string().trim().max(80)).default({}),
  credentials: z.record(z.string(), z.any()).optional(),
});
/** Validates provider credentials and returns what is stored (encrypted). */
function cleanCredentials(provider: ProviderKey, raw: unknown, existing?: Record<string, unknown>): Record<string, unknown> {
  if (provider === 'smtp') {
    const merged = { ...(existing ?? {}), ...((raw ?? {}) as Record<string, unknown>) };
    // A blank password on edit keeps the stored one.
    if (existing && !(raw as Record<string, unknown>)?.pass) merged.pass = existing.pass;
    const r = smtpSchema.safeParse(merged);
    if (!r.success) throw new BadRequestException({ message: r.error.issues[0]?.message ?? 'Check the SMTP details', errors: r.error.issues.map((i) => ({ path: `credentials.${i.path.join('.')}`, message: i.message })) });
    return r.data;
  }
  return {};
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
export class IntegrationsController implements OnModuleInit {
  private readonly log = new Logger('Integrations');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly leads: LeadsService,
    private readonly email: EmailService,
  ) {}

  onModuleInit() {
    this.queue.work<{ eventId: string }>('integration.inbound', ({ eventId }) => this.processInbound(eventId), { retryLimit: 5, retryDelay: 60 });
  }

  // ---- Worker ------------------------------------------------------------------------

  /** Turns a stored inbound event into a lead. Validation problems park the event as FAILED; infrastructure errors retry. */
  async processInbound(eventId: string) {
    const ev = await this.prisma.integrationEvent.findUnique({ where: { id: eventId }, include: { integration: true } });
    if (!ev || ev.status !== 'PENDING') return;
    const settings = settingsSchema.parse(ev.integration.settings ?? {});
    try {
      const mapped = applyMapping(ev.payload as Record<string, unknown>, (ev.integration.fieldMapping ?? {}) as Record<string, string>);
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

  // ---- Admin ----------------------------------------------------------------------------

  private async find(ctx: Ctx, id: string) {
    const i = await this.prisma.integration.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!i) throw new NotFoundException('Integration not found');
    return i;
  }

  private present(i: { id: string; provider: string; name: string; status: string; settings: unknown; fieldMapping: unknown; credentials: string | null; lastError: string | null; lastEventAt: Date | null; createdAt: Date }) {
    const creds = i.credentials ? (JSON.parse(decrypt(i.credentials)) as Record<string, unknown>) : null;
    // Secrets never leave the server: forms get their token (it is embedded in public HTML anyway); SMTP gets everything but the password.
    const token = i.provider === 'website_form' && creds ? String(creds.token) : null;
    const credentials = i.provider === 'smtp' && creds ? { host: creds.host, port: creds.port, secure: creds.secure, user: creds.user, from: creds.from, hasPassword: !!creds.pass } : null;
    return {
      id: i.id, provider: i.provider, name: i.name, status: i.status, settings: i.settings, fieldMapping: i.fieldMapping, lastError: i.lastError, lastEventAt: i.lastEventAt, createdAt: i.createdAt,
      token, credentials,
      endpointUrl: i.provider === 'website_form' ? `${publicUrl()}/api/v1/hooks/website_form/${i.id}` : null,
    };
  }

  /** Runs the provider's connection test against the real service and records the outcome. */
  private async testConnection(i: { id: string; provider: string; credentials: string | null }) {
    try {
      if (i.provider === 'smtp') {
        if (!i.credentials) throw new Error('No SMTP details saved yet');
        await this.email.verify(smtpSchema.parse(JSON.parse(decrypt(i.credentials))));
      }
      return this.prisma.integration.update({ where: { id: i.id }, data: { status: 'CONNECTED', lastError: null } });
    } catch (e) {
      const message = ((e as Error).message || 'Connection failed').slice(0, 300);
      return this.prisma.integration.update({ where: { id: i.id }, data: { status: 'ERROR', lastError: message } });
    }
  }

  private async checkSettings(ctx: Ctx, s: z.infer<typeof settingsSchema>) {
    if (s.sourceId && !(await this.prisma.leadSource.findFirst({ where: { id: s.sourceId, organisationId: ctx.orgId } }))) throw new BadRequestException('Lead source not found');
    if (s.ownerId && s.ownerId !== 'auto' && !(await this.prisma.membership.findFirst({ where: { userId: s.ownerId, organisationId: ctx.orgId, status: 'ACTIVE' } }))) throw new BadRequestException('Owner is not an active user in this workspace');
  }

  @Perm('settings.manage') @Get('integrations/providers')
  async providers(@Context() ctx: Ctx) {
    const fields = await this.prisma.customField.findMany({ where: { organisationId: ctx.orgId }, orderBy: { position: 'asc' } });
    return { providers: PROVIDERS, mappableFields: [...MAPPABLE_FIELDS, ...fields.map((f) => `cf_${f.key}`)], fieldLabels: Object.fromEntries(fields.map((f) => [`cf_${f.key}`, f.label])) };
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
    if (d.provider === 'smtp' && (await this.prisma.integration.findFirst({ where: { organisationId: ctx.orgId, provider: 'smtp' } }))) throw new ConflictException('This workspace already has an email connection; edit it instead');
    // A website form has nothing external to test against: its endpoint exists as soon as it is saved.
    // Credential-based providers start as "awaiting credentials" and become connected only after a successful test.
    const stored = d.provider === 'website_form' ? { token: `pmf_${randomToken()}` } : cleanCredentials(d.provider, d.credentials);
    const i = await this.prisma.integration.create({
      data: { organisationId: ctx.orgId, provider: d.provider, name: d.name, status: d.provider === 'website_form' ? 'CONNECTED' : 'AWAITING_CREDENTIALS', credentials: encrypt(JSON.stringify(stored)), settings: d.settings as Prisma.InputJsonObject, fieldMapping: d.fieldMapping as Prisma.InputJsonObject, createdById: ctx.userId },
    });
    await audit(this.prisma, ctx, 'integration.created', 'integration', i.id, { provider: d.provider, name: d.name });
    return this.present(d.provider === 'website_form' ? i : await this.testConnection(i));
  }

  @Perm('settings.manage') @Patch('integrations/:id')
  async update(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(integrationSchema.omit({ provider: true }).partial().extend({ status: z.enum(['CONNECTED', 'DISABLED']).optional() }), body);
    const existing = await this.find(ctx, id);
    if (d.settings) await this.checkSettings(ctx, d.settings);
    let credentials: string | undefined;
    if (d.credentials && existing.provider !== 'website_form') {
      const current = existing.credentials ? (JSON.parse(decrypt(existing.credentials)) as Record<string, unknown>) : undefined;
      credentials = encrypt(JSON.stringify(cleanCredentials(existing.provider as ProviderKey, d.credentials, current)));
    }
    // Re-enabling a credential-based provider, or changing its credentials, re-runs the connection test.
    if (d.status === 'CONNECTED' && existing.provider !== 'website_form') d.status = undefined;
    const i = await this.prisma.integration.update({ where: { id }, data: { name: d.name, settings: d.settings as Prisma.InputJsonObject | undefined, fieldMapping: d.fieldMapping as Prisma.InputJsonObject | undefined, credentials, status: d.status, lastError: d.status === 'CONNECTED' ? null : undefined } });
    await audit(this.prisma, ctx, 'integration.updated', 'integration', id, { status: d.status, name: d.name, credentialsChanged: !!credentials });
    const retest = existing.provider !== 'website_form' && (!!credentials || (body as { status?: string })?.status === 'CONNECTED');
    return this.present(retest ? await this.testConnection(i) : i);
  }

  /** Connection test on demand. */
  @Perm('settings.manage') @Post('integrations/:id/test') @HttpCode(200)
  async test(@Context() ctx: Ctx, @Param('id') id: string) {
    const i = await this.find(ctx, id);
    if (i.provider === 'website_form') return this.present(i);
    const r = await this.testConnection(i);
    await audit(this.prisma, ctx, 'integration.tested', 'integration', id, { status: r.status });
    return this.present(r);
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
