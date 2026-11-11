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
3. Failures are retried with exponential backoff (1m, 5m, 30m, 2h, 12h), then parked as failed and
   shown in the integration's event log with a manual retry.
4. Outbound calls go through a per-provider rate limiter and honour `Retry-After`.

## Providers and what each needs

| Provider | Auth | Needs from the customer | Status |
|---|---|---|---|
| Website forms / custom API / webhooks | API key | Nothing external | Built in-house |
| Meta lead ads, Instagram | OAuth | Meta app (reviewed for `leads_retrieval`, `pages_manage_metadata`) | Awaiting platform credentials |
| Meta Conversions API | Token | Pixel id, access token | Awaiting credentials |
| WhatsApp Cloud API | Token | WABA id, phone number id, permanent token, app secret | Awaiting credentials |
| Google Sheets, Google Ads lead forms | OAuth / webhook key | Google Cloud OAuth client | Awaiting platform credentials |
| IndiaMART | API key | CRM key (pull API) | Awaiting credentials |
| Justdial, Sulekha, TradeIndia, 99acres, MagicBricks, Housing, Shiksha | Push webhook or email parse | Portal-side configuration by each customer | Awaiting credentials |
| Knowlarity, Exotel, MyOperator, MCube, CallerDesk, TeleCMI, Maqsam | API key + webhooks | Account, virtual number | Awaiting credentials |
| Razorpay | Key + webhook secret | Key id, secret, webhook secret | Awaiting credentials |
| SMS gateway | API key | DLT entity id, sender id, templates | Awaiting credentials |
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
