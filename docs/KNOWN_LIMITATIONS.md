# Known limitations

## Missing external connections

| Area | Effect today | Needs |
|---|---|---|
| Email delivery | Works once a workspace connects an SMTP account (Settings → Integrations → Email) or the platform SMTP is set in the environment. Until then invitation links are shown to the admin, reset links are written to the API log outside production, and verification emails are recorded as "not sent". | The customer's SMTP details (Gmail app password, Microsoft 365, SES, SendGrid…) |
| Third-party lead sources, calling, WhatsApp, SMS, payment gateways | The integration framework, queue and event log are built; website forms and the API-key capture work end to end. Every provider that needs third-party credentials (Meta, IndiaMART, Justdial, Razorpay, telephony, WhatsApp Cloud API) is not connectable yet and is not shown as such. The lead page "Call" and "Email" buttons only open the device's phone or mail app and are not logged. | Platform credentials from the product owner; see `INTEGRATION_ARCHITECTURE.md` |

## Functional gaps in built modules

- Import accepts CSV only. Excel files must be saved as CSV first.
- The Kanban board loads the 200 most recently active leads per pipeline.
- Export is capped at 50,000 rows per file.
- Custom fields have no file-upload type or per-role visibility, and a field's type cannot be changed after creation. Sorting the lead list by a custom field orders the matching rows in the API process (capped at 50,000 rows) because JSON values are not indexed; built-in columns sort in the database.
- Lead lists are static only: membership changes when a user adds or removes leads. No rule-based (dynamic) lists and no lead attachments yet.
- Assignment rules are round-robin only (per source or all sources). They run when the owner is set to "Auto-assign by rule"; nothing creates leads automatically yet because integrations are not built.
- Payments are recorded by hand. Payment links, online collection and reconciliation need a gateway integration (Razorpay is designed, not connected). Reports and the dashboard still use the lead's own deal value and won/lost stage, not deals or payments.
- Reports export to CSV only (no Excel), cover at most one year per query, and have no custom report builder or scheduled delivery. "Won" and "lost" are counted on the day a lead entered its current closing stage, so a lead moved from Won back to an open stage no longer counts as won.
- Webhook deliveries retry five times with exponential backoff (about 1 min, 2 min, 4 min, 8 min, 16 min with jitter, capped at 12 h), then park as failed for manual retry. Receivers must answer within 10 seconds. Outbox events older than 30 seconds that were not dispatched are swept once a minute.
- Website form endpoints accept cross-origin browser posts from any site (they are meant to be public); abuse protection is the per-IP rate limit, the honeypot field and the token.
- Notifications are in-app only and refresh every 60 seconds (no WebSocket or push yet).
- No multi-factor authentication or password-policy settings. Verifying the email is encouraged by a banner but not enforced.
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
