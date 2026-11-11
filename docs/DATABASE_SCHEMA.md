# Database schema

The source of truth is `apps/api/prisma/schema.prisma`; migrations are in `apps/api/prisma/migrations`.
This document explains the shape and lists what later phases add.

## Built (migration `init`)

| Table | Purpose | Tenant key |
|---|---|---|
| Organisation | Tenant: name, slug, timezone, currency, date format, status | — |
| User | Global identity: email, Argon2id hash, name | — |
| Membership | User in an organisation, with role, team and status | organisationId |
| Role | Permission keys and record scope (OWN / TEAM / ALL); four seeded per organisation | organisationId |
| Team | Group of members used for team scope | organisationId |
| Invitation | Hashed, expiring invite token | organisationId |
| Session | Hashed refresh token, previous hash for replay detection, device, expiry | organisationId |
| LoginEvent, AuthToken | Login history; password-reset and verification tokens (hashed) | — |
| AuditLog | Actor, action, entity, metadata, IP | organisationId |
| Pipeline, Stage | Sales processes and ordered stages (OPEN / WON / LOST) | organisationId |
| LeadSource, Label, LeadLabel | Vocabularies and lead-label links | organisationId |
| Lead | Contact fields, normalised phone, owner, stage, score, deal value, soft-delete (`archivedAt`) | organisationId |
| LeadActivity | Timeline: created, note, stage_changed, assigned, updated, task_*, merged, archived | organisationId |
| Task | Follow-ups and tasks with type, due time, priority, status, assignee | organisationId |
| Notification | In-app notifications per user | organisationId |

Rules: every tenant table has an indexed `organisationId` with a cascading foreign key; lookups by
id always include it. Names are unique per organisation. Secrets are stored only as hashes.

## Planned

CustomField, SavedFilter, LeadList (+ members), LeadAttachment, AssignmentRule, Opportunity,
Payment, Call, CallRecording, CallDisposition, Conversation, Message, MessageTemplate, Campaign,
CampaignRecipient, Automation (+ versions, executions, steps), Integration, IntegrationEvent,
WebhookEndpoint, WebhookDelivery, OutboxEvent, ApiKey, Plan, Subscription, UsageRecord, Report,
Customer, Department.
