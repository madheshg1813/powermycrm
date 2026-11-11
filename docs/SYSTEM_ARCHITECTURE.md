# System architecture

## Decision summary

| Area | Choice | Why |
|---|---|---|
| Shape | Modular monolith in an npm-workspaces monorepo | One deployable API keeps transactions and tenancy simple; modules have clear boundaries so they can be split later. |
| Web | Next.js (App Router), React, TypeScript, Tailwind, Lucide | As specified. Tailwind component classes mirror Power My Tutor. |
| API | NestJS, TypeScript, REST under `/api/v1`, WebSocket gateway for realtime | Module system, guards and DI fit RBAC and multi-tenancy; shared by web and future native apps. |
| Database | PostgreSQL + Prisma migrations | As specified. |
| Jobs | **pg-boss** (queue on PostgreSQL) behind a `QueueService` interface | Deviation from Redis/BullMQ: gives durable, retried, scheduled, idempotent jobs with no extra infrastructure. The interface allows a BullMQ adapter if volume requires it. |
| Files | S3-compatible storage behind `StorageService`; local-disk adapter in development | |
| Auth | Short-lived JWT access token + rotating refresh token in an httpOnly cookie, Argon2id hashes | Works for web and native clients. |
| Secrets | AES-256-GCM envelope encryption for integration credentials, key from env | |

## Repository layout

```
apps/
  api/            NestJS API, Prisma schema, migrations, worker
    src/
      common/     guards, decorators, tenancy, errors, pagination
      modules/    auth, organisations, users, roles, leads, pipelines, ...
  web/            Next.js app
    src/
      app/        routes: (auth), (workspace), admin
      components/ ui/ (design system), feature components
      lib/        api client, auth, permissions
packages/
  shared/         permission keys, enums, DTO types shared by api and web
docs/
```

## Request flow

1. Web calls the API with `Authorization: Bearer <access>`; refresh cookie renews it.
2. `JwtAuthGuard` validates the token and loads the membership (user × organisation × role).
3. `PermissionsGuard` checks the route's required permission keys against the role.
4. Services receive a `RequestContext { userId, organisationId, permissions, scope }`. Every
   query is built from that context; controllers never accept an organisation id from the client.
5. Mutations write an `AuditLog` row and a `LeadActivity` row where relevant, in the same transaction.
6. Domain events (`lead.created`, `lead.stage_changed`, ...) are written to an outbox table in
   the same transaction and dispatched by the worker to automations, notifications and webhooks.

## Multi-tenancy

- Every tenant-owned table carries `organisationId` with an index and foreign key.
- Layer 1: services scope every query by `ctx.organisationId`. Lookups by id always include the
  organisation (`findFirst({ id, organisationId })`), so a foreign id returns 404.
- Layer 2 (hardening phase): PostgreSQL row-level security with `app.current_org` set per
  transaction. Tracked in `KNOWN_LIMITATIONS.md` until done.
- Record scope inside a tenant: `own`, `team`, `all`, derived from the role.
- Super admin is a separate flag on the user and a separate route tree (`/admin`), never a role
  inside a workspace.

## Background processing

Worker process (same codebase, `npm run worker`) handles: outbox dispatch, automation steps and
delays, campaign fan-out, provider API calls with exponential backoff, webhook retries, reminders,
scheduled reports. Jobs carry an idempotency key; handlers record completion before acknowledging.

## Realtime

Socket gateway with rooms per organisation and per user: notifications, inbox messages, incoming
call pop-ups, Kanban updates.

## Environments

Configuration is by environment variables only, validated at boot. `.env.example` documents each
one. Docker files are provided for production; local development runs natively.
