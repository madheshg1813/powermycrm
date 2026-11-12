import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/** Per-request identity. Services build every query from this; clients never supply an organisation id. */
export interface Ctx {
  userId: string;
  orgId: string;
  sessionId: string;
  roleId: string;
  roleKey: string | null;
  scope: 'OWN' | 'TEAM' | 'ALL';
  teamId: string | null;
  perms: Set<string>;
  ip?: string;
}

export const IS_PUBLIC = 'isPublic';
export const PERMS = 'perms';
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route requires every listed permission. */
export const Perm = (...keys: string[]) => SetMetadata(PERMS, keys);
export const Context = createParamDecorator((_: unknown, ec: ExecutionContext): Ctx => ec.switchToHttp().getRequest().ctx);

export const jwtSecret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
  return s;
};
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const targets = [ec.getHandler(), ec.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ec.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Not signed in');

    let payload: { sub: string; org: string; sid: string };
    try {
      payload = jwt.verify(header.slice(7), jwtSecret()) as typeof payload;
    } catch {
      throw new UnauthorizedException('Session expired');
    }

    const [membership, session] = await Promise.all([
      this.prisma.membership.findFirst({
        where: {
          userId: payload.sub,
          organisationId: payload.org,
          status: 'ACTIVE',
          organisation: { status: 'ACTIVE' },
        },
        include: { role: true },
      }),
      this.prisma.session.findFirst({ where: { id: payload.sid, userId: payload.sub, revokedAt: null } }),
    ]);
    if (!membership || !session) throw new UnauthorizedException('Session is no longer valid');

    // Platform routes: the user must carry the super-admin flag (set from SUPER_ADMIN_EMAILS at sign-in).
    if (this.reflector.getAllAndOverride<boolean>('isSuperAdmin', targets)) {
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { isSuperAdmin: true } });
      if (!user?.isSuperAdmin) throw new ForbiddenException('This area is for platform administrators');
    }

    const perms = new Set(membership.role.permissions);
    const required = this.reflector.getAllAndOverride<string[]>(PERMS, targets) ?? [];
    for (const key of required) {
      if (!perms.has(key)) throw new ForbiddenException(`Missing permission: ${key}`);
    }

    const ctx: Ctx = {
      userId: payload.sub,
      orgId: payload.org,
      sessionId: payload.sid,
      roleId: membership.roleId,
      roleKey: membership.role.systemKey,
      scope: membership.role.scope,
      teamId: membership.teamId,
      perms,
      ip: req.ip,
    };
    req.ctx = ctx;
    return true;
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new BadRequestException({
      message: r.error.issues[0]?.message ?? 'Validation failed',
      errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export function requirePerm(ctx: Ctx, key: string) {
  if (!ctx.perms.has(key)) throw new ForbiddenException(`Missing permission: ${key}`);
}

type Db = PrismaClient | Prisma.TransactionClient;

export function audit(db: Db, ctx: Ctx, action: string, entity: string, entityId?: string | null, meta?: unknown) {
  return db.auditLog.create({
    data: {
      organisationId: ctx.orgId,
      actorId: ctx.userId,
      action,
      entity,
      entityId: entityId ?? null,
      meta: meta === undefined ? undefined : (meta as Prisma.InputJsonValue),
      ip: ctx.ip,
    },
  });
}

/** Digits only; drops a leading 0 or the 91 country code so the same Indian number always matches. */
export function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length >= 6 ? d : null;
}

export const pageSchema = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};
