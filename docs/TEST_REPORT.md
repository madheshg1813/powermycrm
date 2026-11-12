# Test report

Last run: 2026-11-12

## Automated: API end-to-end (Jest + Supertest, real PostgreSQL test database)

Command: `npm test` · Result: **51 passed, 0 failed** (about 90 s; the queue tests wait for background jobs) · File: `apps/api/test/app.spec.ts`

Added in session 3: lead lists (1), reports (1), custom-field filters and sort (1), deals and payments (1), webhooks and outbox (1: signed delivery, subscriptions, retry after a 500, pause, isolation), website forms (1: token, mapping, auto-assignment, repeat enquiry, honeypot, duplicate request id, form-encoded redirect, failed submission and retry, disable, token rotation, isolation), public API keys (1). The queue runs for real inside the test app, so these tests poll until the worker has finished.

Added in session 2: custom lead fields (5 tests: definitions, required and type validation, updates and timeline, import/export, rename and delete), saved views (1), assignment rules (1: rotation, source rule priority, import, deactivated users, paused rules, tenant isolation). The refresh-token test now also covers the 30-second retry grace window.

| Suite | Tests | Covers |
|---|---|---|
| Authentication | 8 | Validation, registration and seeding, duplicate email, missing/forged token, login, refresh rotation and replay detection, logout, password reset |
| Tenant isolation | 5 | Lists, by-id access, foreign references (stage, source, label, owner, lead, role), duplicates across tenants |
| Roles and permissions | 7 | Own scope, denied actions, hidden emails, team scope, custom roles, owner protection, deactivation |
| Leads | 10 | Create, validation, duplicates, search/filter/sort/paginate, timeline, assignment and notification, bulk actions, merge, import strategies, CSV export and formula neutralising |
| Custom fields and views | 7 | Definitions, required and type validation, updates, import/export, filter and sort by custom field, rename/delete, saved views |
| Lead lists | 1 | Create, bulk add/remove, filter, scope-aware counts, creator-only rename/delete, isolation |
| Reports | 1 | Period summary by day/hour/week/month, leaderboard, sources, follow-ups, drill-down filters, CSV, scoped reporter, isolation |
| Deals and payments | 1 | Deals, forecast buckets, won/lost, payments and totals, refund rules, permissions, isolation |
| Assignment rules | 1 | Rotation, source rule priority, import, deactivated users, paused rules, isolation |
| Webhooks and outbox | 1 | Signed delivery, subscriptions, failed attempt logging and retry, paused endpoints, isolation |
| Integrations and public API | 2 | Website-form pipeline through the queue; API-key capture, update strategy, revocation |
| Pipelines, sources, labels | 3 | Stage add/rename/reorder/delete guards, second pipeline, source and label CRUD |
| Tasks | 2 | Buckets, completion, lead timeline, agent restrictions |
| Dashboard | 1 | Every figure checked against known records |
| Audit log | 1 | Entries and actor |

## Static checks

`tsc --noEmit` passes for `apps/api` and `apps/web`.

## Manual checks in the browser (not automated)

Checked on 2026-11-11 at desktop width: register, dashboard, create lead, leads list, lead detail,
pipeline board, settings page loads, log in, add a custom field in Settings and see it on the
New lead form along with the "Auto-assign by rule" owner option.

Session 3 (2026-11-12): every new API feature was also exercised against the running dev server with
the demo workspace (lists, reports, custom-field sort, deals, payments, website-form submission processed
by the worker, public API capture, webhook endpoint creation). The new pages (Reports, Deals, Payments,
Settings → Integrations, lead page tabs) compile and render on the dev server; their interactions were
not clicked through in a browser.

## Not tested

- Web screens have no automated tests. Not manually exercised yet: CSV import screen, bulk actions bar, merge, follow-ups screen, team and roles screens, invitation acceptance screen, password reset screens, drag-and-drop on the board, mobile widths.
- No load, accessibility or security scanning has been run.
- `next build` (production build) has not been run.
