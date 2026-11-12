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
| GET `/leads` | `leads.view` | Query: `q, stageId, pipelineId, sourceId, ownerId (id, me, unassigned), labelId, listId, status, archived, createdFrom, createdTo, closedFrom, closedTo, cf_<key> (+ _min/_max/_from/_to), sort (column or cf_<key>), dir, page, pageSize` |
| POST `/leads` | `leads.create` | 409 with `code: DUPLICATE` unless `allowDuplicate` |
| GET/PATCH/DELETE `/leads/:id` | `leads.view` / `leads.edit` / `leads.delete` | Detail, update, permanent delete (archived only) |
| GET `/leads/:id/activities`, POST `/leads/:id/notes` | `leads.view` / `leads.edit` | Timeline and notes |
| POST `/leads/:id/merge` | `leads.edit` + `leads.delete` | Merge a duplicate into this lead |
| POST `/leads/bulk` | per action | `assign, stage, addLabel, removeLabel, addToList, removeFromList, archive, restore` |
| POST `/leads/import` | `leads.import` | Up to 2,000 rows per call |
| GET `/leads/export` | `leads.export` | CSV of the filtered list |
| GET/POST `/tasks`, PATCH/DELETE `/tasks/:id` | own tasks; `tasks.manage` for others | Follow-ups and tasks |
| GET `/dashboard?days=` | `reports.view` | Summary figures |
| GET/POST `/custom-fields`, PATCH/DELETE `/custom-fields/:id`, POST `/custom-fields/reorder` | — / `pipeline.manage` | Admin-defined lead fields |
| GET/POST `/saved-filters`, DELETE `/saved-filters/:id` | `leads.view` | Saved views of the lead list |
| GET `/assignment-rules`; POST/PATCH/DELETE `/assignment-rules[/:id]` | `leads.assign` / `settings.manage` | Round-robin rules |
| GET/POST `/lists`, PATCH/DELETE `/lists/:id`, POST `/lists/:id/leads`, POST `/lists/:id/leads/remove` | `leads.view` / `leads.edit` | Static lead lists; counts follow record scope |
| GET `/reports/summary`, `/reports/agents`, `/reports/sources`, `/reports/follow-ups` | `reports.view` | Query: `from, to (YYYY-MM-DD), unit (hour, day, week, month), ownerId, sourceId`; figures in the organisation timezone |
| GET `/reports/export?report=` | `reports.view` | CSV of `summary, agents, sources, followups` |
| GET/POST `/opportunities`, GET `/opportunities/forecast?months=`, GET/PATCH/DELETE `/opportunities/:id` | `leads.view` / `leads.edit` / `leads.delete` | Deals per lead; PATCH `status` WON/LOST/OPEN with `lostReason` |
| GET/POST `/payments`, PATCH/DELETE `/payments/:id` | `payments.view` / `payments.manage` | Query: `status (incl. OVERDUE), method, leadId, ownerId, q, from, to, sort, dir`; totals in every list response |
| GET `/webhook-events`; GET/POST `/webhook-endpoints`; PATCH/DELETE `/webhook-endpoints/:id`; POST `…/:id/rotate-secret`, `…/:id/test`; GET `…/:id/deliveries`; POST `/webhook-deliveries/:id/retry` | `settings.manage` | Outbound webhooks. Secret returned once on create/rotate |
| GET `/integrations/providers`; GET/POST `/integrations`; PATCH/DELETE `/integrations/:id`; POST `…/:id/rotate-token`; GET `…/:id/events`; POST `…/:id/events/:eventId/retry` | `settings.manage` | Website-form integrations and their event log |
| POST `/hooks/website_form/:integrationId` | public, form token | JSON or form-encoded submission; 202 with event id, or 303 to the thank-you URL for browser posts; 200 `duplicate: true` for a repeated `_id` |
| GET/POST `/api-keys`, DELETE `/api-keys/:id` | `settings.manage` | Bearer keys for the public API; key returned once |
| GET `/public/me`, POST `/public/leads` | public, `Authorization: Bearer pmc_live_…` | Lead capture: `name, phone, email, company, city, source, message, customFields, externalId, duplicateStrategy, ownerId` → `{ id, outcome }` |

## Webhook payloads

Every delivery is a JSON `POST` with headers `X-PowerMyCRM-Event`, `X-PowerMyCRM-Delivery` and
`X-PowerMyCRM-Signature: t=<unix ms>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`.
Body: `{ id, type, createdAt, organisationId, data }`. Event types: `lead.created` (`data.lead`, `data.via`),
`lead.stage_changed` (`data.lead, from, to`), `lead.assigned` (`data.lead, from, to`), `lead.archived`,
`opportunity.won`, `opportunity.lost` (`data.opportunity`), `payment.received`, `payment.refunded`
(`data.payment`), `webhook.test`. Receivers must answer 2xx within 10 seconds; failures retry with
exponential backoff for up to a day.
