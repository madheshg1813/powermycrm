import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { ProviderDef, providerError, providerFetch } from './index';

export const graphBase = () => (process.env.META_GRAPH_BASE ?? 'https://graph.facebook.com').replace(/\/$/, '');
const V = 'v21.0';

export const whatsappCredentials = z.object({
  phoneNumberId: z.string().trim().min(1, 'Enter the phone number id'),
  wabaId: z.string().trim().min(1, 'Enter the WhatsApp Business Account id'),
  accessToken: z.string().trim().min(1, 'Enter the permanent access token'),
  appSecret: z.string().trim().min(1, 'Enter the app secret'),
  verifyToken: z.string().trim().min(8, 'Choose a verify token of at least 8 characters'),
  autoCreateLeads: z.coerce.boolean().default(true),
});
export type WhatsappCreds = z.infer<typeof whatsappCredentials>;

export const whatsapp: ProviderDef = {
  key: 'whatsapp',
  name: 'WhatsApp Cloud API',
  category: 'messaging',
  auth: 'credentials',
  description: 'Two-way WhatsApp from the CRM: an inbox per lead, approved templates for first contact, free-form replies within the 24-hour window, delivery and read receipts.',
  needs: 'A Meta Business with a WhatsApp Business Account (WABA) on the Cloud API: phone number id, WABA id, a permanent system-user access token with whatsapp_business_messaging and whatsapp_business_management, the app secret, and the webhook configured in the Meta app to the URL shown after connecting (subscribe to "messages").',
  credentialSchema: [
    { key: 'phoneNumberId', label: 'Phone number id', type: 'text' },
    { key: 'wabaId', label: 'WhatsApp Business Account id', type: 'text' },
    { key: 'accessToken', label: 'Permanent access token', type: 'password' },
    { key: 'appSecret', label: 'App secret', type: 'password', help: 'Used to verify webhook signatures' },
    { key: 'verifyToken', label: 'Webhook verify token', type: 'text', help: 'Any phrase; paste the same one into the Meta webhook settings' },
    { key: 'autoCreateLeads', label: 'Create a lead for messages from unknown numbers', type: 'boolean' },
  ],
  credentials: whatsappCredentials,
  secretKeys: ['accessToken', 'appSecret'],
  webhook: { path: 'whatsapp', note: 'In the Meta app, set this as the webhook callback URL with your verify token and subscribe the WABA to the "messages" field.' },
  async test(raw) {
    const c = whatsappCredentials.parse(raw);
    const { res, body } = await providerFetch(`${graphBase()}/${V}/${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, { headers: { Authorization: `Bearer ${c.accessToken}` } });
    if (!res.ok) throw providerError(res, body, 'Meta rejected the token or phone number id');
    return `Connected to ${body.display_phone_number ?? c.phoneNumberId}${body.verified_name ? ` (${body.verified_name})` : ''}${body.quality_rating ? `, quality ${body.quality_rating}` : ''}`;
  },
};

export type OutboundWa = { type: 'text'; body: string } | { type: 'template'; name: string; language: string; params: string[] };

/** Sends one message. Templates work any time; free text only inside the 24-hour customer-service window (enforced by the caller). */
export async function sendWhatsapp(c: WhatsappCreds, to: string, m: OutboundWa): Promise<{ id: string }> {
  const payload = m.type === 'text'
    ? { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: m.body } }
    : { messaging_product: 'whatsapp', to, type: 'template', template: { name: m.name, language: { code: m.language }, ...(m.params.length ? { components: [{ type: 'body', parameters: m.params.map((p) => ({ type: 'text', text: p })) }] } : {}) } };
  const { res, body } = await providerFetch(`${graphBase()}/${V}/${encodeURIComponent(c.phoneNumberId)}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw providerError(res, body, 'WhatsApp did not accept the message');
  return { id: String(body?.messages?.[0]?.id ?? '') };
}

export type GraphTemplate = { name: string; language: string; status: string; category: string; components: { type: string; text?: string; format?: string }[] };

export async function fetchTemplates(c: WhatsappCreds): Promise<GraphTemplate[]> {
  const out: GraphTemplate[] = [];
  let url: string | null = `${graphBase()}/${V}/${encodeURIComponent(c.wabaId)}/message_templates?fields=name,language,status,category,components&limit=200`;
  while (url) {
    const { res, body } = await providerFetch(url, { headers: { Authorization: `Bearer ${c.accessToken}` } });
    if (!res.ok) throw providerError(res, body, 'Could not read the message templates');
    out.push(...((body?.data ?? []) as GraphTemplate[]));
    url = body?.paging?.next ?? null;
  }
  return out;
}

/** Meta signs webhook posts with `sha256=<hmac of raw body under app secret>`. */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header.slice(7));
  return a.length === b.length && timingSafeEqual(a, b);
}
