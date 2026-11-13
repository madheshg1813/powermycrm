# Integration architecture

## Adapter contract

Each provider is one adapter class in `apps/api/src/modules/integrations/providers/<key>/` that
implements the parts of this contract it supports. Nothing outside the adapter knows provider
specifics.

```ts
interface IntegrationAdapter {
  readonly key: string;                 // "razorpay", "meta_lead_ads", ...
  readonly category: 'lead_source' | 'telephony' | 'messaging' | 'payments' | 'productivity' | 'ecommerce';
  readonly auth: 'api_key' | 'oauth2' | 'webhook_only';
  readonly capabilities: Capability[];  // declared, so the UI can show "not supported by provider"
  credentialSchema: FieldSpec[];        // drives the connection form
  testConnection(creds): Promise<TestResult>;
  handleWebhook?(req: RawWebhook): Promise<NormalisedEvent[]>;
  verifyWebhook?(req: RawWebhook, creds): boolean;
  pull?(cursor, creds): Promise<{ events: NormalisedEvent[]; cursor: string }>;
  push?(action: OutboundAction, creds): Promise<ProviderResult>;
}
```

Telephony, messaging and payment adapters extend this with typed methods
(`startCall`, `sendMessage`, `createPaymentLink`).

## Data model

`Integration` (organisation × provider, status, encrypted credentials, settings, field mapping),
`IntegrationEvent` (direction, external id, payload, status, attempts, error), `WebhookEndpoint`,
`WebhookDelivery`.

Connection status values: `not_connected`, `awaiting_credentials`, `connected`, `error`,
`disabled`. Status becomes `connected` only after `testConnection` succeeds against the real
provider. There is no code path that sets it otherwise.

## Processing

1. Inbound webhook hits `/api/v1/hooks/:provider/:integrationId`, the raw body is stored, the
   signature verified and a job enqueued. The HTTP response is immediate.
2. The worker normalises events, deduplicates on `(integrationId, externalId)`, applies field
   mapping and calls domain services (create lead, log call, update payment).
3. Failures are retried with exponential backoff (pg-boss: about 1m, 2m, 4m, 8m, 16m with jitter,
   capped at 12h), then parked as failed and shown in the integration's event log with a manual retry.
   Validation failures (a submission with no name, phone or email) are parked at once without retrying.
4. Outbound calls go through a per-provider rate limiter and honour `Retry-After`.

## Providers and what each needs

| Provider | Auth | Needs from the customer | Status |
|---|---|---|---|
| Website forms / custom API / webhooks | Form token / API key / endpoint secret | Nothing external | **Built** (session 3): `website_form` provider, `POST /public/leads`, outbound webhooks |
| Meta lead ads, Instagram | Page token + app secret | Meta app (reviewed for `leads_retrieval`, `pages_manage_metadata`), Page id, Page token | **Built** (webhook + lead fetch); awaiting the Meta app |
| Meta Conversions API | Token | Pixel id, access token | Awaiting credentials |
| WhatsApp Cloud API | Token | WABA id, phone number id, permanent token, app secret, verify token | **Built** (inbox, templates, webhooks, receipts); awaiting the customer's WABA |
| Google Sheets, Google Ads lead forms | OAuth / webhook key | Google Cloud OAuth client | Awaiting platform credentials |
| IndiaMART | API key | CRM key (pull API) | **Built** (pull every 5 minutes); awaiting the customer's key |
| Justdial | Push URL with token | Justdial account manager configures it | **Built** |
| Sulekha, TradeIndia, 99acres, MagicBricks, Housing, Shiksha | Push webhook or email parse | Portal-side configuration by each customer | Awaiting credentials (the website-form endpoint accepts any portal that can post a form) |
| Exotel | API key + token, ExoPhone | Account SID, API key/token, region, ExoPhone | **Built** (click-to-call, status callbacks, incoming calls); awaiting the customer's account |
| Knowlarity, MyOperator, MCube, CallerDesk, TeleCMI, Maqsam | API key + webhooks | Account, virtual number | Awaiting credentials |
| Razorpay | Key + webhook secret | Key id, secret, webhook secret | **Built** (payment links, paid webhook); awaiting the customer's keys |
| SMS gateway (any HTTP API) | URL template + auth header | Send URL, sender id, DLT templates | **Built** (outbound, test SMS on connect); awaiting the customer's gateway |
| Email | SMTP / OAuth | SMTP credentials or Google/Microsoft OAuth | Awaiting credentials |
| Shopify, WooCommerce | OAuth / keys | Store credentials | Awaiting credentials |

Capabilities a provider does not offer (for example live call monitoring) are declared as
unsupported in the adapter and shown as such in the UI.

## WhatsApp chat sync

TeleCRM's chat sync is a Chrome extension on WhatsApp Web. The supported route for PowerMyCRM is
the WhatsApp Business app **coexistence** feature of the Cloud API, which lets a number stay on the
Business app while messages also flow through the API. A browser extension that reads the user's
own WhatsApp Web session is a separate, later decision for the product owner because it is not an
official Meta integration. PowerMyCRM will not scrape or reverse-engineer WhatsApp.
