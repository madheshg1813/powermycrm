# Project status

Last updated: 2026-11-11 (end of session 2)

## Where it stands

Phases 0 and 1 are built and tested. Phases 2, 3 and 4 are partly built: the core of each works
end to end, and the remaining items are listed below. Phases 5 to 18 have not been started.
PowerMyCRM is **not** at feature parity with TeleCRM and is not production-ready yet.

| Phase | Scope | Status |
|---|---|---|
| 0 | Monorepo, PostgreSQL, design system, app shell | Completed |
| 1 | Auth, organisations, users, invitations, roles, teams, audit log | Completed, except email delivery, MFA and email verification |
| 2 | Leads | Core completed, plus custom fields, saved views and round-robin assignment rules (session 2). Static/dynamic lists, attachments, filtering by custom field, conditional rules, Excel (.xlsx) import not started |
| 3 | Pipelines and Kanban | Core completed; opportunities, forecasting, SLA timers, required fields per stage not started |
| 4 | Tasks and follow-ups | Core completed; calendar view, recurring tasks, reminders and push not started |
| 5 | Dashboard and reports | Dashboard completed; reports module not started |
| 6–18 | Queue, integrations, calling, WhatsApp, SMS/email, automation, payments, AI, super admin, mobile app, production deployment | Not started |

## What works today

- Register an organisation, log in, log out, reset password, rotate sessions, sign out devices.
- Invite users by link, accept invitations, roles with 14 permissions and own/team/all record scope, custom roles, teams, deactivate users.
- Leads: create, edit, search, filter, sort, paginate, bulk assign / move stage / label / archive / restore, permanent delete, duplicate detection on phone and email, merge, CSV import with column mapping and duplicate strategy, CSV export, notes, activity timeline, assignment notifications.
- Pipelines: multiple pipelines, custom stages with colours and order, drag-and-drop Kanban.
- Follow-ups: callbacks, meetings, demos, site visits, tasks; today / overdue / upcoming / done; reschedule, complete, delete.
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

Local configuration is in `apps/api/.env` (git-ignored). A demo workspace login is recorded in
`.env.local` (git-ignored).

## Next tasks, in order

1. Done in session 2: custom lead fields (10 types, required, reorder, import/export), saved views (private or shared), round-robin assignment rules (per source or all sources).
2. Filter and sort by custom field; show custom fields as optional list columns.
3. Lead lists (static and dynamic), conditional assignment rules, lead attachments (needs `StorageService`).
4. Opportunities, won/lost reasons, forecasting, stage SLA and ageing.
5. Calendar view, recurring tasks, reminder scheduler (needs the job queue, phase 6).
6. Reports module and leaderboard, with CSV/Excel export.
7. Job queue, outbox, integration framework, public lead-capture API and website forms.
8. Email provider so invitations, password resets and verification are actually sent.

## Known bugs

None open. See `KNOWN_LIMITATIONS.md` for gaps.

## Technical debt

- Tenant isolation is enforced in the service layer and covered by tests; PostgreSQL row-level security is not yet enabled.
- No web end-to-end (browser) test suite yet. Screens were checked by hand.
- No git repository has been initialised and nothing is committed.
- `docs/SYSTEM_ARCHITECTURE.md` mentions `packages/shared`; permission keys currently live in `apps/api/src/common/permissions.ts` and are served to the web app by the API.
- Dates are formatted in the browser's locale; the organisation's date-format setting is stored but not applied yet.

## Deployment status

Local development only. No Docker, staging or production configuration exists yet (phase 18).
