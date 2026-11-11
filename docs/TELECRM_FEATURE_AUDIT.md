# TeleCRM public feature audit

Researched 2026-11-11 from the publicly accessible pages below. Only what those pages state is
recorded as "documented"; anything PowerMyCRM adds beyond that is listed in
`FEATURE_PARITY_MATRIX.md` as an extension, not as TeleCRM parity.

Sources: `telecrm.in/features`, `/integrations`, `/whatsapp-crm`, `/call-center-crm`, `/pricing`,
`/lead-management-system`, `/crm-with-dialer`.

Not yet audited (linked from the features page, to be read before the related phase starts):
`/facebook-crm`, `/call-recording-crm-software`, `/auto-followup-call-reminder-crm-app`,
`/sales-management-software`, `/lead-management-crm-software`. The integrations page has a
"Show more" control, so its list may be incomplete.

## 1. Lead capture and import

| Feature | What is documented |
|---|---|
| Excel upload | Any column format, field-mapping UI, no row limit. Multiple uploads can be kept as separate calling lists. |
| Facebook lead ads | Real-time capture, source tagging. |
| Custom API | Push leads from any source, push lead activity (e.g. website visits), update leads from external events. |
| Google Sheets | Sync lead data, bulk field updates. |
| Portals | IndiaMART, Justdial, Sulekha, TradeIndia, 99acres, MagicBricks, Housing.com, Shiksha. |
| Website | WordPress forms, any website form via API, WhatsApp chat widget. |
| E-commerce | Shopify and WooCommerce orders as follow-up records. |
| Payments as a source | Razorpay events create/update leads. |
| WhatsApp | One-click "add chat as lead" from the chat-sync extension. |
| Volume claim | "15+" (pricing) / "20+" (lead management FAQ) capture platforms. |

## 2. Lead management

- Central lead store with full interaction history timeline (calls, recordings, WhatsApp, SMS, email).
- Custom lead fields (examples given: assignee name, expected closure, lead type, onboarding date).
- Custom statuses and customisable sales pipelines per business.
- Lead scoring / rating after first call, lead qualification, conversion tracking.
- Labels and scores used for segmentation.
- Bulk edit of many leads at once.
- Transfer leads between departments and teams.
- Duplicate and irrelevant lead clean-up (mentioned, mechanics not described).
- Filtered calling lists by lead condition and by source; campaign categories Cold / Hot / Fresh.
- Automatic lead distribution: rules by lead source, lead quality, demographics, "predefined logic"; assigned rep is alerted.
- Role-based control over who can view, edit or act on leads and which reports and filters each role sees.

## 3. Calling

- 1-click dialer that picks the next lead to call.
- Click-to-call from web that rings the agent's phone.
- Auto/power dialer (named, mechanics not described).
- Automatic recording of every inbound and outbound call, playable from anywhere. Stated limitation: calls made from personal SIMs are not recorded.
- Incoming call logging, call status, talk time, callback reminders.
- Automatic call distribution and IVR via providers: Knowlarity, MCube, CallerDesk, Maqsam.
- Call scheduling.

## 4. WhatsApp

Two distinct products are documented:

1. **Chat Sync (Chrome extension on WhatsApp Web)**, a paid add-on. Syncs the team's chats into the CRM, adds a chat as a lead in one click, sets lead status, shows call and follow-up history inside WhatsApp Web, click-to-call, creates follow-ups, team inbox with filters and keyword filtering.
2. **Official WhatsApp Cloud API** (one-time setup fee, Meta messaging fees apply). Automated messages with buttons, reply capture, chatbots that qualify leads, forms that collect lead details, catalogues and online payments, drip campaigns, bulk broadcasts, instant welcome messages, out-of-hours automation.

Also: 1-click WhatsApp after a call without saving the number, saved templates, WhatsApp notifications to agents (new lead, follow-up reminder, pending/failed payment).

## 5. SMS and email

- Saved templates, 1-click personalised SMS or email, no need to save the number.
- Email and SMS interactions kept in the lead history.

## 6. Follow-ups

- One-click callback scheduling, due notifications, WhatsApp reminders to the agent.
- Scheduled / completed / missed follow-up tracking per agent.
- Automatic renewal reminders.
- Push notifications, configurable per user, deep-linking to the lead.

## 7. Automation

- Triggers and workflows: auto-enrich lead fields, transfer leads between teams on conditions, trigger events and WhatsApp messages, drip marketing, multiple event reminders.
- Workflow builder to build and deploy automated workflows.
- Chatbot builder.
- Usage limit: 10,000 automation runs per month included, extra runs billed.

## 8. Payments and sales

- Create opportunities with pending payments, revenue forecast, completed payments counted as actual sales.
- Razorpay integration showing live payment status on the lead.

## 9. Reports

| Report | Documented content |
|---|---|
| Hour-by-hour | Response rate, conversions and missed leads by hour, per caller. |
| Daily | Calls per agent, total sales, total call time. |
| Leaderboard | Real-time sales, calls and time, any period. |
| Sales | Hourly, daily, monthly; summary; drill-down to deals. |
| Agents | Calls and WhatsApp chats initiated; scheduled, completed, missed follow-ups; full pipeline per agent. |
| Team activity | Sales, call volume, call duration, first and last call time. |
| Funnel | Leads by stage or status. |
| Custom | Built on request by TeleCRM staff (not self-serve). |
| Other | Conversion, calls made, sales volume, leads lost by source; call analytics incl. peak call times. |

## 10. Mobile, roles, support

- Mobile app: lead handling, agent tracking, task assignment, lead distribution, role-based access, reports.
- Roles named: sales rep / caller, manager, admin. No detailed permission model is published.
- Support (Zoom onboarding, WhatsApp group, chat 9–5) is a service, not a product feature.

## 11. Commercial model

- One plan ("Core CRM"): ₹1099 per user per month quarterly, ₹799 annually.
- Add-ons: Chat Sync ₹200 per user per month, WhatsApp API setup ₹1999 once, consultation ₹999 per hour.
- Unlimited contacts on the plan.

## 12. Features that depend on external providers

| Capability | Provider needed |
|---|---|
| Cloud calling, IVR, server-side recording | Knowlarity, MCube, CallerDesk, Maqsam (TeleCRM documents these four; Exotel, MyOperator, TeleCMI are PowerMyCRM extensions) |
| SIM-based calling and recording | Native Android app with call-log and recording access |
| WhatsApp API messaging, templates, chatbot | Meta WhatsApp Business Cloud API + approved business account |
| WhatsApp chat sync | Browser extension operating on the user's own WhatsApp Web session |
| SMS | DLT-registered Indian SMS gateway |
| Email | SMTP / transactional email provider |
| Facebook lead ads, Conversions API | Meta app with `leads_retrieval`, page subscription |
| Portals | Each portal's push/pull API or email parsing, per customer account |
| Payments | Razorpay keys and webhook secret |
| Push notifications | Web Push (VAPID), FCM/APNs for native |

## 13. Publicly documented limitations

- Personal-SIM calls are not recorded.
- Custom reports are produced by TeleCRM staff on request.
- Automations above 10,000 per month cost extra.
- Chat sync requires Chrome and WhatsApp Web.
- Dialer modes, recording retention, disposition codes and the permission model are not described publicly, so PowerMyCRM designs these itself.
