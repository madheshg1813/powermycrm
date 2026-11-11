import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, parse, randomToken, sha256 } from '../common/core';
import { ALL_PERMISSION_KEYS, PERMISSIONS } from '../common/permissions';

const roleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  scope: z.enum(['OWN', 'TEAM', 'ALL']),
  permissions: z.array(z.string()).refine((a) => a.every((k) => ALL_PERMISSION_KEYS.includes(k)), 'Unknown permission'),
});

@Controller()
export class OrgController {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Organisation -------------------------------------------------------

  @Get('organisation')
  organisation(@Context() ctx: Ctx) {
    return this.prisma.organisation.findUniqueOrThrow({ where: { id: ctx.orgId } });
  }

  @Perm('settings.manage')
  @Patch('organisation')
  async updateOrganisation(@Context() ctx: Ctx, @Body() body: unknown) {
    const data = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        timezone: z.string().trim().min(2).max(60).optional(),
        currency: z.string().trim().length(3).toUpperCase().optional(),
        dateFormat: z.enum(['DD MMM YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']).optional(),
      }),
      body,
    );
    const org = await this.prisma.organisation.update({ where: { id: ctx.orgId }, data });
    await audit(this.prisma, ctx, 'organisation.updated', 'organisation', org.id, data);
    return org;
  }

  // ---- Users --------------------------------------------------------------

  /** Any signed-in member may list colleagues (needed for owner pickers); details stay minimal. */
  @Get('users')
  async users(@Context() ctx: Ctx) {
    const rows = await this.prisma.membership.findMany({
      where: { organisationId: ctx.orgId },
      include: { user: true, role: true, team: true },
      orderBy: { createdAt: 'asc' },
    });
    const full = ctx.perms.has('users.view') || ctx.perms.has('users.manage');
    return rows.map((m) => ({
      membershipId: m.id,
      id: m.userId,
      name: m.user.name,
      status: m.status,
      role: { id: m.role.id, name: m.role.name, systemKey: m.role.systemKey },
      team: m.team ? { id: m.team.id, name: m.team.name } : null,
      ...(full ? { email: m.user.email, phone: m.user.phone, joinedAt: m.createdAt } : {}),
    }));
  }

  @Perm('users.manage')
  @Patch('users/:membershipId')
  async updateUser(@Context() ctx: Ctx, @Param('membershipId') id: string, @Body() body: unknown) {
    const data = parse(
      z.object({ roleId: z.string().optional(), teamId: z.string().nullable().optional(), status: z.enum(['ACTIVE', 'DEACTIVATED']).optional() }),
      body,
    );
    const m = await this.prisma.membership.findFirst({ where: { id, organisationId: ctx.orgId }, include: { role: true } });
    if (!m) throw new NotFoundException('User not found');

    const changingAccess = data.roleId !== undefined || data.status !== undefined;
    if (changingAccess && m.userId === ctx.userId) throw new BadRequestException('You cannot change your own role or status');
    if (changingAccess && m.role.systemKey === 'owner' && ctx.roleKey !== 'owner') {
      throw new ForbiddenException('Only an owner can change another owner');
    }
    if (data.roleId) {
      const role = await this.prisma.role.findFirst({ where: { id: data.roleId, organisationId: ctx.orgId } });
      if (!role) throw new BadRequestException('Role not found');
      if (role.systemKey === 'owner' && ctx.roleKey !== 'owner') throw new ForbiddenException('Only an owner can grant the Owner role');
    }
    if (data.teamId) {
      const team = await this.prisma.team.findFirst({ where: { id: data.teamId, organisationId: ctx.orgId } });
      if (!team) throw new BadRequestException('Team not found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id }, data });
      if (data.status === 'DEACTIVATED') {
        await tx.session.updateMany({ where: { userId: m.userId, organisationId: ctx.orgId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await audit(tx, ctx, 'user.updated', 'membership', id, data);
    });
    return { ok: true };
  }

  // ---- Invitations --------------------------------------------------------

  @Perm('users.manage')
  @Get('invitations')
  async invitations(@Context() ctx: Ctx) {
    const rows = await this.prisma.invitation.findMany({
      where: { organisationId: ctx.orgId, acceptedAt: null },
      include: { role: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((i) => ({ id: i.id, email: i.email, role: i.role.name, expiresAt: i.expiresAt, expired: i.expiresAt < new Date(), createdAt: i.createdAt }));
  }

  @Perm('users.manage')
  @Post('invitations')
  async invite(@Context() ctx: Ctx, @Body() body: unknown) {
    const data = parse(z.object({ email: z.string().trim().toLowerCase().email(), roleId: z.string() }), body);
    const role = await this.prisma.role.findFirst({ where: { id: data.roleId, organisationId: ctx.orgId } });
    if (!role) throw new BadRequestException('Role not found');
    if (role.systemKey === 'owner' && ctx.roleKey !== 'owner') throw new ForbiddenException('Only an owner can invite another owner');
    const member = await this.prisma.membership.findFirst({ where: { organisationId: ctx.orgId, user: { email: data.email } } });
    if (member) throw new ConflictException('This person is already in your workspace');

    const token = randomToken();
    await this.prisma.invitation.deleteMany({ where: { organisationId: ctx.orgId, email: data.email, acceptedAt: null } });
    const inv = await this.prisma.invitation.create({
      data: {
        organisationId: ctx.orgId,
        email: data.email,
        roleId: role.id,
        tokenHash: sha256(token),
        invitedById: ctx.userId,
        expiresAt: new Date(Date.now() + 7 * 864e5),
      },
    });
    await audit(this.prisma, ctx, 'invitation.created', 'invitation', inv.id, { email: data.email, role: role.name });
    // No email provider is connected yet, so the link is returned once for the admin to share.
    return { id: inv.id, email: inv.email, inviteUrl: `${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}/invite/${token}`, emailSent: false };
  }

  @Perm('users.manage')
  @Delete('invitations/:id')
  async cancelInvitation(@Context() ctx: Ctx, @Param('id') id: string) {
    const r = await this.prisma.invitation.deleteMany({ where: { id, organisationId: ctx.orgId, acceptedAt: null } });
    if (!r.count) throw new NotFoundException('Invitation not found');
    return { ok: true };
  }

  // ---- Roles --------------------------------------------------------------

  @Get('permissions')
  permissions() {
    return PERMISSIONS;
  }

  @Get('roles')
  async roles(@Context() ctx: Ctx) {
    const rows = await this.prisma.role.findMany({
      where: { organisationId: ctx.orgId },
      include: { _count: { select: { memberships: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, systemKey: r.systemKey, scope: r.scope, permissions: r.permissions, users: r._count.memberships }));
  }

  @Perm('roles.manage')
  @Post('roles')
  async createRole(@Context() ctx: Ctx, @Body() body: unknown) {
    const data = parse(roleSchema, body);
    if (await this.prisma.role.findFirst({ where: { organisationId: ctx.orgId, name: { equals: data.name, mode: 'insensitive' } } })) {
      throw new ConflictException('A role with this name already exists');
    }
    const role = await this.prisma.role.create({ data: { organisationId: ctx.orgId, ...data } });
    await audit(this.prisma, ctx, 'role.created', 'role', role.id, data);
    return role;
  }

  @Perm('roles.manage')
  @Patch('roles/:id')
  async updateRole(@Context() ctx: Ctx, @Param('id') id: string, @Body() body: unknown) {
    const data = parse(roleSchema.partial(), body);
    const role = await this.prisma.role.findFirst({ where: { id, organisationId: ctx.orgId } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.systemKey === 'owner') throw new BadRequestException('The Owner role cannot be changed');
    if (role.systemKey && data.name && data.name !== role.name) throw new BadRequestException('Built-in roles cannot be renamed');
    const updated = await this.prisma.role.update({ where: { id }, data });
    await audit(this.prisma, ctx, 'role.updated', 'role', id, data);
    return updated;
  }

  @Perm('roles.manage')
  @Delete('roles/:id')
  async deleteRole(@Context() ctx: Ctx, @Param('id') id: string) {
    const role = await this.prisma.role.findFirst({ where: { id, organisationId: ctx.orgId }, include: { _count: { select: { memberships: true } } } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.systemKey) throw new BadRequestException('Built-in roles cannot be deleted');
    if (role._count.memberships) throw new BadRequestException('Move its users to another role before deleting this role');
    await this.prisma.role.delete({ where: { id } });
    await audit(this.prisma, ctx, 'role.deleted', 'role', id, { name: role.name });
    return { ok: true };
  }

  // ---- Teams --------------------------------------------------------------

  @Get('teams')
  async teams(@Context() ctx: Ctx) {
    const rows = await this.prisma.team.findMany({
      where: { organisationId: ctx.orgId },
      include: { _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((t) => ({ id: t.id, name: t.name, members: t._count.members }));
  }

  @Perm('users.manage')
  @Post('teams')
  async createTeam(@Context() ctx: Ctx, @Body() body: unknown) {
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(60) }), body);
    if (await this.prisma.team.findFirst({ where: { organisationId: ctx.orgId, name: { equals: name, mode: 'insensitive' } } })) {
      throw new ConflictException('A team with this name already exists');
    }
    return this.prisma.team.create({ data: { organisationId: ctx.orgId, name } });
  }

  @Perm('users.manage')
  @Delete('teams/:id')
  async deleteTeam(@Context() ctx: Ctx, @Param('id') id: string) {
    const r = await this.prisma.team.deleteMany({ where: { id, organisationId: ctx.orgId } });
    if (!r.count) throw new NotFoundException('Team not found');
    return { ok: true };
  }

  // ---- Notifications ------------------------------------------------------

  @Get('notifications')
  async notifications(@Context() ctx: Ctx) {
    const where = { organisationId: ctx.orgId, userId: ctx.userId };
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    return { items, unread };
  }

  @Post('notifications/read') @HttpCode(200)
  async readNotifications(@Context() ctx: Ctx, @Body() body: unknown) {
    const { id } = parse(z.object({ id: z.string().optional() }), body ?? {});
    await this.prisma.notification.updateMany({
      where: { organisationId: ctx.orgId, userId: ctx.userId, readAt: null, ...(id ? { id } : {}) },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  // ---- Audit log ----------------------------------------------------------

  @Perm('settings.manage')
  @Get('audit-log')
  async auditLog(@Context() ctx: Ctx, @Query() query: unknown) {
    const { page } = parse(z.object({ page: z.coerce.number().int().min(1).default(1) }), query);
    const where = { organisationId: ctx.orgId };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50 }),
      this.prisma.auditLog.count({ where }),
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.actorId).filter(Boolean) as string[])] } }, select: { id: true, name: true } });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return { items: items.map((i) => ({ ...i, actor: i.actorId ? names.get(i.actorId) ?? null : null })), total, page, pageSize: 50 };
  }
}
