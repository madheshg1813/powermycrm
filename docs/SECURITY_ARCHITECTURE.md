# Security architecture

## Authentication

- Passwords: Argon2id, minimum 10 characters, checked against a per-organisation policy.
- Access token: JWT, 15 minutes, carries user id and active organisation id.
- Refresh token: random 256-bit value, stored hashed (SHA-256) in `Session`, httpOnly + SameSite=Lax
  cookie scoped to `/api/v1/auth`, rotated on every use. Reuse of a rotated token revokes the
  whole session family.
- Sessions record device, IP and last-seen time; users can revoke them.
- Email verification and password reset use single-use, hashed, expiring tokens.
- MFA: TOTP with recovery codes (phase 7).
- Login attempts are rate limited per IP and per account, and recorded in `LoginEvent`.

## Authorisation

- Permission keys (`leads.view`, `leads.export`, ...) live in `packages/shared`. Roles are sets of
  keys plus a record scope (`own` / `team` / `all`). System roles are seeded per organisation and
  custom roles can be created.
- Enforced on the server by `PermissionsGuard` and by scope filters in services. The web app hides
  what a user cannot do, but that is presentation only.
- Field-level rules: custom fields carry per-role visibility and editability, applied when
  serialising and when validating writes.

## Tenant isolation

See `SYSTEM_ARCHITECTURE.md`. Automated tests create two organisations and assert that every
read and write endpoint returns 404 or 403 for the other tenant's ids.

## Input and output

- All request bodies validated by DTO schemas with unknown properties rejected.
- Prisma parameterises all SQL. Raw SQL is limited to reporting and uses tagged templates.
- React escapes output. User HTML (email bodies) is sanitised before rendering.
- CSRF: state-changing requests need the bearer token, which is not sent automatically by the
  browser. The refresh endpoint additionally checks `Origin`.
- Security headers via Helmet. CORS limited to configured web origins.
- Global and per-route rate limits.

## Files

Uploads are validated for size and type, stored under a tenant prefix with random keys, and served
through short-lived signed URLs after a permission check. Call recordings need `calls.recordings.view`.

## Secrets

Integration credentials are encrypted with AES-256-GCM using `CREDENTIALS_KEY`. They are never
returned by the API after saving, only a masked hint. Nothing secret is committed; `.env` is ignored.

## Webhooks

Inbound: provider signature verification (Meta `X-Hub-Signature-256`, Razorpay
`X-Razorpay-Signature`, and so on), event-id deduplication, raw body stored for replay.
Outbound: HMAC-signed with a per-endpoint secret, retried with backoff.

## Audit

`AuditLog` records actor, organisation, action, entity, before/after diff, IP. Lead-level history
is additionally kept in `LeadActivity`.

## Communications compliance

- WhatsApp: official Cloud API only, approved templates outside the 24-hour window, opt-out
  keyword handling, per-contact consent flag.
- SMS: DLT entity and template ids required per template (TRAI).
- Calls: recording disclosure setting per organisation; recording retention period configurable.
- Personal data: export and delete per lead, retention settings, aligned with the DPDP Act 2023.
- No unofficial automation of WhatsApp or scraping of third-party services.
