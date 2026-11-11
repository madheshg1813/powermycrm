# Development roadmap

Phases are built in dependency order. A phase is closed only when its features meet the
"Completed" definition in `PROJECT_STATUS.md`.

| Phase | Scope | Depends on |
|---|---|---|
| 0 | Monorepo, tooling, database, design system, app shell | — |
| 1 | Auth, organisations, onboarding, users, invitations, roles and permissions, departments, teams, audit log | 0 |
| 2 | Leads: CRUD, list with search/filter/sort/pagination, saved filters, bulk actions, import/export, duplicates and merge, custom fields, labels, lists, sources, notes, attachments, timeline, assignment rules | 1 |
| 3 | Pipelines and stages, Kanban, opportunities, won/lost, forecasting, SLA and ageing | 2 |
| 4 | Tasks and follow-ups, calendar, reminders, in-app notifications, web push | 2 |
| 5 | Dashboard and reporting engine, leaderboard, exports, saved and scheduled reports | 2–4 |
| 6 | Job queue, outbox, integration framework, public lead API, website forms, outbound webhooks | 2 |
| 7 | Security hardening: MFA, RLS, session and device management, rate limits | 1 |
| 8 | Calling: call logs, dispositions, dialer queue, calling campaigns, telephony adapters, recordings | 6 |
| 9 | WhatsApp Cloud API: inbox, templates, media, assignment, campaigns, opt-outs | 6 |
| 10 | SMS and email: providers, templates, campaigns, tracking | 6 |
| 11 | Automation engine and visual workflow builder, chatbot | 6, 8–10 |
| 12 | Payments: records, Razorpay links and webhooks, payment reports | 3, 6 |
| 13 | Lead-source integrations: Meta, Google, portals, Shopify, WooCommerce, Conversions API | 6 |
| 14 | Customer lifecycle: customers, renewals, referrals, retention campaigns | 3, 12 |
| 15 | AI layer: transcription, summaries, drafts, scoring suggestions, NL report queries | 8–10 |
| 16 | Super admin: organisations, plans, billing, usage limits, job monitor, announcements | 1, 6 |
| 17 | Mobile polish, PWA, native app plan (Android first for SIM calling) | all |
| 18 | Production: Docker, CI, backups, monitoring, load and security testing | all |

## External credentials needed

Nothing is needed for phases 0–7. From phase 8 on, each real provider connection needs the
credentials listed in `INTEGRATION_ARCHITECTURE.md`. Until they are supplied the related features
stay at "Integration Pending".
