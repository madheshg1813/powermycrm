# Known limitations

## Missing external connections

| Area | Effect today | Needs |
|---|---|---|
| Email delivery | Invitation links are shown to the admin to share. Password-reset links are written to the API server log outside production. Email verification is not sent. | SMTP or transactional email provider credentials |
| Calling, WhatsApp, SMS, payments, lead-source integrations | Not built. The lead page "Call" and "Email" buttons only open the device's phone or mail app and are not logged. | See `INTEGRATION_ARCHITECTURE.md` |

## Functional gaps in built modules

- Import accepts CSV only. Excel files must be saved as CSV first.
- The Kanban board loads the 200 most recently active leads per pipeline.
- Export is capped at 50,000 rows per file.
- Custom fields cannot yet be used as filters, sort keys or list columns, and have no file-upload type or per-role visibility. A field's type cannot be changed after creation.
- Lead lists are static only: membership changes when a user adds or removes leads. No rule-based (dynamic) lists and no lead attachments yet.
- Assignment rules are round-robin only (per source or all sources). They run when the owner is set to "Auto-assign by rule"; nothing creates leads automatically yet because integrations are not built.
- Notifications are in-app only and refresh every 60 seconds (no WebSocket or push yet).
- No multi-factor authentication, email verification or password-policy settings.
- The audit log has an API endpoint but no screen.
- The organisation's date-format and timezone settings are stored but not yet applied to displayed dates.
- No super-admin panel, subscriptions or usage limits.

## Security hardening still to do

- PostgreSQL row-level security as a second layer of tenant isolation.
- Rate limits are in memory and per process; they need a shared store before running more than one API instance.
- No account lockout after repeated failed logins beyond the per-IP rate limit.

## TeleCRM features that will differ by design

- WhatsApp chat sync: TeleCRM uses a Chrome extension on WhatsApp Web. PowerMyCRM will use the official Cloud API and its coexistence feature unless the product owner decides otherwise.
- SIM-based call recording needs a native Android app and is subject to Android's restrictions on call recording.
