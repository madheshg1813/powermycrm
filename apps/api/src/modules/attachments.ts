import { BadRequestException, Controller, Delete, Get, NotFoundException, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { randomBytes } from 'crypto';
import { Context, Ctx, Perm, PrismaService, audit } from '../common/core';
import { StorageService } from '../common/storage';
import { LeadsService } from './leads';

/** What multer hands us for a single memory-stored file. */
type UploadedFileLike = { originalname?: string; size: number; buffer: Buffer };
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Extension → stored MIME type. Anything else is refused: no executables, scripts or archives. */
const ALLOWED: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4',
};
export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);

const present = (a: { id: string; leadId: string; name: string; mimeType: string; size: number; createdAt: Date; uploadedBy?: { id: string; name: string } | null }) =>
  ({ id: a.id, leadId: a.leadId, name: a.name, mimeType: a.mimeType, size: a.size, createdAt: a.createdAt, uploadedBy: a.uploadedBy ?? null });

/** Files on a lead: quotes, ID proofs, call recordings. Stored through StorageService; metadata in the database. */
@Controller()
export class AttachmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly storage: StorageService,
  ) {}

  private async visibleLead(ctx: Ctx, leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, organisationId: ctx.orgId, AND: [await this.leads.scope(ctx)] }, select: { id: true, name: true, archivedAt: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  private async find(ctx: Ctx, id: string) {
    const a = await this.prisma.leadAttachment.findFirst({ where: { id, organisationId: ctx.orgId, lead: { AND: [await this.leads.scope(ctx)] } }, include: { uploadedBy: { select: { id: true, name: true } } } });
    if (!a) throw new NotFoundException('Attachment not found');
    return a;
  }

  @Perm('leads.view') @Get('leads/:id/attachments')
  async list(@Context() ctx: Ctx, @Param('id') leadId: string) {
    await this.visibleLead(ctx, leadId);
    const rows = await this.prisma.leadAttachment.findMany({ where: { leadId, organisationId: ctx.orgId }, include: { uploadedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } });
    return rows.map(present);
  }

  @Perm('leads.edit') @Post('leads/:id/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }))
  async upload(@Context() ctx: Ctx, @Param('id') leadId: string, @UploadedFile() file?: UploadedFileLike) {
    const lead = await this.visibleLead(ctx, leadId);
    if (!file) throw new BadRequestException('Choose a file to upload');
    if (lead.archivedAt) throw new BadRequestException('Restore the lead before adding files');
    const name = (file.originalname || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 160);
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const mimeType = ALLOWED[ext];
    if (!mimeType) throw new BadRequestException(`This file type is not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
    if (!file.size) throw new BadRequestException('The file is empty');
    const count = await this.prisma.leadAttachment.count({ where: { leadId } });
    if (count >= 50) throw new BadRequestException('A lead can have up to 50 files');
    const storageKey = `${ctx.orgId}/${leadId}/${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${ext}`;
    await this.storage.put(storageKey, file.buffer);
    const row = await this.prisma.$transaction(async (tx) => {
      const row = await tx.leadAttachment.create({ data: { organisationId: ctx.orgId, leadId, name, mimeType, size: file.size, storageKey, uploadedById: ctx.userId }, include: { uploadedBy: { select: { id: true, name: true } } } });
      await tx.leadActivity.create({ data: { organisationId: ctx.orgId, leadId, actorId: ctx.userId, type: 'attachment_added', data: { id: row.id, name, size: file.size } } });
      await tx.lead.update({ where: { id: leadId }, data: { lastActivityAt: new Date() } });
      return row;
    });
    return present(row);
  }

  @Perm('leads.view') @Get('attachments/:id/download')
  async download(@Context() ctx: Ctx, @Param('id') id: string, @Res() res: Response) {
    const a = await this.find(ctx, id);
    const stream = await this.storage.stream(a.storageKey).catch(() => null);
    if (!stream) throw new NotFoundException('The file is missing from storage');
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader('Content-Length', String(a.size));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.pipe(res);
  }

  @Perm('leads.edit') @Delete('attachments/:id')
  async remove(@Context() ctx: Ctx, @Param('id') id: string) {
    const a = await this.find(ctx, id);
    await this.prisma.$transaction([
      this.prisma.leadAttachment.delete({ where: { id } }),
      this.prisma.leadActivity.create({ data: { organisationId: ctx.orgId, leadId: a.leadId, actorId: ctx.userId, type: 'attachment_removed', data: { name: a.name } } }),
      audit(this.prisma, ctx, 'attachment.deleted', 'lead_attachment', id, { leadId: a.leadId, name: a.name }),
    ]);
    await this.storage.delete(a.storageKey).catch(() => undefined);
    return { ok: true };
  }
}
