import { z } from 'zod';
import { ProviderDef, basicAuth, providerError, providerFetch } from './index';

export const exotelCredentials = z.object({
  accountSid: z.string().trim().min(1, 'Enter the account SID'),
  apiKey: z.string().trim().min(1, 'Enter the API key'),
  apiToken: z.string().min(1, 'Enter the API token'),
  subdomain: z.enum(['api.exotel.com', 'api.in.exotel.com', 'ccm-api.exotel.com']).default('api.exotel.com'),
  callerId: z.string().trim().min(5, 'Enter your ExoPhone number'),
  record: z.coerce.boolean().default(true),
});
export type ExotelCreds = z.infer<typeof exotelCredentials>;
/** Tests point this at a stub; production uses the chosen Exotel region. */
export const exotelBase = (c: ExotelCreds) => (process.env.EXOTEL_API_BASE ?? `https://${c.subdomain}`).replace(/\/$/, '');

export const exotel: ProviderDef = {
  key: 'exotel',
  name: 'Exotel',
  category: 'telephony',
  auth: 'credentials',
  description: 'Click-to-call from a lead: Exotel rings the agent\'s phone, then the lead; the call is logged with duration and recording automatically. Incoming calls on your ExoPhone are logged too.',
  needs: 'An Exotel account with an ExoPhone number. From the Exotel dashboard: Account SID, API key, API token and the region (Singapore api.exotel.com or Mumbai api.in.exotel.com). Each agent needs their phone number on their profile.',
  credentialSchema: [
    { key: 'accountSid', label: 'Account SID', type: 'text' },
    { key: 'apiKey', label: 'API key', type: 'text' },
    { key: 'apiToken', label: 'API token', type: 'password' },
    { key: 'subdomain', label: 'Region', type: 'select', options: [{ value: 'api.exotel.com', label: 'Singapore (api.exotel.com)' }, { value: 'api.in.exotel.com', label: 'Mumbai (api.in.exotel.com)' }, { value: 'ccm-api.exotel.com', label: 'CCM (ccm-api.exotel.com)' }] },
    { key: 'callerId', label: 'ExoPhone (caller id)', type: 'text', placeholder: '0XXXXXXXXXX' },
    { key: 'record', label: 'Record calls', type: 'boolean', help: 'Recording calls is subject to your local law and must be disclosed to callers' },
  ],
  credentials: exotelCredentials,
  secretKeys: ['apiToken'],
  webhook: { path: 'exotel', note: 'Set this URL as the StatusCallback for calls (done automatically for click-to-call) and as the passthru URL in your incoming-call flow to log incoming calls.' },
  async test(raw) {
    const c = exotelCredentials.parse(raw);
    const { res, body } = await providerFetch(`${exotelBase(c)}/v1/Accounts/${encodeURIComponent(c.accountSid)}.json`, { headers: { Authorization: basicAuth(c.apiKey, c.apiToken) } });
    if (!res.ok) throw providerError(res, body, 'Exotel rejected the credentials');
    return `Connected to account ${body?.Account?.FriendlyName ?? c.accountSid}`;
  },
};

/** Starts an outbound call: Exotel rings `agentPhone` first, then connects `leadPhone`. */
export async function connectCall(c: ExotelCreds, input: { agentPhone: string; leadPhone: string; statusCallback: string; customField: string }) {
  const form = new URLSearchParams({ From: input.agentPhone, To: input.leadPhone, CallerId: c.callerId, StatusCallback: input.statusCallback, StatusCallbackEvents: 'terminal', StatusCallbackContentType: 'application/json', CustomField: input.customField, Record: c.record ? 'true' : 'false' });
  const { res, body } = await providerFetch(`${exotelBase(c)}/v1/Accounts/${encodeURIComponent(c.accountSid)}/Calls/connect.json`, { method: 'POST', headers: { Authorization: basicAuth(c.apiKey, c.apiToken), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  if (!res.ok) throw providerError(res, body, 'Exotel could not start the call');
  return { sid: String(body?.Call?.Sid ?? ''), status: String(body?.Call?.Status ?? 'queued') };
}

/** Exotel's terminal call statuses mapped to the CRM's. */
export function mapExotelStatus(status: string | undefined): 'COMPLETED' | 'NO_ANSWER' | 'BUSY' | 'FAILED' | 'CANCELLED' {
  switch ((status ?? '').toLowerCase()) {
    case 'completed': return 'COMPLETED';
    case 'no-answer': return 'NO_ANSWER';
    case 'busy': return 'BUSY';
    case 'canceled': case 'cancelled': return 'CANCELLED';
    default: return 'FAILED';
  }
}
