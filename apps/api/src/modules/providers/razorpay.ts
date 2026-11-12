import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { ProviderDef, basicAuth, providerError, providerFetch } from './index';

export const razorpayBase = () => (process.env.RAZORPAY_API_BASE ?? 'https://api.razorpay.com').replace(/\/$/, '');

export const razorpayCredentials = z.object({
  keyId: z.string().trim().min(1, 'Enter the key id'),
  keySecret: z.string().min(1, 'Enter the key secret'),
  webhookSecret: z.string().min(1, 'Enter the webhook secret'),
});
export type RazorpayCreds = z.infer<typeof razorpayCredentials>;

export const razorpay: ProviderDef = {
  key: 'razorpay',
  name: 'Razorpay',
  category: 'payments',
  auth: 'credentials',
  description: 'Create payment links for expected payments and mark them received automatically when the customer pays.',
  needs: 'A Razorpay account: API key id and secret (Settings → API Keys) and a webhook (Settings → Webhooks) pointing at the URL shown after connecting, with the events payment_link.paid and payment.failed.',
  credentialSchema: [
    { key: 'keyId', label: 'Key id', type: 'text', placeholder: 'rzp_live_…' },
    { key: 'keySecret', label: 'Key secret', type: 'password' },
    { key: 'webhookSecret', label: 'Webhook secret', type: 'password', help: 'The secret you set when creating the webhook in Razorpay' },
  ],
  credentials: razorpayCredentials,
  secretKeys: ['keySecret', 'webhookSecret'],
  webhook: { path: 'razorpay', note: 'Add this URL as a webhook in Razorpay with the events payment_link.paid and payment.failed.' },
  async test(raw) {
    const c = razorpayCredentials.parse(raw);
    const { res, body } = await providerFetch(`${razorpayBase()}/v1/payments?count=1`, { headers: { Authorization: basicAuth(c.keyId, c.keySecret) } });
    if (!res.ok) throw providerError(res, body, 'Razorpay rejected the key');
    return `Connected with key ${c.keyId.slice(0, 12)}… (${c.keyId.startsWith('rzp_test') ? 'test mode' : 'live mode'})`;
  },
};

/** Creates a payment link. Amount is in the organisation currency's main unit; Razorpay wants the smallest unit. */
export async function createPaymentLink(c: RazorpayCreds, input: { amount: number; currency: string; description: string; reference: string; customer: { name: string; contact?: string | null; email?: string | null }; notes: Record<string, string>; callbackUrl?: string | null }) {
  const payload = {
    amount: Math.round(input.amount * 100),
    currency: input.currency,
    accept_partial: false,
    description: input.description.slice(0, 200),
    reference_id: input.reference.slice(0, 40),
    customer: { name: input.customer.name.slice(0, 100), ...(input.customer.contact ? { contact: input.customer.contact } : {}), ...(input.customer.email ? { email: input.customer.email } : {}) },
    notify: { sms: !!input.customer.contact, email: !!input.customer.email },
    reminder_enable: true,
    notes: input.notes,
    ...(input.callbackUrl ? { callback_url: input.callbackUrl, callback_method: 'get' } : {}),
  };
  const { res, body } = await providerFetch(`${razorpayBase()}/v1/payment_links`, { method: 'POST', headers: { Authorization: basicAuth(c.keyId, c.keySecret), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw providerError(res, body, 'Razorpay could not create the payment link');
  return { id: String(body.id), url: String(body.short_url), status: String(body.status) };
}

/** Razorpay signs webhooks with HMAC-SHA256 of the raw body under the webhook secret. */
export function verifyRazorpayWebhook(rawBody: Buffer | string, signature: string | undefined, webhookSecret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
