import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';

try {
  process.loadEnvFile();
} catch {
  // No .env file: configuration comes from the real environment (production).
}

import { AppModule, configureApp } from './app.module';
import { jwtSecret } from './common/core';

async function bootstrap() {
  jwtSecret(); // fail fast on missing configuration
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: false, limit: '1mb' }));
  configureApp(app);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`PowerMyCRM API listening on http://localhost:${port}/api/v1`);
}

bootstrap();
