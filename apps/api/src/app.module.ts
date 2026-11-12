import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AuthGuard, PrismaService, Public } from './common/core';
import { QueueService } from './common/queue';
import { StorageService } from './common/storage';
import { AttachmentsController } from './modules/attachments';
import { EmailController, EmailService } from './modules/email';
import { ApiKeysController, IntegrationsController } from './modules/integrations';
import { OutboxService, WebhooksController } from './modules/webhooks';
import { AuthController, AuthService } from './modules/auth';
import { CatalogController } from './modules/catalog';
import { CustomiseController } from './modules/customise';
import { DashboardController } from './modules/dashboard';
import { OpportunitiesController, PaymentsController } from './modules/deals';
import { LeadsController, LeadsService } from './modules/leads';
import { ListsController } from './modules/lists';
import { OrgController } from './modules/org';
import { ReportsController } from './modules/reports';
import { TasksController } from './modules/tasks';

@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public() @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 600 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
  ],
  controllers: [HealthController, AuthController, OrgController, CatalogController, CustomiseController, LeadsController, ListsController, TasksController, DashboardController, ReportsController, OpportunitiesController, PaymentsController, WebhooksController, IntegrationsController, ApiKeysController, EmailController, AttachmentsController],
  providers: [
    PrismaService,
    QueueService,
    StorageService,
    OutboxService,
    EmailService,
    AuthService,
    LeadsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}

/** Shared by the server entry point and the end-to-end tests so both run the same pipeline. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser());
  const origin = process.env.WEB_ORIGIN;
  if (origin) app.enableCors({ origin: origin.split(','), credentials: true });
  // Website forms post from any site, so the hooks route answers cross-origin requests itself.
  app.use('/api/v1/hooks', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Form-Token, X-Request-Id');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  (app.getHttpAdapter().getInstance() as any).set?.('trust proxy', 1);
  return app;
}
