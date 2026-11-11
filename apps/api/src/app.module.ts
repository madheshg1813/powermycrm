import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AuthGuard, PrismaService, Public } from './common/core';
import { AuthController, AuthService } from './modules/auth';
import { CatalogController } from './modules/catalog';
import { CustomiseController } from './modules/customise';
import { DashboardController } from './modules/dashboard';
import { LeadsController, LeadsService } from './modules/leads';
import { ListsController } from './modules/lists';
import { OrgController } from './modules/org';
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
  controllers: [HealthController, AuthController, OrgController, CatalogController, CustomiseController, LeadsController, ListsController, TasksController, DashboardController],
  providers: [
    PrismaService,
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
  (app.getHttpAdapter().getInstance() as any).set?.('trust proxy', 1);
  return app;
}
