import { BadRequestException, Controller, ForbiddenException, Get, Header, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Context, Ctx, Perm, PrismaService, audit, parse } from '../common/core';
import { LeadsService, csvCell } from './leads';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD');
const UNITS = ['hour', 'day', 'week', 'month'] as const;
type Unit = (typeof UNITS)[number];
const rangeSchema = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  unit: z.enum(UNITS).default('day'),
  ownerId: z.string().optional(),
  sourceId: z.string().optional(),
});
const exportSchema = rangeSchema.extend({ report: z.enum(['summary', 'agents', 'sources', 'followups']) });

type Range = { from: string; to: string; fromAt: Date; toAt: Date; unit: Unit; timezone: string; owners: string[] | null; sourceId: string | null };

// ---- Time-zone helpers -------------------------------------------------------
// Report buckets follow the organisation's timezone, so "today" means today for the sales team, not UTC.

function tzOffsetMs(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Intl gives whole seconds, so compare against the whole-second instant to keep the millisecond part of `at` intact.
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at.getTime() / 1000) * 1000;
}
/** The instant at which the given local calendar day starts (or ends) in `tz`. */
function zonedDay(day: string, tz: string, end = false) {
  const guess = new Date(`${day}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
  return new Date(guess.getTime() - tzOffsetMs(guess, tz));
}
export function todayIn(tz: string, at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** Every bucket key between `from` and `to`, so quiet periods still appear as zero rows. */
export function bucketKeys(from: string, to: string, unit: Unit): string[] {
  if (unit === 'hour') return Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const keys: string[] = [];
  if (unit === 'day') for (let d = from; d <= to; d = addDays(d, 1)) keys.push(d);
  else if (unit === 'week') {
    const dow = (new Date(`${from}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0, matching date_trunc('week')
    for (let d = addDays(from, -dow); d <= to; d = addDays(d, 7)) keys.push(d);
  } else {
    let [y, m] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      keys.push(`${y}-${String(m).padStart(2, '0')}`);
      if (++m > 12) { m = 1; y++; }
    }
  }
  return keys;
}

