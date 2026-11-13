import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Injectable, Logger, NotFoundException, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, Public, normalizePhone, pageSchema, parse } from '../common/core';
import { decrypt, safeEqual } from '../common/queue';
import { IntegrationsController } from './integrations';
import { LeadsService } from './leads';
import { sendSms, smsCredentials } from './providers/sms';
import { fetchTemplates, sendWhatsapp, verifyMetaSignature, whatsappCredentials } from './providers/whatsapp';
import { OutboxService } from './webhooks';

const WINDOW_MS = 24 * 3600e3;
/** WhatsApp wants E.164 digits without "+". Indian 10-digit numbers get the country code. */
export function waNumber(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
}
const include = { lead: { select: { id: true, name: true, phone: true, ownerId: true } }, assignee: { select: { id: true, name: true } } } satisfies Prisma.ConversationInclude;

/** Conversations and messages over WhatsApp (two-way) and SMS (outbound); shared by the inbox, the lead page, automations and webhooks. */
@Injectable()
export class MessagingService {
  private readonly log = new Logger('Messaging');
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly outbox: OutboxService,
  ) {}

  async conversationFor(organisationId: string, channel: 'whatsapp' | 'sms', phone: string, leadId: string | null, integrationId: string) {
    const key = channel === 'whatsapp' ? waNumber(phone) : phone.replace(/\D/g, '');
    const existing = await this.prisma.conversation.findUnique({ where: { organisationId_channel_phone: { organisationId, channel, phone: key } }, include });
    if (existing) {
      if (!existing.leadId && leadId) return this.prisma.conversation.update({ where: { id: existing.id }, data: { leadId }, include });
      return existing;
    }
    return this.prisma.conversation.create({ data: { organisationId, channel, phone: key, leadId, integrationId }, include });
  }

  /**
   * Sends through the channel's provider and records the message. Validation problems (closed window, unknown
   * template, empty text) are reported before anything is recorded; only a provider failure leaves a FAILED message.
   */
  async send(ctx: { orgId: string; userId: string | null }, conversationId: string, input: { text?: string; templateName?: string; language?: string; params?: string[] }) {
    const conv = await this.prisma.conversation.findFirst({ where: { id: conversationId, organisationId: ctx.orgId }, include });
    if (!conv) throw new NotFoundException('Conversation not found');
    let body = input.text?.trim() ?? '';
    let attempt: () => Promise<string>;
    if (conv.channel === 'whatsapp') {
      const wa = await IntegrationsController.connected(this.prisma, ctx.orgId, 'whatsapp');
      if (!wa) throw new BadRequestException('WhatsApp is not connected');
      const creds = whatsappCredentials.parse(wa.credentials);
      if (input.templateName) {
        const t = await this.prisma.messageTemplate.findFirst({ where: { organisationId: ctx.orgId, name: input.templateName, language: input.language ?? 'en', status: 'APPROVED' } });
        if (!t) throw new BadRequestException(`Template "${input.templateName}" is not approved or not synced`);
        const params = input.params ?? [];
        if (params.length !== t.variables) throw new BadRequestException(`Template "${t.name}" needs ${t.variables} value${t.variables === 1 ? '' : 's'}`);
        body = t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
        attempt = async () => (await sendWhatsapp(creds, conv.phone, { type: 'template', name: t.name, language: t.language, params })).id;
      } else {
        if (!body) throw new BadRequestException('Write a message');
        if (!conv.lastInboundAt || Date.now() - conv.lastInboundAt.getTime() > WINDOW_MS) throw new BadRequestException({ message: "WhatsApp only allows free-form replies within 24 hours of the customer's last message. Send an approved template instead.", code: 'WINDOW_CLOSED' });
        attempt = async () => (await sendWhatsapp(creds, conv.phone, { type: 'text', body })).id;
      }
    } else {
      const gw = await IntegrationsController.connected(this.prisma, ctx.orgId, 'sms_http');
      if (!gw) throw new BadRequestException('No SMS gateway is connected');
      if (!body) throw new BadRequestException('Write a message');
      const creds = smsCredentials.parse(gw.credentials);
      attempt = async () => { await sendSms(creds, conv.phone, body); return ''; };
    }
    const message = await this.prisma.message.create({ data: { organisationId: ctx.orgId, conversationId: conv.id, direction: 'OUT', type: input.templateName ? 'template' : 'text', body, templateName: input.templateName ?? null, status: 'QUEUED', senderId: ctx.userId } });
    try {
      const providerRef = await attempt();
      const sent = await this.prisma.message.update({ where: { id: message.id }, data: { status: 'SENT', providerRef: providerRef || null } });
      await this.prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });
      if (conv.leadId) {
        await this.prisma.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: conv.leadId, actorId: ctx.userId, type: 'message_sent', data: { channel: conv.channel, body: sent.body.slice(0, 500), template: input.templateName ?? null } } });
        await this.prisma.lead.update({ where: { id: conv.leadId }, data: { lastActivityAt: new Date() } });
      }
      return sent;
    } catch (e) {
      await this.prisma.message.update({ where: { id: message.id }, data: { status: 'FAILED', error: String((e as Error).message).slice(0, 500) } });
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Records an inbound WhatsApp message, links or creates the lead, and tells the owner. */
  async receiveWhatsapp(organisationId: string, integrationId: string, autoCreate: boolean, m: { from: string; id: string; type: string; text?: string; mediaId?: string; timestamp?: string; profileName?: string }) {
    if (await this.prisma.message.findFirst({ where: { organisationId, providerRef: m.id } })) return null;
    const normalized = normalizePhone(m.from);
    let lead = normalized ? await this.prisma.lead.findFirst({ where: { organisationId, phoneNormalized: normalized, archivedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, ownerId: true, name: true } }) : null;
    if (!lead && autoCreate) {
      const r = await this.leads.ingest(organisationId, { name: m.profileName || m.from, phone: m.from, message: undefined }, { ownerId: 'auto', duplicateStrategy: 'skip', sourceId: null, via: 'whatsapp', integrationId }).catch((e) => { this.log.warn(`Could not create a lead for ${m.from}: ${(e as Error).message}`); return null; });
      if (r) lead = await this.prisma.lead.findUnique({ where: { id: r.leadId }, select: { id: true, ownerId: true, name: true } });
    }
    const conv = await this.conversationFor(organisationId, 'whatsapp', m.from, lead?.id ?? null, integrationId);
    const body = m.text ?? (m.type === 'image' ? '[Image]' : m.type === 'document' ? '[Document]' : m.type === 'audio' ? '[Voice message]' : m.type === 'video' ? '[Video]' : `[${m.type}]`);
    const msg = await this.prisma.message.create({ data: { organisationId, conversationId: conv.id, direction: 'IN', type: m.type === 'text' ? 'text' : m.type, body, providerRef: m.id, status: 'RECEIVED' } });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(), lastInboundAt: new Date(), unread: { increment: 1 } } });
    const notifyUser = conv.assigneeId ?? lead?.ownerId ?? (await this.prisma.membership.findFirst({ where: { organisationId, status: 'ACTIVE', role: { systemKey: 'owner' } } }))?.userId;
    if (notifyUser) await this.prisma.notification.create({ data: { organisationId, userId: notifyUser, type: 'message.received', title: `WhatsApp from ${lead?.name ?? m.profileName ?? m.from}: ${body.slice(0, 60)}`, link: `/inbox?conversation=${conv.id}` } });
    if (lead) {
      await this.prisma.leadActivity.create({ data: { organisationId, leadId: lead.id, actorId: null, type: 'message_received', data: { channel: 'whatsapp', body: body.slice(0, 500) } } });
      await this.prisma.lead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date() } });
    }
    return msg;
  }

  async syncTemplates(organisationId: string) {
    const wa = await IntegrationsController.connected(this.prisma, organisationId, 'whatsapp');
    if (!wa) throw new BadRequestException('WhatsApp is not connected');
    const list = await fetchTemplates(whatsappCredentials.parse(wa.credentials)).catch((e) => { throw new BadRequestException((e as Error).message); });
    let n = 0;
    for (const t of list) {
      const bodyComp = t.components?.find((c) => c.type === 'BODY');
      const body = bodyComp?.text ?? '';
      const variables = Math.max(0, ...[...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
      await this.prisma.messageTemplate.upsert({
        where: { integrationId_name_language: { integrationId: wa.id, name: t.name, language: t.language } },
        create: { organisationId, integrationId: wa.id, name: t.name, language: t.language, category: t.category ?? 'UTILITY', status: t.status ?? 'UNKNOWN', body, variables, components: (t.components ?? []) as Prisma.InputJsonValue, syncedAt: new Date() },
        update: { category: t.category ?? 'UTILITY', status: t.status ?? 'UNKNOWN', body, variables, components: (t.components ?? []) as Prisma.InputJsonValue, syncedAt: new Date() },
      });
      n++;
    }
    return { synced: n };
  }
}

@Controller()
export class MessagingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly messaging: MessagingService,
  ) {}

  private async scope(ctx: Ctx): Promise<Prisma.ConversationWhereInput> {
    const owners = await this.leads.ownerIds(ctx);
    if (!owners) return { organisationId: ctx.orgId };
    return { organisationId: ctx.orgId, OR: [{ assigneeId: ctx.userId }, { lead: { ownerId: { in: owners } } }] };
  }

  @Perm('leads.view') @Get('conversations')
  async list(@Context() ctx: Ctx, @Query() query: unknown) {
    const f = parse(z.object({ ...pageSchema, q: z.string().trim().max(100).optional(), unread: z.enum(['true']).optional(), channel: z.enum(['whatsapp', 'sms']).optional() }), query);
    const where: Prisma.ConversationWhereInput = { AND: [await this.scope(ctx)], channel: f.channel, ...(f.unread ? { unread: { gt: 0 } } : {}), ...(f.q ? { OR: [{ phone: { contains: f.q.replace(/\D/g, '') || f.q } }, { lead: { name: { contains: f.q, mode: 'insensitive' } } }] } : {}) };
    const [items, total, unread] = await Promise.all([
      this.prisma.conversation.findMany({ where, include: { ...include, messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, direction: true, createdAt: true, status: true } } }, orderBy: { lastMessageAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.aggregate({ where: { AND: [await this.scope(ctx)] }, _sum: { unread: true } }),
    ]);
    return { items: items.map((c) => ({ ...c, last: c.messages[0] ?? null, messages: undefined })), total, page: f.page, pageSize: f.pageSize, unreadTotal: unread._sum.unread ?? 0 };
  }

  /** Opens (or creates) the conversation for a lead on a channel. */
  @Perm('leads.view') @Post('conversations') @HttpCode(200)
  async open(@Context() ctx: Ctx, @Body() body: unknown) {
    const { leadId, channel } = parse(z.object({ leadId: z.string(), channel: z.enum(['whatsapp', 'sms']).default('whatsapp') }), body);
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] }, select: { id: true, phone: true } });
    if (!lead) throw new BadRequestException('Lead not found');
    if (!lead.phone) throw new BadRequestException('This lead has no phone number');
    const provider = await IntegrationsController.connected(this.prisma, ctx.orgId, channel === 'whatsapp' ? 'whatsapp' : 'sms_http');
    if (!provider) throw new BadRequestException(channel === 'whatsapp' ? 'WhatsApp is not connected (Settings → Integrations)' : 'No SMS gateway is connected (Settings → Integrations)');
    return this.messaging.conversationFor(ctx.orgId, channel, lead.phone, lead.id, provider.id);
  }

  @Perm('leads.view') @Get('conversations/:id')
  async get(@Context() ctx: Ctx, @Param('id') id: string) {
    const conv = await this.prisma.conversation.findFirst({ where: { id, AND: [await this.scope(ctx)] }, include });
    if (!conv) throw new NotFoundException('Conversation not found');
    const messages = await this.prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' }, take: 500, include: { sender: { select: { id: true, name: true } } } });
    const windowOpen = !!conv.lastInboundAt && Date.now() - conv.lastInboundAt.getTime() <= WINDOW_MS;
    return { ...conv, messages, windowOpen, windowClosesAt: conv.lastInboundAt ? new Date(conv.lastInboundAt.getTime() + WINDOW_MS) : null };
  }

  @Perm('leads.view') @Post('conversations/:id/messages')
  async send(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const d = parse(z.object({ text: z.string().max(4096).optional(), templateName: z.string().max(512).optional(), language: z.string().max(10).optional(), params: z.array(z.string().max(1024)).max(20).optional() }), body);
    if (!(await this.prisma.conversation.findFirst({ where: { id, AND: [await this.scope(ctx)] } }))) throw new NotFoundException('Conversation not found');
    return this.messaging.send({ orgId: ctx.orgId, userId: ctx.userId }, id, d);
  }

  @Perm('leads.view') @Post('conversations/:id/read') @HttpCode(200)
  async read(@Context() ctx: Ctx, @Param('id') id: string) {
    const r = await this.prisma.conversation.updateMany({ where: { id, AND: [await this.scope(ctx)] }, data: { unread: 0 } });
    if (!r.count) throw new NotFoundException('Conversation not found');
    return { ok: true };
  }

  @Perm('leads.view') @Get('message-templates')
  templates(@Context() ctx: Ctx) {
    return this.prisma.messageTemplate.findMany({ where: { organisationId: ctx.orgId }, orderBy: [{ status: 'asc' }, { name: 'asc' }], select: { id: true, name: true, language: true, category: true, status: true, body: true, variables: true, syncedAt: true } });
  }

  @Perm('settings.manage') @Post('message-templates/sync') @HttpCode(200)
  sync(@Context() ctx: Ctx) {
    return this.messaging.syncTemplates(ctx.orgId);
  }

  // ---- Meta webhook ------------------------------------------------------------------------------------

  @Public() @Get('hooks/whatsapp/:id')
  async verify(@Param('id') id: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const i = await this.prisma.integration.findFirst({ where: { id, provider: 'whatsapp' } });
    if (!i?.credentials) throw new NotFoundException('Unknown integration');
    const creds = whatsappCredentials.parse(JSON.parse(decrypt(i.credentials)));
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && safeEqual(q['hub.verify_token'], creds.verifyToken)) return res.status(200).type('text/plain').send(q['hub.challenge'] ?? '');
    throw new UnauthorizedException('Verify token does not match');
  }

  @Public() @Post('hooks/whatsapp/:id') @HttpCode(200)
  async webhook(@Param('id') id: string, @Body() body: any, @Headers('x-hub-signature-256') sig: string | undefined, @Req() req: Request & { rawBody?: Buffer }) {
    const i = await this.prisma.integration.findFirst({ where: { id, provider: 'whatsapp' } });
    if (!i?.credentials || i.status !== 'CONNECTED') throw new NotFoundException('Unknown integration');
    const creds = whatsappCredentials.parse(JSON.parse(decrypt(i.credentials)));
    if (!req.rawBody || !verifyMetaSignature(req.rawBody, sig, creds.appSecret)) throw new UnauthorizedException('Invalid signature');
    let received = 0, statuses = 0;
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [String(c.wa_id), String(c.profile?.name ?? '')]));
        for (const m of v.messages ?? []) {
          const r = await this.messaging.receiveWhatsapp(i.organisationId, i.id, creds.autoCreateLeads, { from: String(m.from), id: String(m.id), type: String(m.type ?? 'text'), text: m.text?.body, timestamp: m.timestamp, profileName: names.get(String(m.from)) });
          if (r) received++;
        }
        for (const s of v.statuses ?? []) {
          const map: Record<string, 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
          const status = map[String(s.status)];
          if (!status) continue;
          const r = await this.prisma.message.updateMany({ where: { organisationId: i.organisationId, providerRef: String(s.id) }, data: { status, error: status === 'FAILED' ? String(s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? 'Delivery failed').slice(0, 300) : null } });
          statuses += r.count;
        }
      }
    }
    await this.prisma.integration.update({ where: { id: i.id }, data: { lastEventAt: new Date() } });
    return { ok: true, received, statuses };
  }
}
