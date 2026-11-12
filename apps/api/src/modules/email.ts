import { Controller, Get, Injectable, Logger, OnModuleInit, Query } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, pageSchema, parse } from '../common/core';
import { QueueService, decrypt } from '../common/queue';

export const smtpSchema = z.object({
  host: z.string().trim().min(1, 'Enter the SMTP host').max(200),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  secure: z.coerce.boolean().default(false),
  user: z.string().trim().max(200).default(''),
  pass: z.string().max(500).default(''),
  from: z.string().trim().min(3, 'Enter the From address').max(200),
});
export type SmtpConfig = z.infer<typeof smtpSchema>;

export type Mail = { organisationId?: string | null; userId?: string | null; kind: string; to: string; subject: string; text: string; html?: string };

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Minimal, deliverable HTML wrapper in the product's palette. */
export function layout(title: string, paragraphs: string[], action?: { label: string; url: string }) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;font:15px/1.5 Inter,Arial,sans-serif;color:#44403C">${escape(p)}</p>`).join('');
  const button = action
    ? `<p style="margin:22px 0"><a href="${escape(action.url)}" style="display:inline-block;background:#EA5A2A;color:#fff;text-decoration:none;font:600 14px Inter,Arial,sans-serif;padding:10px 20px;border-radius:999px">${escape(action.label)}</a></p><p style="font:12px/1.5 Inter,Arial,sans-serif;color:#78716C">Or open this link: ${escape(action.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#F5F1EA;padding:28px"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid rgba(28,25,23,.1);border-radius:16px;padding:28px"><h1 style="margin:0 0 18px;font:700 20px Sora,Arial,sans-serif;color:#1C1917">${escape(title)}</h1>${body}${button}<p style="margin:24px 0 0;font:12px Inter,Arial,sans-serif;color:#A8A29E">Sent by PowerMyCRM</p></div></body></html>`;
}

function platformSmtp(): SmtpConfig | null {
  if (!process.env.SMTP_HOST) return null;
  return smtpSchema.parse({ host: process.env.SMTP_HOST, port: process.env.SMTP_PORT ?? 587, secure: process.env.SMTP_SECURE === 'true', user: process.env.SMTP_USER ?? '', pass: process.env.SMTP_PASS ?? '', from: process.env.MAIL_FROM ?? process.env.SMTP_USER ?? '' });
}

function transporter(cfg: SmtpConfig) {
  return nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
}

/**
 * Outgoing email. Every message is recorded, then sent by the worker through the organisation's own SMTP
 * integration when one is connected, otherwise through the platform SMTP from the environment. With neither,
 * the message is recorded as skipped and callers fall back to showing the link to an administrator.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly log = new Logger('Email');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit() {
    this.queue.work<{ id: string }>('email.send', ({ id }) => this.deliver(id), { retryLimit: 3, retryDelay: 30 });
  }

  /** Verifies SMTP credentials by connecting and authenticating. Throws with the server's message on failure. */
  async verify(cfg: SmtpConfig) {
    await transporter(cfg).verify();
  }

  async transportFor(organisationId?: string | null, userId?: string | null): Promise<{ provider: string; cfg: SmtpConfig } | null> {
    const orgIds = organisationId ? [organisationId] : [];
    if (!organisationId && userId) {
      const m = await this.prisma.membership.findMany({ where: { userId, status: 'ACTIVE' }, select: { organisationId: true } });
      orgIds.push(...m.map((x) => x.organisationId));
    }
    if (orgIds.length) {
      const own = await this.prisma.integration.findFirst({ where: { organisationId: { in: orgIds }, provider: 'smtp', status: 'CONNECTED', credentials: { not: null } }, orderBy: { createdAt: 'asc' } });
      if (own) return { provider: `smtp:${own.id}`, cfg: smtpSchema.parse(JSON.parse(decrypt(own.credentials!))) };
    }
    const platform = platformSmtp();
    return platform ? { provider: 'smtp:platform', cfg: platform } : null;
  }

  /** Records the message and queues it. `willSend` tells the caller whether any transport exists right now. */
  async send(mail: Mail): Promise<{ id: string; willSend: boolean }> {
    const transport = await this.transportFor(mail.organisationId, mail.userId);
    const row = await this.prisma.emailMessage.create({
      data: { organisationId: mail.organisationId ?? null, userId: mail.userId ?? null, kind: mail.kind, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html ?? null, status: transport ? 'QUEUED' : 'SKIPPED', provider: transport?.provider ?? null, error: transport ? null : 'No email provider is connected' },
    });
    if (transport) await this.queue.send('email.send', { id: row.id }, { singletonKey: row.id });
    return { id: row.id, willSend: !!transport };
  }

  async deliver(id: string) {
    const m = await this.prisma.emailMessage.findUnique({ where: { id } });
    if (!m || m.status === 'SENT') return;
    const transport = await this.transportFor(m.organisationId, m.userId);
    if (!transport) {
      await this.prisma.emailMessage.update({ where: { id }, data: { status: 'SKIPPED', error: 'No email provider is connected', attempts: { increment: 1 } } });
      return;
    }
    try {
      const info = await transporter(transport.cfg).sendMail({ from: transport.cfg.from, to: m.to, subject: m.subject, text: m.text, html: m.html ?? undefined });
      await this.prisma.emailMessage.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), provider: transport.provider, providerRef: info.messageId ?? null, error: null, attempts: { increment: 1 } } });
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      await this.prisma.emailMessage.update({ where: { id }, data: { status: 'FAILED', error: message, attempts: { increment: 1 } } });
      this.log.warn(`Email ${id} to ${m.to} failed: ${message}`);
      throw e;
    }
  }
}

@Controller('emails')
export class EmailController {
  constructor(private readonly prisma: PrismaService) {}

  /** The organisation's recent outgoing mail, for the Settings screen. */
  @Perm('settings.manage') @Get()
  async list(@Context() ctx: Ctx, @Query() query: unknown) {
    const f = parse(z.object({ ...pageSchema }), query);
    const where = { organisationId: ctx.orgId };
    const [items, total] = await Promise.all([
      this.prisma.emailMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize, select: { id: true, kind: true, to: true, subject: true, status: true, provider: true, error: true, attempts: true, sentAt: true, createdAt: true } }),
      this.prisma.emailMessage.count({ where }),
    ]);
    return { items, total, page: f.page, pageSize: f.pageSize, platformConfigured: !!platformSmtp() };
  }
}