/** The instants a bucket covers, clamped to the report range so a drill-down lists exactly the counted leads. Hour-of-day buckets span many days and have none. */
function bucketBounds(bucket: string, r: Range): { fromAt?: string; toAt?: string } {
  if (r.unit === 'hour') return {};
  const [y, m] = bucket.split('-').map(Number);
  const startDay = r.unit === 'month' ? `${bucket}-01` : bucket;
  const endDay = r.unit === 'day' ? bucket : r.unit === 'week' ? addDays(bucket, 6) : `${bucket}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
  const s = Math.max(zonedDay(startDay, r.timezone).getTime(), r.fromAt.getTime());
  const e = Math.min(zonedDay(endDay, r.timezone, true).getTime(), r.toAt.getTime());
  return { fromAt: new Date(s).toISOString(), toAt: new Date(e).toISOString() };
}

type Row = Record<string, string | number | boolean | null>;
const csv = (head: string[], rows: Row[], keys: string[]) =>
  '﻿' + [head.map(csvCell).join(','), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(','))].join('\r\n');
const pct = (won: number, lost: number) => (won + lost ? won / (won + lost) : null);

/**
 * Reports. Every number is computed from stored leads, tasks and activities at request time, inside the caller's
 * record scope. "Won" and "lost" are counted on the day the lead entered its closing stage; "created" on the day it was added.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
  ) {}

  private async range(ctx: Ctx, q: z.infer<typeof rangeSchema>): Promise<Range> {
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { timezone: true } });
    const tz = org.timezone || 'UTC';
    try { todayIn(tz); } catch { throw new BadRequestException(`The workspace timezone "${tz}" is not valid; fix it in Settings`); }
    const to = q.to ?? todayIn(tz);
    const from = q.from ?? addDays(to, -29);
    if (from > to) throw new BadRequestException('The start date must be on or before the end date');
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) throw new BadRequestException('Choose a range of up to one year');
    let owners = await this.leads.ownerIds(ctx);
    if (q.ownerId) {
      if (owners && !owners.includes(q.ownerId)) throw new ForbiddenException('You cannot report on this user');
      owners = [q.ownerId];
    }
    if (q.sourceId && !(await this.prisma.leadSource.findFirst({ where: { id: q.sourceId, organisationId: ctx.orgId } }))) throw new BadRequestException('Lead source not found');
    return { from, to, fromAt: zonedDay(from, tz), toAt: zonedDay(to, tz, true), unit: q.unit, timezone: tz, owners, sourceId: q.sourceId ?? null };
  }

  private meta(r: Range) {
    return { from: r.from, to: r.to, fromAt: r.fromAt.toISOString(), toAt: r.toAt.toISOString(), unit: r.unit, timezone: r.timezone };
  }

  // Shared SQL fragments. Column names are quoted identifiers written here, never user input.
  private bucket(col: Prisma.Sql, r: Range) {
    if (r.unit === 'hour') return Prisma.sql`to_char(${col} AT TIME ZONE ${r.timezone}, 'HH24')`;
    return Prisma.sql`to_char(date_trunc(${r.unit}, ${col} AT TIME ZONE ${r.timezone}), ${r.unit === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'})`;
  }
  private leadFilter(ctx: Ctx, r: Range) {
    return Prisma.sql`l."organisationId" = ${ctx.orgId} AND l."archivedAt" IS NULL
      ${r.owners ? Prisma.sql`AND l."ownerId" IN (${Prisma.join(r.owners)})` : Prisma.empty}
      ${r.sourceId ? Prisma.sql`AND l."sourceId" = ${r.sourceId}` : Prisma.empty}`;
  }
  private leadWhere(ctx: Ctx, r: Range): Prisma.LeadWhereInput {
    return {
      organisationId: ctx.orgId,
      archivedAt: null,
      ...(r.owners ? { ownerId: { in: r.owners } } : {}),
      ...(r.sourceId ? { sourceId: r.sourceId } : {}),
    };
  }

  // ---- Summary: created / won / lost / won value per bucket -------------------

  private async summaryData(ctx: Ctx, r: Range) {
    const [created, closed] = await Promise.all([
      this.prisma.$queryRaw<{ bucket: string; n: number }[]>`
        SELECT ${this.bucket(Prisma.sql`l."createdAt"`, r)} AS bucket, count(*)::int AS n
        FROM "Lead" l
        WHERE ${this.leadFilter(ctx, r)} AND l."createdAt" >= ${r.fromAt} AND l."createdAt" <= ${r.toAt}
        GROUP BY 1`,
      this.prisma.$queryRaw<{ bucket: string; type: string; n: number; value: number }[]>`
        SELECT ${this.bucket(Prisma.sql`l."stageEnteredAt"`, r)} AS bucket, s."type"::text AS type, count(*)::int AS n, coalesce(sum(l."dealValue"), 0)::float8 AS value
        FROM "Lead" l JOIN "Stage" s ON s."id" = l."stageId"
        WHERE ${this.leadFilter(ctx, r)} AND s."type" IN ('WON', 'LOST') AND l."stageEnteredAt" >= ${r.fromAt} AND l."stageEnteredAt" <= ${r.toAt}
        GROUP BY 1, 2`,
    ]);
    const series = bucketKeys(r.from, r.to, r.unit).map((bucket) => {
      const won = closed.find((c) => c.bucket === bucket && c.type === 'WON');
      const lost = closed.find((c) => c.bucket === bucket && c.type === 'LOST');
      return { bucket, ...bucketBounds(bucket, r), created: created.find((c) => c.bucket === bucket)?.n ?? 0, won: won?.n ?? 0, lost: lost?.n ?? 0, wonValue: won?.value ?? 0 };
    });
    const totals = series.reduce((a, s) => ({ created: a.created + s.created, won: a.won + s.won, lost: a.lost + s.lost, wonValue: a.wonValue + s.wonValue }), { created: 0, won: 0, lost: 0, wonValue: 0 });
    const openNow = await this.prisma.lead.count({ where: { ...this.leadWhere(ctx, r), stage: { type: 'OPEN' } } });
    return {
      range: this.meta(r),
      totals: { ...totals, conversion: pct(totals.won, totals.lost), avgWonValue: totals.won ? totals.wonValue / totals.won : null, openNow },
      series,
    };
  }

  @Perm('reports.view') @Get('summary')
  async summary(@Context() ctx: Ctx, @Query() query: unknown) {
    return this.summaryData(ctx, await this.range(ctx, parse(rangeSchema, query)));
  }

  // ---- Agent leaderboard --------------------------------------------------------

  private async agentsData(ctx: Ctx, r: Range) {
    const base = this.leadWhere(ctx, r);
    const inRange = { gte: r.fromAt, lte: r.toAt };
    const assignees = r.owners ? { assigneeId: { in: r.owners } } : {};
    const [members, created, won, lost, open, tasks, notes] = await Promise.all([
      this.prisma.membership.findMany({ where: { organisationId: ctx.orgId, ...(r.owners ? { userId: { in: r.owners } } : {}) }, include: { user: { select: { id: true, name: true } } } }),
      this.prisma.lead.groupBy({ by: ['ownerId'], where: { ...base, createdAt: inRange }, _count: true }),
      this.prisma.lead.groupBy({ by: ['ownerId'], where: { ...base, stage: { type: 'WON' }, stageEnteredAt: inRange }, _count: true, _sum: { dealValue: true } }),
      this.prisma.lead.groupBy({ by: ['ownerId'], where: { ...base, stage: { type: 'LOST' }, stageEnteredAt: inRange }, _count: true }),
      this.prisma.lead.groupBy({ by: ['ownerId'], where: { ...base, stage: { type: 'OPEN' } }, _count: true }),
      this.prisma.task.groupBy({ by: ['assigneeId'], where: { organisationId: ctx.orgId, ...assignees, status: 'DONE', completedAt: inRange }, _count: true }),
      this.prisma.leadActivity.groupBy({ by: ['actorId'], where: { organisationId: ctx.orgId, type: 'note', createdAt: inRange, ...(r.owners ? { actorId: { in: r.owners } } : {}) }, _count: true }),
    ]);
    const onTime = await this.prisma.$queryRaw<{ assigneeId: string; n: number }[]>`
      SELECT t."assigneeId", count(*)::int AS n FROM "Task" t
      WHERE t."organisationId" = ${ctx.orgId} AND t."status" = 'DONE' AND t."completedAt" >= ${r.fromAt} AND t."completedAt" <= ${r.toAt} AND t."completedAt" <= t."dueAt"
      ${r.owners ? Prisma.sql`AND t."assigneeId" IN (${Prisma.join(r.owners)})` : Prisma.empty}
      GROUP BY 1`;
    const overdue = await this.prisma.task.groupBy({ by: ['assigneeId'], where: { organisationId: ctx.orgId, ...assignees, status: 'OPEN', dueAt: { lt: new Date() } }, _count: true });

    const pick = <T extends { _count: number }>(rows: (T & { ownerId?: string | null; assigneeId?: string; actorId?: string | null })[], id: string | null) =>
      rows.find((x) => (x.ownerId ?? x.assigneeId ?? x.actorId ?? null) === id);
    const row = (id: string | null, name: string, active: boolean) => {
      const w = pick(won, id);
      const c = pick(created, id)?._count ?? 0, wn = w?._count ?? 0, ls = pick(lost, id)?._count ?? 0;
      return {
        id, name, active,
        created: c, won: wn, lost: ls, wonValue: Number(w?._sum.dealValue ?? 0), open: pick(open, id)?._count ?? 0, conversion: pct(wn, ls),
        tasksCompleted: pick(tasks, id)?._count ?? 0, tasksOnTime: onTime.find((x) => x.assigneeId === id)?.n ?? 0, tasksOverdue: pick(overdue, id)?._count ?? 0,
        notes: pick(notes, id)?._count ?? 0,
      };
    };
    const rows = members.map((m) => row(m.user.id, m.user.name, m.status === 'ACTIVE'));
    const unassigned = row(null, 'Unassigned', false);
    if (unassigned.created || unassigned.open || unassigned.won || unassigned.lost) rows.push(unassigned);
    rows.sort((a, b) => b.won - a.won || b.wonValue - a.wonValue || b.created - a.created || a.name.localeCompare(b.name));
    return { range: this.meta(r), rows };
  }

  @Perm('reports.view') @Get('agents')
  async agents(@Context() ctx: Ctx, @Query() query: unknown) {
    return this.agentsData(ctx, await this.range(ctx, parse(rangeSchema, query)));
  }

  // ---- Lead sources ---------------------------------------------------------------

  private async sourcesData(ctx: Ctx, r: Range) {
    const base = this.leadWhere(ctx, r);
    const inRange = { gte: r.fromAt, lte: r.toAt };
    const [sources, created, won, lost, open] = await Promise.all([
      this.prisma.leadSource.findMany({ where: { organisationId: ctx.orgId }, orderBy: { name: 'asc' } }),
      this.prisma.lead.groupBy({ by: ['sourceId'], where: { ...base, createdAt: inRange }, _count: true }),
      this.prisma.lead.groupBy({ by: ['sourceId'], where: { ...base, stage: { type: 'WON' }, stageEnteredAt: inRange }, _count: true, _sum: { dealValue: true } }),
      this.prisma.lead.groupBy({ by: ['sourceId'], where: { ...base, stage: { type: 'LOST' }, stageEnteredAt: inRange }, _count: true }),
      this.prisma.lead.groupBy({ by: ['sourceId'], where: { ...base, stage: { type: 'OPEN' } }, _count: true }),
    ]);
    const row = (id: string | null, name: string) => {
      const w = won.find((x) => x.sourceId === id);
      const c = created.find((x) => x.sourceId === id)?._count ?? 0, wn = w?._count ?? 0, ls = lost.find((x) => x.sourceId === id)?._count ?? 0;
      return { id, name, created: c, won: wn, lost: ls, wonValue: Number(w?._sum.dealValue ?? 0), open: open.find((x) => x.sourceId === id)?._count ?? 0, conversion: pct(wn, ls) };
    };
    const rows = sources.filter((s) => !r.sourceId || s.id === r.sourceId).map((s) => row(s.id, s.name));
    if (!r.sourceId) rows.push(row(null, 'No source'));
    rows.sort((a, b) => b.created - a.created || b.won - a.won || a.name.localeCompare(b.name));
    return { range: this.meta(r), rows };
  }

  @Perm('reports.view') @Get('sources')
  async sources(@Context() ctx: Ctx, @Query() query: unknown) {
    return this.sourcesData(ctx, await this.range(ctx, parse(rangeSchema, query)));
  }

  // ---- Follow-ups -------------------------------------------------------------------

  private async followUpsData(ctx: Ctx, r: Range) {
    const owners = r.owners ? Prisma.sql`AND t."assigneeId" IN (${Prisma.join(r.owners)})` : Prisma.empty;
    const measures = Prisma.sql`
      count(*) FILTER (WHERE t."dueAt" >= ${r.fromAt} AND t."dueAt" <= ${r.toAt})::int AS due,
      count(*) FILTER (WHERE t."status" = 'DONE' AND t."completedAt" >= ${r.fromAt} AND t."completedAt" <= ${r.toAt})::int AS completed,
      count(*) FILTER (WHERE t."status" = 'DONE' AND t."completedAt" >= ${r.fromAt} AND t."completedAt" <= ${r.toAt} AND t."completedAt" <= t."dueAt")::int AS "onTime",
      count(*) FILTER (WHERE t."status" = 'CANCELLED' AND t."dueAt" >= ${r.fromAt} AND t."dueAt" <= ${r.toAt})::int AS cancelled,
      count(*) FILTER (WHERE t."status" = 'OPEN' AND t."dueAt" < now())::int AS overdue,
      count(*) FILTER (WHERE t."status" = 'OPEN' AND t."dueAt" >= now())::int AS upcoming`;
    type M = { due: number; completed: number; onTime: number; cancelled: number; overdue: number; upcoming: number };
    const [members, perUser, perType] = await Promise.all([
      this.prisma.membership.findMany({ where: { organisationId: ctx.orgId, ...(r.owners ? { userId: { in: r.owners } } : {}) }, include: { user: { select: { id: true, name: true } } } }),
      this.prisma.$queryRaw<(M & { assigneeId: string })[]>`SELECT t."assigneeId", ${measures} FROM "Task" t WHERE t."organisationId" = ${ctx.orgId} ${owners} GROUP BY 1`,
      this.prisma.$queryRaw<(M & { type: string })[]>`SELECT t."type"::text AS type, ${measures} FROM "Task" t WHERE t."organisationId" = ${ctx.orgId} ${owners} GROUP BY 1 ORDER BY 1`,
    ]);
    const zero: M = { due: 0, completed: 0, onTime: 0, cancelled: 0, overdue: 0, upcoming: 0 };
    const rows = members
      .map((m) => ({ id: m.user.id, name: m.user.name, active: m.status === 'ACTIVE', ...zero, ...(perUser.find((x) => x.assigneeId === m.user.id) ?? {}) }))
      .map(({ assigneeId: _a, ...x }: any) => x as { id: string; name: string; active: boolean } & M)
      .sort((a, b) => b.completed - a.completed || b.due - a.due || a.name.localeCompare(b.name));
    const byType = perType.map(({ type, ...m }) => ({ type, ...m }));
    const totals = rows.reduce((a, x) => ({ due: a.due + x.due, completed: a.completed + x.completed, onTime: a.onTime + x.onTime, cancelled: a.cancelled + x.cancelled, overdue: a.overdue + x.overdue, upcoming: a.upcoming + x.upcoming }), zero);
    return { range: this.meta(r), totals, rows, byType };
  }

  @Perm('reports.view') @Get('follow-ups')
  async followUps(@Context() ctx: Ctx, @Query() query: unknown) {
    return this.followUpsData(ctx, await this.range(ctx, parse(rangeSchema, query)));
  }

  // ---- CSV export -----------------------------------------------------------------------

  @Perm('reports.view') @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="report.csv"')
  async export(@Context() ctx: Ctx, @Query() query: unknown) {
    const q = parse(exportSchema, query);
    const r = await this.range(ctx, q);
    let out: string;
    if (q.report === 'summary') {
      const d = await this.summaryData(ctx, r);
      out = csv(['Period', 'Leads created', 'Won', 'Lost', 'Won value'], d.series, ['bucket', 'created', 'won', 'lost', 'wonValue']);
    } else if (q.report === 'agents') {
      const d = await this.agentsData(ctx, r);
      out = csv(
        ['Agent', 'Leads created', 'Won', 'Lost', 'Won value', 'Open now', 'Conversion', 'Follow-ups completed', 'Completed on time', 'Overdue now', 'Notes added'],
        d.rows.map((x) => ({ ...x, conversion: x.conversion === null ? '' : Math.round(x.conversion * 100) + '%' })),
        ['name', 'created', 'won', 'lost', 'wonValue', 'open', 'conversion', 'tasksCompleted', 'tasksOnTime', 'tasksOverdue', 'notes'],
      );
    } else if (q.report === 'sources') {
      const d = await this.sourcesData(ctx, r);
      out = csv(['Source', 'Leads created', 'Won', 'Lost', 'Won value', 'Open now', 'Conversion'], d.rows.map((x) => ({ ...x, conversion: x.conversion === null ? '' : Math.round(x.conversion * 100) + '%' })), ['name', 'created', 'won', 'lost', 'wonValue', 'open', 'conversion']);
    } else {
      const d = await this.followUpsData(ctx, r);
      out = csv(['Agent', 'Due in period', 'Completed', 'Completed on time', 'Cancelled', 'Overdue now', 'Upcoming'], d.rows, ['name', 'due', 'completed', 'onTime', 'cancelled', 'overdue', 'upcoming']);
    }
    await audit(this.prisma, ctx, 'report.exported', 'report', null, { report: q.report, from: r.from, to: r.to });
    return out;
  }
}
