# API specification (v1, as built)

Base path `/api/v1`. JSON in and out. Send `Authorization: Bearer <accessToken>`. Errors are
`{ statusCode, message, errors?: [{ path, message }] }`. Lists return `{ items, total, page, pageSize }`.
The organisation is always taken from the token, never from the request.

| Method and path | Permission | Purpose |
|---|---|---|
| GET `/health` | public | Liveness and database check |
| POST `/auth/register`, `/auth/login` | public | Returns `{ accessToken }`, sets refresh cookie |
| POST `/auth/refresh`, `/auth/logout` | cookie | Rotate or end the session |
| POST `/auth/forgot-password`, `/auth/reset-password` | public | Password reset |
| GET `/auth/invitations/:token`, POST `…/accept` | public | Invitation details and acceptance |
| GET `/auth/me`, POST `/auth/profile`, `/auth/switch`, `/auth/change-password` | signed in | Profile and workspace switching |
| GET `/auth/sessions`, DELETE `/auth/sessions/:id` | signed in | Devices |
| GET, PATCH `/organisation` | — / `settings.manage` | Organisation settings |
| GET `/users`, PATCH `/users/:membershipId` | — / `users.manage` | Members, role, team, status |
| GET, POST `/invitations`, DELETE `/invitations/:id` | `users.manage` | Invitations |
| GET `/permissions`, GET `/roles`, POST/PATCH/DELETE `/roles[/:id]` | — / `roles.manage` | Roles |
| GET `/teams`, POST `/teams`, DELETE `/teams/:id` | — / `users.manage` | Teams |
| GET `/notifications`, POST `/notifications/read` | signed in | In-app notifications |
| GET `/audit-log` | `settings.manage` | Audit trail |
| GET `/pipelines`; POST/PATCH/DELETE `/pipelines[/:id]` | — / `pipeline.manage` | Pipelines |
| POST `/pipelines/:id/stages`, `/pipelines/:id/stages/reorder`; PATCH/DELETE `/stages/:id` | `pipeline.manage` | Stages |
| GET/POST `/sources`, `/labels`; PATCH/DELETE `…/:id` | — / `pipeline.manage` | Sources and labels |
| GET `/leads` | `leads.view` | Query: `q, stageId, pipelineId, sourceId, ownerId (id, me, unassigned), labelId, status, archived, createdFrom, createdTo, sort, dir, page, pageSize` |
| POST `/leads` | `leads.create` | 409 with `code: DUPLICATE` unless `allowDuplicate` |
| GET/PATCH/DELETE `/leads/:id` | `leads.view` / `leads.edit` / `leads.delete` | Detail, update, permanent delete (archived only) |
| GET `/leads/:id/activities`, POST `/leads/:id/notes` | `leads.view` / `leads.edit` | Timeline and notes |
| POST `/leads/:id/merge` | `leads.edit` + `leads.delete` | Merge a duplicate into this lead |
| POST `/leads/bulk` | per action | `assign, stage, addLabel, removeLabel, archive, restore` |
| POST `/leads/import` | `leads.import` | Up to 2,000 rows per call |
| GET `/leads/export` | `leads.export` | CSV of the filtered list |
| GET/POST `/tasks`, PATCH/DELETE `/tasks/:id` | own tasks; `tasks.manage` for others | Follow-ups and tasks |
| GET `/dashboard?days=` | `reports.view` | Summary figures |
