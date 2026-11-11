# Test report

Last run: 2026-11-11

## Automated: API end-to-end (Jest + Supertest, real PostgreSQL test database)

Command: `npm test` · Result: **44 passed, 0 failed** · File: `apps/api/test/app.spec.ts`

Added in session 2: custom lead fields (5 tests: definitions, required and type validation, updates and timeline, import/export, rename and delete), saved views (1), assignment rules (1: rotation, source rule priority, import, deactivated users, paused rules, tenant isolation). The refresh-token test now also covers the 30-second retry grace window.

| Suite | Tests | Covers |
|---|---|---|
| Authentication | 8 | Validation, registration and seeding, duplicate email, missing/forged token, login, refresh rotation and replay detection, logout, password reset |
| Tenant isolation | 5 | Lists, by-id access, foreign references (stage, source, label, owner, lead, role), duplicates across tenants |
| Roles and permissions | 7 | Own scope, denied actions, hidden emails, team scope, custom roles, owner protection, deactivation |
| Leads | 10 | Create, validation, duplicates, search/filter/sort/paginate, timeline, assignment and notification, bulk actions, merge, import strategies, CSV export and formula neutralising |
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

## Not tested

- Web screens have no automated tests. Not manually exercised yet: CSV import screen, bulk actions bar, merge, follow-ups screen, team and roles screens, invitation acceptance screen, password reset screens, drag-and-drop on the board, mobile widths.
- No load, accessibility or security scanning has been run.
- `next build` (production build) has not been run.
