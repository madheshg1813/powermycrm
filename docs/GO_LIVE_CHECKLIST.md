# Go-live checklist: what the product owner supplies

Everything below is already built and tested against stand-in servers. Each item only needs your
account or decision. Integrations are connected per workspace in **Settings → Integrations**; a
service shows "Connected" only after PowerMyCRM has signed in to it successfully.

## 1. Before anyone else uses it

| Item | Where it goes | Why |
|---|---|---|
| A server or hosting plan (Node 22+ and PostgreSQL 15+), a domain, HTTPS | Deployment | Customers and webhooks must reach the app over the internet. Today it runs only on this PC. |
| `JWT_SECRET` (32+ random characters) and `CREDENTIALS_KEY` (`openssl rand -base64 32`) for production | API environment | Sign sessions and encrypt integration secrets. Never reuse the development values. |
| `WEB_ORIGIN` and `API_PUBLIC_URL` set to the public addresses | API environment | Links in emails and webhook URLs shown to admins. |
| `SUPER_ADMIN_EMAILS` | API environment | Who can open Platform admin. |
| `COOKIE_SECURE=true` | API environment | Required behind HTTPS. |
| Platform email (SMTP host, user, password, From address) | API environment `SMTP_*`, `MAIL_FROM` | Invitations and password resets for workspaces that have not connected their own email. |
| Plan prices and limits | Platform admin → Plans | Free, Growth and Enterprise are placeholders. |
| Legal: privacy policy, terms, consent for call recording and WhatsApp/SMS marketing | Your website and onboarding | Required for recording, WhatsApp and SMS in India (DPDP Act, TRAI/DLT). |

## 2. Per-service accounts (each workspace connects its own)

| Service | What you need | How long it usually takes |
|---|---|---|
| Email (SMTP) | Gmail app password, Microsoft 365, Zoho, Amazon SES, SendGrid or Brevo SMTP details | Minutes |
| Razorpay | Key id and secret; a webhook to the URL shown, events `payment_link.paid` and `payment.failed`, with a secret | Minutes once the Razorpay account is activated (KYC) |
| Exotel | Account SID, API key and token, region, an ExoPhone; agents add their phone number in My account | Days (KYC and number allotment) |
| WhatsApp Cloud API | Meta Business verified, WhatsApp Business Account, phone number, permanent system-user token, app secret, webhook to the URL shown subscribed to `messages`, approved templates | Days to weeks (business verification, display name and template approval) |
| SMS gateway | Send URL with `{to}`, `{message}`, `{senderId}`, auth header; in India DLT entity, sender id and approved templates | Days (DLT registration) |
| Facebook / Instagram lead ads | A Meta app approved for `leads_retrieval` and `pages_manage_metadata`, Page id, long-lived Page token, app secret, Page webhook to the URL shown subscribed to `leadgen` | Days to weeks (Meta app review) |
| IndiaMART | CRM key from Lead Manager → Push/Pull API | Minutes |
| Justdial | Send the endpoint URL shown to your Justdial account manager | Days (their team configures it) |

## 3. Decisions still open

- **S3-compatible file storage** for production (AWS S3, Cloudflare R2, DigitalOcean Spaces). Files are on local disk today, which does not survive redeploys on most hosts.
- **Self-service billing**: which gateway collects subscription fees (Razorpay Subscriptions or Stripe). Until then plans are changed by a platform admin.
- **WhatsApp Web chat sync**: TeleCRM uses a browser extension. PowerMyCRM uses the official Cloud API only; an extension is a separate decision.
- **Native mobile app** (Android SIM call recording needs one). The installable web app covers everything else.
- **AI features** (call summaries, lead scoring, reply suggestions): which provider and what budget.
