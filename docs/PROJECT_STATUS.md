# Project status

Last updated: 2026-11-12 (session 3, in progress)

## Where it stands

Phases 0, 1, 5 and 6 are built and tested, and phase 7 has its framework and two working providers.
Phases 2, 3, 4 and 11 are partly built: the core of each works end to end, and the remaining items
are listed below. Phases 8 to 10 and 12 to 18 have not been started.
PowerMyCRM is **not** at feature parity with TeleCRM and is not production-ready yet.

| Phase | Scope | Status |
|---|---|---|
| 0 | Monorepo, PostgreSQL, design system, app shell | Completed |
| 1 | Auth, organisations, users, invitations, roles, teams, audit log | Completed, including email delivery and email verification (session 3). MFA not started |
| 2 | Leads | Core completed, plus custom fields, saved views and round-robin assignment rules (session 2) static and dynamic lead lists, lead files, custom-field filters, sorting and columns (session 3). Conditional rules, Excel (.xlsx) import not started |
| 3 | Pipelines and Kanban | Core completed; deals (opportunities) with forecast completed (session 3). SLA timers, required fields per stage not started |
| 4 | Tasks and follow-ups | Core completed; calendar view, recurring tasks, reminders and push not started |
| 5 | Dashboard and reports | Dashboard and reports module completed (session 3). No custom report builder, Excel export or scheduled reports |
| 6 | Job queue and outbox | Completed: pg-boss on PostgreSQL in-process, outbox events, signed outbound webhooks with retries and a delivery log |
| 7 | Integration framework | Framework completed (Integration, IntegrationEvent, encrypted credentials, inbound worker, event log with retry). Providers: website forms and the API-key lead-capture API. Every third-party provider is awaiting credentials |
| 11 | Payments | Payment records, totals, Payments page, Razorpay payment links marked received from signed webhooks. Needs a Razorpay account |
| 8 | Calling | Call log with outcomes, duration, notes and callbacks; click-to-call through Exotel (rings the agent, then the lead; outcome, duration and recording logged from Exotel callbacks; incoming calls logged and announced). Needs an Exotel account |
| 10 | Automation | Completed: trigger + conditions + ordered steps (assign, stage, label, list, follow-up, notify, email, webhook, update field, archive, wait) with per-run logs and "run on this lead" |
| 14 | Super admin, plans | Completed without billing: platform admin area (workspaces, suspension, plan changes, health), plan catalogue with limits enforced on users, leads, automations, storage and webhooks |
| 16 | Mobile | Installable PWA (manifest, icons, offline page, service worker in production builds) on top of the responsive layouts. No native app |
| 9, 12, 13, 15, 17, 18 | WhatsApp, SMS, AI, billing provider, production deployment | Not started |

## What works today

