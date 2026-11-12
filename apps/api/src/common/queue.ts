import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';
import type { Job, PgBoss as PgBossClient } from 'pg-boss';

// pg-boss ships as an ES module. Node (22.12+) can require ES modules natively, but the Jest module loader cannot,
// so it is loaded through Node's own require in every environment.
// process.getBuiltinModule reaches Node's real module system even inside a test sandbox that wraps require().
const nodeModule = (process as unknown as { getBuiltinModule(name: string): typeof import('module') }).getBuiltinModule('module');
const { PgBoss } = nodeModule.createRequire(__filename)('pg-boss') as typeof import('pg-boss');

// ---- Secrets at rest ---------------------------------------------------------
// Integration credentials, form tokens and webhook secrets are encrypted with AES-256-GCM under CREDENTIALS_KEY.

function credentialsKey(): Buffer {
  const key = Buffer.from(process.env.CREDENTIALS_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)');
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialsKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

export function decrypt(stored: string): string {
  const [v, iv, tag, body] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('Stored secret has an unknown format');
  const decipher = createDecipheriv('aes-256-gcm', credentialsKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

/** Constant-time string comparison for tokens and signatures. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- Job queue ------------------------------------------------------------------

export type JobHandler<T> = (data: T, job: Job<T>) => Promise<void>;
type QueueOpts = { retryLimit?: number; retryDelay?: number; retryBackoff?: boolean; retryDelayMax?: number; batchSize?: number };
type Registration = { name: string; handler: JobHandler<any>; opts: QueueOpts };

/**
 * Durable background jobs on PostgreSQL (pg-boss), running inside the API process. Handlers register during
 * module init with `work()`; polling starts once the application has booted so every handler is in place first.
 * Jobs are retried with exponential backoff up to the queue's retry limit, then parked as failed.
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Queue');
  private boss: PgBossClient | null = null;
  private readonly registrations: Registration[] = [];
  readonly enabled = process.env.QUEUE_DISABLED !== 'true';

  work<T extends object>(name: string, handler: JobHandler<T>, opts: QueueOpts = {}) {
    this.registrations.push({ name, handler, opts });
  }

  async onApplicationBootstrap() {
    if (!this.enabled) {
      this.log.warn('QUEUE_DISABLED=true: background jobs will not run in this process');
      return;
    }
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: 'pgboss', max: 4 });
    boss.on('error', (e) => this.log.error(`pg-boss: ${(e as Error).message}`));
    await boss.start();
    for (const r of this.registrations) {
      const queueOptions = { retryLimit: r.opts.retryLimit ?? 5, retryDelay: r.opts.retryDelay ?? 60, retryBackoff: r.opts.retryBackoff ?? true, retryDelayMax: r.opts.retryDelayMax ?? 12 * 3600 };
      if (await boss.getQueue(r.name)) await boss.updateQueue(r.name, queueOptions);
      else await boss.createQueue(r.name, queueOptions);
      // Jobs in a batch run concurrently; one failure fails only that job's batch-mates in pg-boss terms, so batches stay small.
      await boss.work<any>(r.name, { pollingIntervalSeconds: 0.5, batchSize: r.opts.batchSize ?? 10, perJobResults: true }, async (jobs) => {
        return Promise.all(jobs.map(async (job) => {
          try { await r.handler(job.data, job); return { id: job.id, status: 'completed' as const }; }
          catch (e) { return { id: job.id, status: 'failed' as const, output: { message: (e as Error).message } }; }
        }));
      });
    }
    this.boss = boss;
    this.log.log(`Queue started with ${this.registrations.length} handler(s)`);
  }

  /** Enqueue a job. Returns null when the queue is disabled or not yet started (callers must not depend on the id). */
  async send(name: string, data: object, opts: { singletonKey?: string; startAfter?: number } = {}): Promise<string | null> {
    if (!this.boss) return null;
    try {
      return await this.boss.send(name, data, opts);
    } catch (e) {
      this.log.error(`Could not enqueue ${name}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Recurring job on a cron expression (minute granularity). */
  async schedule(name: string, cron: string, data: object = {}) {
    if (!this.boss) return;
    await this.boss.schedule(name, cron, data);
  }

  async onModuleDestroy() {
    await this.boss?.stop({ graceful: false, timeout: 2000 });
    this.boss = null;
  }
}
