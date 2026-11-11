# Feature parity matrix

Statuses: Not Started, Researching, Designed, Backend In Progress, Frontend In Progress,
Integration Pending, Testing, Completed, Blocked. "Completed" follows the definition in the
project brief. Test status: **API** = automated API test passes, **Manual** = checked by hand in
the browser, **None** = untested. Rows marked (ext) go beyond what TeleCRM documents publicly.

| Feature | TeleCRM reference | PowerMyCRM implementation | Status | Test status |
|---|---|---|---|---|
| Excel upload with field mapping | /features 1.1 | CSV import, column mapping, duplicate strategy, row errors. `.xlsx` not yet | Frontend In Progress | API; screen None |
| Facebook lead capture | /features 1.2 | — | Not Started | None |
| Custom API lead capture | /features 1.3 | — | Designed | None |
| Automatic lead distribution | /features 1.4 | Round-robin rules per source or all sources, used by "Auto-assign by rule" on create and import; skips deactivated users. No conditional rules; not yet triggered by integrations | Testing | API; rules screen None, form option Manual |
| Lead management, tracking | /features 4.1 | Lead CRUD, list, search, filters, sort, pagination, detail page | Completed | API + Manual |
| Transfer leads between users/teams | /features 4.1 | Single and bulk reassign, notification to new owner | Testing | API; screen None |
| Customisable sales pipelines | /features 4.1 | Multiple pipelines, custom stages, colours, order, Kanban | Testing | API + Manual (drag untested) |
| Bulk edit leads | /features 4.2 | Bulk assign, stage, label, archive, restore | Testing | API; screen None |
| Custom lead fields | /lead-management-system | 10 field types, required flag, order, lead form, lead page, import and export. No filter/sort by custom field, no file-upload type, no per-role visibility | Testing | API + Manual (add field, form shows it) |
| Saved views of the lead list (ext) | — | Private or shared named filter sets | Testing | API; screen None |
| Lead scoring | /lead-management-system | Manual 0–100 score, sortable. No rules | Backend In Progress | API |
| Labels | /crm-with-dialer | Colour labels, filter, bulk add/remove | Testing | API; screen None |
| Duplicate clean-up | /call-center-crm | Detection on phone/email at create and import, merge | Testing | API; screen None |
| Filtered calling lists | /crm-with-dialer | Static lists: create, add/remove selected leads in bulk, filter the lead list by list, list chips on the lead page, manage in Settings. Dynamic (rule-based) lists not built | Testing | API + Manual (API smoke test; screens checked by hand) |
| Lead history timeline | /crm-with-dialer | Timeline of creation, edits, stage, owner, notes, tasks, merge | Completed | API + Manual |
| Role-based access | /crm-with-dialer | 14 permissions, own/team/all scope, custom roles | Testing | API; screen None |
| Follow-up reminders | /features 2.7 | Tasks with due time, today/overdue/upcoming. No reminder delivery | Frontend In Progress | API; screen None |
| WhatsApp notifications to agents | /features 2.1 | — | Not Started | None |
| Push notifications | /features 2.8 | In-app notifications only | Backend In Progress | API |
| 1-click dialer, click-to-call | /features 2.2–2.3 | `tel:` link only, not logged | Not Started | None |
| Call recording | /features 2.4 | — | Not Started | None |
| IVR / telephony providers | /call-center-crm | — | Designed | None |
| 1-click WhatsApp, SMS, email | /features 2.5–2.6 | — | Not Started | None |
| WhatsApp Cloud API inbox, templates, bulk, chatbot | /whatsapp-crm | — | Designed | None |
| WhatsApp chat sync | /whatsapp-crm | — | Researching | None |
| Triggers, workflows, drip | /features 4.5 | — | Not Started | None |
| Payment creation, forecasting | /features 2.9 | Deal value and expected close on leads only | Not Started | None |
| Razorpay | /integrations | — | Designed | None |
| Portal integrations (IndiaMART, Justdial, etc.) | /integrations | — | Designed | None |
| Google Sheets, Google Meet, Shopify, WooCommerce | /integrations | — | Not Started | None |
| Hour-by-hour, daily, sales, agent reports | /features 3 | Reports page: created/won/lost/won value by hour of day, day, week or month in the organisation timezone; filters by period preset or custom dates, agent and source; drill-down to the lead list; CSV export | Testing | API + Manual |
| Leaderboard | /features 3.3 | Agent leaderboard: created, won, lost, conversion, won value, open, follow-ups completed and on time, overdue, notes; ranked by won then value. Lead-source and follow-up reports alongside | Testing | API + Manual |
| Funnel by stage | /whatsapp-crm | Dashboard pipeline chart | Completed | API + Manual |
| Custom report | /features 3.6 | — | Not Started | None |
| Mobile app | /call-center-crm | Responsive web layouts written, not verified on a phone | Frontend In Progress | None |
| Multi-tenant workspaces (ext) | — | Organisation isolation in every query | Completed | API |
| Auth, sessions, password reset (ext) | — | JWT + rotating refresh cookie, Argon2id, device list | Completed (email delivery Integration Pending) | API + Manual (register) |
| Invitations (ext) | — | Link-based, 7-day expiry | Integration Pending (email) | API; screen None |
| Audit log (ext) | — | Recorded and served by API; no screen | Backend In Progress | API |
| MFA (ext) | — | — | Not Started | None |
| Super admin, plans, billing (ext) | /pricing | — | Not Started | None |
| AI features (ext) | — | — | Not Started | None |