- Register an organisation, log in, log out, reset password, rotate sessions, sign out devices, verify your email address (24-hour link, resend from the banner).
- Email delivery: each workspace connects its own SMTP account under Settings → Integrations → Email (status becomes "connected" only after a real login to the server; "send test email" proves it end to end). A platform-wide SMTP can be set in the environment as a fallback. Invitations, password resets and verification emails go through the queue and are logged with their outcome. With no connection, invitation links are still shown to the admin to share by hand.
- Invite users by link, accept invitations, roles with 14 permissions and own/team/all record scope, custom roles, teams, deactivate users.
- Leads: create, edit, search, filter (including by any custom field: text contains, number range, date range, option, yes/no), sort (built-in columns or any custom field), optional custom-field columns, paginate, bulk assign / move stage / label / archive / restore, permanent delete, duplicate detection on phone and email, merge, CSV import with column mapping and duplicate strategy, CSV export, notes, activity timeline, assignment notifications.
- Lead lists: static lists (add or remove selected leads in bulk) and dynamic lists (saved filters evaluated live, created from the Views menu on the leads page). Filter the leads list by either kind; manage lists in Settings. Counts respect the user's record scope.
- Lead files: upload PDF, images, Office documents, CSV, text and audio up to 10 MB per file on a lead (Files tab), download and delete, logged on the timeline. Stored on local disk through a storage adapter (`STORAGE_DIR`); an S3-compatible adapter is the planned production option.
- Deals: several deals per lead with value, probability, expected close and owner; won/lost/reopen with reasons; Deals page with open/won/lost totals and a six-month forecast (value and probability-weighted value by expected-close month).
- Payments: record expected or received money per lead (optionally per deal), methods, references, mark received, refund; Payments page with received/expected/overdue/refunded totals and filters. Paid money is never deleted, only refunded. New permissions `payments.view` and `payments.manage` (added to existing owner, admin, manager and agent roles by migration).
- Pipelines: multiple pipelines, custom stages with colours and order, drag-and-drop Kanban.
- Follow-ups: callbacks, meetings, demos, site visits, tasks; today / overdue / upcoming / done; reschedule, complete, delete.
- Reports: date-range summary of leads created, won, lost and won value by hour of day, day, week or month (in the organisation's timezone); agent leaderboard; lead-source report; follow-up report by agent and by type; CSV export of each; every figure links through to the filtered leads list. All figures are computed from the database at request time within the user's record scope.
- Background jobs: pg-boss queue on PostgreSQL running inside the API process (`QUEUE_DISABLED=true` turns it off), with retries and exponential backoff. Domain events (lead created, stage changed, assigned, archived; deal won/lost; payment received/refunded) are written to an outbox in the same transaction and dispatched by the worker.
- Webhooks: admins register endpoints per event type, receive HMAC-SHA256 signed JSON, see every delivery attempt with its HTTP status, retry by hand, send test events, pause and rotate secrets.
- Website forms: each form integration has an endpoint and token; submissions (JSON or form-encoded) are stored as integration events, processed by the worker into leads with field mapping, source, de-duplication strategy and rule-based assignment; honeypot and duplicate-request protection; event log with retry; optional thank-you redirect.
- Public lead-capture API: bearer API keys (shown once, hashed at rest, revocable) for `POST /api/v1/public/leads`.
- Calls: log outbound and inbound calls per lead with outcome (workspace-defined list), duration, notes and an optional callback; the Call button opens the phone app then the log dialog; call counts and talk time on the agent leaderboard.
- Automations (Settings → Automations): when a lead is created, moved, assigned or archived, a deal is won or lost, a payment is received, a follow-up is completed or a call is logged, check conditions (source, stage, owner, label, city, company, value, score, custom fields, previous stage, amount, call outcome) and run steps in order: assign (user, rule or unassign), move stage, add/remove label, add to list, create follow-up, notify a user, send email, call a webhook, update a field, archive, wait. Every run is logged step by step; one automation runs at most once per lead per ten minutes; "Run on a lead" tests it immediately.
- Plans and limits: every workspace has a plan (Free by default) with limits on users, leads, automations, file storage and webhook endpoints; exceeding one returns a clear "upgrade" message (`code: PLAN_LIMIT`). Settings → Organisation shows usage against the plan.
- Platform admin (`/admin`, for emails in `SUPER_ADMIN_EMAILS`): overview with 24-hour failure counts, every workspace with owner, plan, users, leads and last activity, search, suspend/reactivate (signs everyone out at once), change plan, and the plan catalogue (create, edit limits and prices, retire, choose the default).
- Installable on phones and desktops as a PWA (Add to Home Screen); pages always load from the network and an offline page explains when there is no connection.
- Connected services (Settings → Integrations): a provider registry where each provider declares its credentials and a connection test against the real service; status is "connected" only after that test passes. Built: Razorpay (payment links; webhook marks payments received), Exotel (click-to-call, call callbacks, incoming calls), SMTP email, website forms.
- Dashboard with live figures; global search; in-app notifications; audit log (API).
- Settings: profile, password, devices, organisation, stages, pipelines, sources, labels.

## How to run

```
npm install
npm run db:migrate        # first time only
npm run dev:api           # http://localhost:4000/api/v1
npm run dev:web           # http://localhost:3000
npm test                  # API end-to-end tests against the *_test database
```

Local configuration is in `apps/api/.env` (git-ignored); `apps/api/.env.example` lists every variable,
including `CREDENTIALS_KEY` (32 random bytes, base64) which encrypts integration secrets. A demo
workspace login is recorded in `.env.local` (git-ignored).

## Next tasks, in order

1. Done in session 3: static lead lists; reports; custom-field filters, sort and columns; deals with forecast; payments; job queue, outbox, webhooks, website forms, the public API, SMTP email delivery and email verification.
2. Remaining provider adapters: WhatsApp Cloud API inbox and templates, SMS gateway, IndiaMART pull, Justdial push, Meta lead ads. (Razorpay and Exotel are done.)
3. Conditional assignment rules; S3 storage adapter for production.
4. Won/lost reasons, forecasting, stage SLA and ageing.
5. Calendar view, recurring tasks, reminder scheduler (needs the job queue).
6. Third-party lead sources (Meta lead ads, IndiaMART, Google forms) once platform credentials are supplied; Razorpay payment links.

## Known bugs

None open. See `KNOWN_LIMITATIONS.md` for gaps.

## Technical debt

- Tenant isolation is enforced in the service layer and covered by tests; PostgreSQL row-level security is not yet enabled.
- The worker runs inside the API process. A separate `npm run worker` entry point is not yet provided; set `QUEUE_DISABLED=true` on extra API instances until it is.
- pg-boss is an ES module and is loaded through Node's native `require` (Node 22.12 or later) so the Jest suite can run it.
- No web end-to-end (browser) test suite yet. Screens were checked by hand.
- `docs/SYSTEM_ARCHITECTURE.md` mentions `packages/shared`; permission keys currently live in `apps/api/src/common/permissions.ts` and are served to the web app by the API.
- Dates are formatted in the browser's locale; the organisation's date-format setting is stored but not applied yet.

## Deployment status

Local development only. No Docker, staging or production configuration exists yet (phase 18).
