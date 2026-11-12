# Feature parity matrix

Statuses: Not Started, Researching, Designed, Backend In Progress, Frontend In Progress,
Integration Pending, Testing, Completed, Blocked. "Completed" follows the definition in the
project brief. Test status: **API** = automated API test passes, **Manual** = checked by hand in
the browser, **None** = untested. Rows marked (ext) go beyond what TeleCRM documents publicly.

| Feature | TeleCRM reference | PowerMyCRM implementation | Status | Test status |
|---|---|---|---|---|
| Excel upload with field mapping | /features 1.1 | CSV import, column mapping, duplicate strategy, row errors. `.xlsx` not yet | Frontend In Progress | API; screen None |
| Website forms (ext) | — | Form endpoint per integration with token, field mapping, source, duplicate strategy, auto-assignment, honeypot, thank-you redirect, event log with retry | Testing | API + Manual |
| Outbound webhooks (ext) | — | Signed JSON per event type, retries with backoff, delivery log, test events, secret rotation | Testing | API + Manual |
| Facebook lead capture | /features 1.2 | Framework ready; needs a reviewed Meta app | Blocked | None |
| Custom API lead capture | /features 1.3 | Bearer API keys (Settings → Integrations), `POST /public/leads` with de-duplication strategy and rule-based assignment | Testing | API + Manual |
| Automatic lead distribution | /features 1.4 | Round-robin rules per source or all sources, used by "Auto-assign by rule" on create, import, website forms and the public API; skips deactivated users. No conditional rules | Testing | API; rules screen Manual |
| Lead management, tracking | /features 4.1 | Lead CRUD, list, search, filters, sort, pagination, detail page | Completed | API + Manual |
| Transfer leads between users/teams | /features 4.1 | Single and bulk reassign, notification to new owner | Testing | API; screen None |
| Customisable sales pipelines | /features 4.1 | Multiple pipelines, custom stages, colours, order, Kanban | Testing | API + Manual (drag untested) |
| Bulk edit leads | /features 4.2 | Bulk assign, stage, label, archive, restore | Testing | API; screen None |
| Custom lead fields | /lead-management-system | 10 field types, required flag, order, lead form, lead page, import and export, filter and sort the lead list by any field, optional list columns (remembered per browser). No file-upload type, no per-role visibility | Testing | API + Manual |
| Saved views of the lead list (ext) | — | Private or shared named filter sets | Testing | API; screen None |
| Lead scoring | /lead-management-system | Manual 0–100 score, sortable. No rules | Backend In Progress | API |
| Labels | /crm-with-dialer | Colour labels, filter, bulk add/remove | Testing | API; screen None |
| Duplicate clean-up | /call-center-crm | Detection on phone/email at create and import, merge | Testing | API; screen None |
| Filtered calling lists | /crm-with-dialer | Static lists (bulk add/remove) and dynamic lists (saved filters evaluated live); filter the lead list by list, list chips on the lead page, manage in Settings | Testing | API + Manual |
| Lead files (ext) | — | Upload, download, delete files on a lead; allow-listed types, 10 MB each, 50 per lead; local-disk storage adapter | Testing | API + Manual |
| Lead history timeline | /crm-with-dialer | Timeline of creation, edits, stage, owner, notes, tasks, merge | Completed | API + Manual |
| Role-based access | /crm-with-dialer | 14 permissions, own/team/all scope, custom roles | Testing | API; screen None |
| Follow-up reminders | /features 2.7 | Tasks with due time, today/overdue/upcoming. No reminder delivery | Frontend In Progress | API; screen None |
| WhatsApp notifications to agents | /features 2.1 | — | Not Started | None |
| Push notifications | /features 2.8 | In-app notifications only | Backend In Progress | API |
| 1-click dialer, click-to-call | /features 2.2–2.3 | `tel:` link opens the phone app; the call is logged with outcome, duration, notes and callback. No in-app dialling without a telephony provider | Testing | API + Manual |
| Call log and dispositions (ext) | /crm-with-dialer | Manual call log per lead and per agent, workspace-defined outcomes, talk time on the leaderboard | Testing | API + Manual |
| Call recording | /features 2.4 | — | Not Started | None |
| IVR / telephony providers | /call-center-crm | — | Designed | None |
| 1-click WhatsApp, SMS, email | /features 2.5–2.6 | — | Not Started | None |
| WhatsApp Cloud API inbox, templates, bulk, chatbot | /whatsapp-crm | — | Designed | None |
| WhatsApp chat sync | /whatsapp-crm | — | Researching | None |
| Triggers, workflows, drip | /features 4.5 | Automations: 9 triggers, conditions, 12 step types including wait (drip), per-run logs, manual test run | Testing | API + Manual |
| Payment creation, forecasting | /features 2.9 | Deals per lead (value, probability, expected close, won/lost) with a forecast by expected-close month; manual payment records with received/expected/overdue totals. Payment links need a gateway (Razorpay, not connected) | Testing | API + Manual |
| Razorpay | /integrations | — | Designed | None |
| Portal integrations (IndiaMART, Justdial, etc.) | /integrations | — | Designed | None |
| Google Sheets, Google Meet, Shopify, WooCommerce | /integrations | — | Not Started | None |
| Hour-by-hour, daily, sales, agent reports | /features 3 | Reports page: created/won/lost/won value by hour of day, day, week or month in the organisation timezone; filters by period preset or custom dates, agent and source; drill-down to the lead list; CSV export | Testing | API + Manual |
| Leaderboard | /features 3.3 | Agent leaderboard: created, won, lost, conversion, won value, open, follow-ups completed and on time, overdue, notes; ranked by won then value. Lead-source and follow-up reports alongside | Testing | API + Manual |
| Funnel by stage | /whatsapp-crm | Dashboard pipeline chart | Completed | API + Manual |
| Custom report | /features 3.6 | — | Not Started | None |
| Mobile app | /call-center-crm | Responsive web layouts written, not verified on a phone | Frontend In Progress | None |
| Multi-tenant workspaces (ext) | — | Organisation isolation in every query | Completed | API |
| Auth, sessions, password reset (ext) | — | JWT + rotating refresh cookie, Argon2id, device list, password reset and email verification by email | Completed | API + Manual (register) |
| Invitations (ext) | — | Emailed through the workspace SMTP connection (link shown to the admin as a fallback), 7-day expiry | Testing | API (real SMTP server in tests); screen Manual |
| Email (SMTP) connection (ext) | — | Per-workspace SMTP credentials, connection test, test email, send log | Testing | API + Manual |
| Audit log (ext) | — | Recorded and served by API; no screen | Backend In Progress | API |
| MFA (ext) | — | — | Not Started | None |
| Super admin, plans, billing (ext) | /pricing | — | Not Started | None |
| AI features (ext) | — | — | Not Started | None |
