import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { hash, verify } from '@node-rs/argon2';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Context, Ctx, PrismaService, Public, jwtSecret, parse, randomToken, sha256 } from '../common/core';
import { DEFAULT_DISPOSITIONS } from './calls';
import { EmailService, layout } from './email';
import { DEFAULT_LABELS, DEFAULT_SOURCES, DEFAULT_STAGES, SYSTEM_ROLES } from '../common/permissions';

const COOKIE = 'pmc_rt';
const REFRESH_DAYS = 30;
const ACCESS_TTL = '15m';
const REPLAY_GRACE_MS = 30_000;

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');
const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(100),
  email,
  password,
  organisationName: z.string().trim().min(2, 'Enter your organisation name').max(120),
});
const loginSchema = z.object({ email, password: z.string().min(1).max(200), organisationId: z.string().optional() });

type Tx = Prisma.TransactionClient;

/** Creates the defaults every new organisation starts with. Returns the Owner role id. */
export async function seedOrganisation(tx: Tx, organisationId: string): Promise<string> {
  let ownerRoleId = '';
  for (const r of SYSTEM_ROLES) {
    const role = await tx.role.create({ data: { organisationId, ...r } });
    if (r.systemKey === 'owner') ownerRoleId = role.id;
  }
  const pipeline = await tx.pipeline.create({ data: { organisationId, name: 'Sales pipeline', isDefault: true } });
  await tx.stage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({ ...s, organisationId, pipelineId: pipeline.id, position: i })),
  });
  await tx.leadSource.createMany({ data: DEFAULT_SOURCES.map((name) => ({ organisationId, name })) });
  await tx.label.createMany({ data: DEFAULT_LABELS.map((l) => ({ organisationId, ...l })) });
  await tx.callDisposition.createMany({ data: DEFAULT_DISPOSITIONS.map((name, position) => ({ organisationId, name, position })) });
  return ownerRoleId;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');
  constructor(private readonly prisma: PrismaService, private readonly email: EmailService) {}

  private async issueSession(userId: string, organisationId: string, req: Request, res: Response) {
    const refresh = randomToken();
    const session = await this.prisma.session.create({
      data: {
        userId,
        organisationId,
        refreshHash: sha256(refresh),
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null,
        ip: req.ip,
        expiresAt: new Date(Date.now() + REFRESH_DAYS * 864e5),
      },
    });
    this.setCookie(res, refresh);
    return { accessToken: this.sign(userId, organisationId, session.id) };
  }

  private sign(userId: string, organisationId: string, sessionId: string) {
    return jwt.sign({ sub: userId, org: organisationId, sid: sessionId }, jwtSecret(), { expiresIn: ACCESS_TTL });
  }

  private setCookie(res: Response, value: string) {
    res.cookie(COOKIE, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      path: '/api/v1/auth',
      maxAge: REFRESH_DAYS * 864e5,
    });
  }

  private clearCookie(res: Response) {
    res.clearCookie(COOKIE, { path: '/api/v1/auth' });
  }

  async register(body: unknown, req: Request, res: Response) {
    const data = parse(registerSchema, body);
    if (await this.prisma.user.findUnique({ where: { email: data.email } })) {
      throw new ConflictException('An account with this email already exists');
    }
    const passwordHash = await hash(data.password);
    const slugBase = data.organisationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';
    const { user, org } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: data.email, name: data.name, passwordHash } });
      const org = await tx.organisation.create({
        data: { name: data.organisationName, slug: `${slugBase}-${randomBytes(3).toString('hex')}` },
      });
      const roleId = await seedOrganisation(tx, org.id);
      await tx.membership.create({ data: { organisationId: org.id, userId: user.id, roleId } });
      await tx.auditLog.create({
        data: { organisationId: org.id, actorId: user.id, action: 'organisation.created', entity: 'organisation', entityId: org.id, ip: req.ip },
      });
      return { user, org };
    });
    await this.sendVerification(user.id, org.id);
    return this.issueSession(user.id, org.id, req, res);
  }

  /** Emails a 24-hour verification link. Returns whether an email connection existed to send it. */
  async sendVerification(userId: string, organisationId: string | null) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return { emailSent: false, verified: true };
    const token = randomToken();
    await this.prisma.authToken.deleteMany({ where: { userId, type: 'VERIFY_EMAIL', usedAt: null } });
    await this.prisma.authToken.create({ data: { userId, type: 'VERIFY_EMAIL', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 24 * 3600e3) } });
    const url = `${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}/verify-email?token=${token}`;
    const sent = await this.email.send({
      organisationId, userId, kind: 'verify_email', to: user.email, subject: 'Verify your email for PowerMyCRM',
      text: `Hi ${user.name},\n\nConfirm this is your email address: ${url}\n\nThe link is valid for 24 hours.`,
      html: layout('Verify your email', [`Hi ${user.name},`, 'Confirm this is your email address so password resets and notifications reach you. The link is valid for 24 hours.'], { label: 'Verify email', url }),
    });
    return { emailSent: sent.willSend, verified: false, ...(process.env.NODE_ENV === 'test' ? { token } : {}) };
  }

  async verifyEmail(body: unknown) {
    const { token } = parse(z.object({ token: z.string().min(10) }), body);
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.type !== 'VERIFY_EMAIL' || row.usedAt || row.expiresAt < new Date()) throw new BadRequestException('This verification link is invalid or has expired');
    await this.prisma.$transaction([
      this.prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
    return { ok: true };
  }

  async login(body: unknown, req: Request, res: Response) {
    const data = parse(loginSchema, body);
    const user = await this.prisma.user.findUnique({ where: { email: data.email } });
    const ok = user ? await verify(user.passwordHash, data.password).catch(() => false) : false;
    await this.prisma.loginEvent.create({
      data: { email: data.email, userId: user?.id, success: ok, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) },
    });
    if (!user || !ok) throw new UnauthorizedException('Incorrect email or password');

    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id, status: 'ACTIVE', organisation: { status: 'ACTIVE' } },
      orderBy: { createdAt: 'asc' },
    });
    const membership = data.organisationId ? memberships.find((m) => m.organisationId === data.organisationId) : memberships[0];
    if (!membership) throw new UnauthorizedException('Your account has no active workspace');
    return this.issueSession(user.id, membership.organisationId, req, res);
  }

  async refresh(req: Request, res: Response) {
    const token: string | undefined = req.cookies?.[COOKIE];
    if (!token) throw new UnauthorizedException('Not signed in');
    const h = sha256(token);
    const session = await this.prisma.session.findFirst({ where: { OR: [{ refreshHash: h }, { prevRefreshHash: h }] } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      this.clearCookie(res);
      throw new UnauthorizedException('Session expired');
    }
    // A browser can lose the response to a refresh (page reload mid-request) and legitimately retry
    // with the previous token, so that is tolerated for a short window after rotation.
    const withinGrace = Date.now() - session.lastUsedAt.getTime() < REPLAY_GRACE_MS;
    if (session.prevRefreshHash === h && !withinGrace) {
      // An already-rotated token was presented again later: treat as theft and end the session.
      await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      this.clearCookie(res);
      throw new UnauthorizedException('Session expired');
    }
    const membership = await this.prisma.membership.findFirst({
      where: { userId: session.userId, organisationId: session.organisationId, status: 'ACTIVE', organisation: { status: 'ACTIVE' } },
    });
    if (!membership) {
      this.clearCookie(res);
      throw new UnauthorizedException('Session expired');
    }
    const next = randomToken();
    await this.prisma.session.update({
      where: { id: session.id },
      data: { refreshHash: sha256(next), prevRefreshHash: h, lastUsedAt: new Date(), ip: req.ip },
    });
    this.setCookie(res, next);
    return { accessToken: this.sign(session.userId, session.organisationId, session.id) };
  }

  async logout(req: Request, res: Response) {
    const token: string | undefined = req.cookies?.[COOKIE];
    if (token) {
      await this.prisma.session.updateMany({ where: { refreshHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
    }
    this.clearCookie(res);
    return { ok: true };
  }

  async me(ctx: Ctx) {
    const [user, membership, memberships] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } }),
      this.prisma.membership.findFirstOrThrow({
        where: { userId: ctx.userId, organisationId: ctx.orgId },
        include: { role: true, organisation: true },
      }),
      this.prisma.membership.findMany({
        where: { userId: ctx.userId, status: 'ACTIVE', organisation: { status: 'ACTIVE' } },
        include: { organisation: { select: { id: true, name: true } } },
      }),
    ]);
    const o = membership.organisation;
    return {
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone, emailVerified: !!user.emailVerifiedAt },
      organisation: { id: o.id, name: o.name, slug: o.slug, timezone: o.timezone, currency: o.currency, dateFormat: o.dateFormat, logoUrl: o.logoUrl },
      role: { id: membership.role.id, name: membership.role.name, scope: membership.role.scope, systemKey: membership.role.systemKey },
      permissions: membership.role.permissions,
      teamId: membership.teamId,
      organisations: memberships.map((m) => m.organisation),
    };
  }

  async switchOrganisation(ctx: Ctx, body: unknown) {
    const { organisationId } = parse(z.object({ organisationId: z.string() }), body);
    const m = await this.prisma.membership.findFirst({
      where: { userId: ctx.userId, organisationId, status: 'ACTIVE', organisation: { status: 'ACTIVE' } },
    });
    if (!m) throw new BadRequestException('You are not a member of that workspace');
    await this.prisma.session.update({ where: { id: ctx.sessionId }, data: { organisationId } });
    return { accessToken: this.sign(ctx.userId, organisationId, ctx.sessionId) };
  }

  async updateProfile(ctx: Ctx, body: unknown) {
    const data = parse(z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().max(30).nullable().optional() }), body);
    await this.prisma.user.update({ where: { id: ctx.userId }, data });
    return this.me(ctx);
  }

  async changePassword(ctx: Ctx, body: unknown) {
    const data = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), body);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (!(await verify(user.passwordHash, data.currentPassword).catch(() => false))) {
      throw new BadRequestException('Current password is incorrect');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hash(data.newPassword) } }),
      this.prisma.session.updateMany({ where: { userId: user.id, id: { not: ctx.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { ok: true };
  }

  async forgotPassword(body: unknown) {
    const data = parse(z.object({ email }), body);
    const user = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (user) {
      const token = randomToken();
      await this.prisma.authToken.create({
        data: { userId: user.id, type: 'RESET_PASSWORD', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600e3) },
      });
      const url = `${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}/reset-password?token=${token}`;
      const sent = await this.email.send({
        organisationId: null, userId: user.id, kind: 'password_reset', to: user.email, subject: 'Reset your PowerMyCRM password',
        text: `Hi ${user.name},\n\nUse this link to choose a new password: ${url}\n\nIt is valid for one hour. If you did not ask for this, you can ignore this email.`,
        html: layout('Reset your password', [`Hi ${user.name},`, 'Use the button below to choose a new password. The link is valid for one hour.', 'If you did not ask for this, you can ignore this email.'], { label: 'Choose a new password', url }),
      });
      // Without any email connection, the link is written to the server log outside production so the flow can still be exercised.
      if (!sent.willSend && process.env.NODE_ENV !== 'production') this.log.warn(`Password reset link for ${user.email}: ${url}`);
      return { ok: true, emailSent: sent.willSend, ...(process.env.NODE_ENV === 'test' ? { token } : {}) };
    }
    return { ok: true };
  }

  async resetPassword(body: unknown) {
    const data = parse(z.object({ token: z.string().min(10), password }), body);
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash: sha256(data.token) } });
    if (!row || row.type !== 'RESET_PASSWORD' || row.usedAt || row.expiresAt < new Date()) {
      throw new BadRequestException('This reset link is invalid or has expired');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await hash(data.password) } }),
      this.prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      this.prisma.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { ok: true };
  }

  async sessions(ctx: Ctx) {
    const rows = await this.prisma.session.findMany({
      where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return rows.map((s) => ({ id: s.id, userAgent: s.userAgent, ip: s.ip, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, current: s.id === ctx.sessionId }));
  }

  async revokeSession(ctx: Ctx, id: string) {
    const r = await this.prisma.session.updateMany({ where: { id, userId: ctx.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw new BadRequestException('Session not found');
    return { ok: true };
  }

  async invitationInfo(token: string) {
    const inv = await this.findInvitation(token);
    const existing = await this.prisma.user.findUnique({ where: { email: inv.email } });
    return { email: inv.email, organisation: inv.organisation.name, role: inv.role.name, existingUser: !!existing };
  }

  private async findInvitation(token: string) {
    const inv = await this.prisma.invitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: { organisation: true, role: true },
    });
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date() || inv.organisation.status !== 'ACTIVE') {
      throw new BadRequestException('This invitation is invalid or has expired');
    }
    return inv;
  }

  async acceptInvitation(token: string, body: unknown, req: Request, res: Response) {
    const inv = await this.findInvitation(token);
    let user = await this.prisma.user.findUnique({ where: { email: inv.email } });
    if (user) {
      const data = parse(z.object({ password: z.string().min(1) }), body);
      if (!(await verify(user.passwordHash, data.password).catch(() => false))) {
        throw new UnauthorizedException('Incorrect password for this account');
      }
    } else {
      const data = parse(z.object({ name: z.string().trim().min(2).max(100), password }), body);
      user = await this.prisma.user.create({
        data: { email: inv.email, name: data.name, passwordHash: await hash(data.password), emailVerifiedAt: new Date() },
      });
    }
    const userId = user.id;
    await this.prisma.$transaction(async (tx) => {
      await tx.membership.upsert({
        where: { organisationId_userId: { organisationId: inv.organisationId, userId } },
        create: { organisationId: inv.organisationId, userId, roleId: inv.roleId },
        update: { status: 'ACTIVE', roleId: inv.roleId },
      });
      await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
      await tx.auditLog.create({
        data: { organisationId: inv.organisationId, actorId: userId, action: 'invitation.accepted', entity: 'invitation', entityId: inv.id, ip: req.ip },
      });
    });
    return this.issueSession(userId, inv.organisationId, req, res);
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  register(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.register(body, req, res);
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200)
  @Post('login')
  login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(body, req, res);
  }

  @Public() @HttpCode(200)
  @Post('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req, res);
  }

  @Public() @HttpCode(200)
  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200)
  @Post('forgot-password')
  forgot(@Body() body: unknown) {
    return this.auth.forgotPassword(body);
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200)
  @Post('reset-password')
  reset(@Body() body: unknown) {
    return this.auth.resetPassword(body);
  }

  @Public()
  @Get('invitations/:token')
  invitation(@Param('token') token: string) {
    return this.auth.invitationInfo(token);
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invitations/:token/accept')
  accept(@Param('token') token: string, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.acceptInvitation(token, body, req, res);
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200)
  @Post('verify-email')
  verifyEmail(@Body() body: unknown) {
    return this.auth.verifyEmail(body);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } }) @HttpCode(200)
  @Post('resend-verification')
  resendVerification(@Context() ctx: Ctx) {
    return this.auth.sendVerification(ctx.userId, ctx.orgId);
  }

  @Get('me')
  me(@Context() ctx: Ctx) {
    return this.auth.me(ctx);
  }

  @Post('profile') @HttpCode(200)
  profile(@Context() ctx: Ctx, @Body() body: unknown) {
    return this.auth.updateProfile(ctx, body);
  }

  @Post('switch') @HttpCode(200)
  switch(@Context() ctx: Ctx, @Body() body: unknown) {
    return this.auth.switchOrganisation(ctx, body);
  }

  @Post('change-password') @HttpCode(200)
  changePassword(@Context() ctx: Ctx, @Body() body: unknown) {
    return this.auth.changePassword(ctx, body);
  }

  @Get('sessions')
  sessions(@Context() ctx: Ctx) {
    return this.auth.sessions(ctx);
  }

  @Delete('sessions/:id')
  revoke(@Context() ctx: Ctx, @Param('id') id: string) {
    return this.auth.revokeSession(ctx, id);
  }
}
