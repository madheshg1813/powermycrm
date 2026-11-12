import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

try {
  process.loadEnvFile();
} catch {
  // No .env file: configuration comes from the real environment (production).
}

import { AppModule, configureApp } from './app.module';
import { jwtSecret } from './common/core';

async function bootstrap() {
  jwtSecret(); // fail fast on missing configuration
  // rawBody keeps the exact bytes so provider webhooks (Razorpay, Meta) can be signature-checked.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, rawBody: true });
  app.useBodyParser('json', { limit: '5mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '1mb' });
  configureApp(app);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`PowerMyCRM API listening on http://localhost:${port}/api/v1`);
}

bootstrap();
